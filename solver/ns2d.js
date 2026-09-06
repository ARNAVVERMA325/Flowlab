// 2D incompressible Navier-Stokes solver.
//
// Method: Chorin projection (fractional step) on a MAC staggered grid.
//   1. Compute intermediate velocities F, G from advection (central
//      differencing, finite-volume flux form) + diffusion (mu * grad^2 u).
//   2. Solve the pressure Poisson equation grad^2 p = (rho/dt) * div(F,G).
//   3. Correct: u = F - (dt/rho) dp/dx,  v = G - (dt/rho) dp/dy.
//
// This module only depends on plain arrays shaped like geometry/grid.js's
// StaggeredGrid (nx, ny, h, stride, u, v, p, solid, maskVersion) - no import
// of that class is needed, and nothing here imports UI or rendering code.
//
// Boundary conditions are not a general pluggable framework (that is M4's
// job) - just a small descriptor consumed directly:
//
//   bc = { left, right, top, bottom }
//
// where each side is one of:
//   { type: "wall", u?, v? }  no-slip. Optionally a moving wall with a
//                             prescribed tangential velocity: u for the
//                             top/bottom walls, v for left/right. Default 0.
//   { type: "freeSlip" }      normal = 0, tangential gradient = 0
//   { type: "inflow", u, v }  prescribed velocity (Dirichlet)
//   { type: "zeroGradient" }  open end: normal and tangential gradients = 0
//   { type: "outflow" }       zeroGradient plus a global flux correction
//
// left/right control the u (normal) component and reflect/prescribe v
// (tangential) at that edge; top/bottom control v (normal) and
// reflect/prescribe u (tangential).
//
// On zeroGradient vs outflow: the pressure Poisson equation here always uses
// Neumann pressure boundaries, which is solvable only if the net mass flux
// through the boundary is zero. zeroGradient does not enforce that, so it is
// only appropriate where the flow leaves as cleanly as it enters (a
// unidirectional shear flow). outflow rescales the outgoing faces so total
// outflow matches total inflow, which is what makes a uniform inlet usable
// with a developed outlet.
//
// Obstacles are given by the cell-centred grid.solid mask. A face between
// two solid cells lies inside the body; a face between a solid and a fluid
// cell lies exactly on the body surface. See applySolidBoundaryConditions.

import { compileBoundaryConditions, planMatchesGrid } from "../boundaries/compile.js";
import { fluidRegions } from "../geometry/regions.js";
import { sourcePlanFor } from "../sources/compile.js";
import { SourceSpecError } from "../sources/kinds.js";
import { assertTimestepIsStable, peakCellSpeed, SolverStabilityError } from "./stability.js";

// A geometry the solver cannot satisfy, as opposed to one it merely finds
// hard. Separate from SolverDivergenceError because the remedy is different:
// a divergence failure asks for more iterations or a looser bound, while this
// one asks the user to change what they drew.
export class SolverGeometryError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "SolverGeometryError";
    Object.assign(this, detail);
  }
}

// Raised when the projection cannot deliver the incompressibility it was asked
// for. Distinct from SolverStabilityError: that one is about the scheme coming
// apart, this one is about the continuity constraint not being met.
export class SolverDivergenceError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "SolverDivergenceError";
    Object.assign(this, detail);
  }
}

function idxFor(grid) {
  const { stride } = grid;
  return (i, j) => i + stride * j;
}

// Where each side's velocity components live on the staggered grid.
//
// This table is the whole reason the four per-side branches could be collapsed
// into one implementation. They were duplicated because the index arithmetic
// differs per side in a way that is genuinely asymmetric, and writing it out
// four times was the only way to keep it straight:
//
//   left    normal u at ghost face i=0,    tangential v ghost at i=0,    from i=1
//   right   normal u at face      i=nx,    tangential v ghost at i=nx+1, from i=nx
//   bottom  normal v at ghost face j=0,    tangential u ghost at j=0,    from j=1
//   top     normal v at face      j=ny,    tangential u ghost at j=ny+1, from j=ny
//
// Note the asymmetry: on the left and bottom the normal component sits at the
// ghost index, while on the right and top it sits at the last real face and it
// is only the TANGENTIAL ghost that lies outside. Confusing the two puts a
// wall half a cell out of place, which still produces a plausible-looking
// flow. tests/fixtures/golden-fields.json is what catches that.
function sideFaces(grid, side) {
  const { nx, ny, stride } = grid;
  switch (side) {
    case "left":
      return {
        count: ny + 2, normal: "u", tangential: "v",
        normalIndex: (j) => stride * j,
        normalInterior: (j) => 1 + stride * j,
        tangentialGhost: (j) => stride * j,
        tangentialInterior: (j) => 1 + stride * j,
      };
    case "right":
      return {
        count: ny + 2, normal: "u", tangential: "v",
        normalIndex: (j) => nx + stride * j,
        normalInterior: (j) => nx - 1 + stride * j,
        tangentialGhost: (j) => nx + 1 + stride * j,
        tangentialInterior: (j) => nx + stride * j,
      };
    case "bottom":
      return {
        count: nx + 2, normal: "v", tangential: "u",
        normalIndex: (i) => i,
        normalInterior: (i) => i + stride,
        tangentialGhost: (i) => i,
        tangentialInterior: (i) => i + stride,
      };
    case "top":
      return {
        count: nx + 2, normal: "v", tangential: "u",
        normalIndex: (i) => i + stride * ny,
        normalInterior: (i) => i + stride * (ny - 1),
        tangentialGhost: (i) => i + stride * (ny + 1),
        tangentialInterior: (i) => i + stride * ny,
      };
    default:
      throw new Error(`unknown side: ${side}`);
  }
}

// Compiled plans, cached against the specification object they came from.
// Scenarios hand the same object in every step, so this compiles once per run.
const planCache = new WeakMap();

export function boundaryPlanFor(grid, bc) {
  // An already-compiled plan passes straight through, so a caller that wants to
  // inspect what is applied where can compile once and hand the plan back in.
  if (bc?.faces && bc?.conditions) {
    if (!planMatchesGrid(bc, grid)) {
      throw new Error(
        `this boundary plan was compiled for a ${bc.nx}x${bc.ny} grid, not ${grid.nx}x${grid.ny}`
      );
    }
    return bc;
  }
  const cached = planCache.get(bc);
  if (cached && planMatchesGrid(cached, grid)) return cached;
  const plan = compileBoundaryConditions(grid, bc);
  planCache.set(bc, plan);
  return plan;
}

// One side's ghost values, for any condition on any face of it.
//
// Every type reduces to a choice of two values - what the normal component
// becomes, and what the tangential ghost becomes - expressed against the index
// table above. Written once here instead of four times:
//
//   wall          normal 0,               tangential reflected about the wall
//                                         value, so the wall speed sits exactly
//                                         on the boundary rather than half a
//                                         cell off it
//   freeSlip      normal 0,               tangential copied (no shear)
//   inflow        normal prescribed,      tangential copied
//   flowInlet     normal from the compiled profile, tangential copied
//   outflow       normal copied,          tangential copied
//   zeroGradient  normal copied,          tangential copied
//
// outflow and zeroGradient are identical here and differ only in whether the
// global flux balance rescales them.
function applySideBoundary(grid, plan, side, u, v) {
  const faces = sideFaces(grid, side);
  const indices = plan.faces[side];
  const { conditions } = plan;
  const profile = plan.profiles[side];
  const normal = faces.normal === "u" ? u : v;
  const tangential = faces.tangential === "u" ? u : v;
  const tangentialKey = faces.tangential;
  const normalKey = faces.normal;

  for (let t = 0; t < faces.count; t++) {
    const condition = conditions[indices[t]];
    const normalAt = faces.normalIndex(t);
    const ghostAt = faces.tangentialGhost(t);
    const inside = tangential[faces.tangentialInterior(t)];

    switch (condition.type) {
      case "wall":
        normal[normalAt] = 0;
        tangential[ghostAt] = 2 * (condition[tangentialKey] ?? 0) - inside;
        break;
      case "freeSlip":
        normal[normalAt] = 0;
        tangential[ghostAt] = inside;
        break;
      case "inflow":
        normal[normalAt] = condition[normalKey];
        tangential[ghostAt] = inside;
        break;
      case "pressure":
        // A predictor only. The normal velocity here is a genuine degree of
        // freedom - the projection sets it from the pressure gradient in
        // correctVelocities - so this just needs a sane value for the
        // divergence that drives the solve.
        normal[normalAt] = normal[faces.normalInterior(t)];
        tangential[ghostAt] = inside;
        break;
      case "flowInlet":
        // The per-face velocity was worked out at compile time, where the open
        // length of the segment is known. Here it is just a lookup.
        normal[normalAt] = profile[t];
        tangential[ghostAt] = inside;
        break;
      case "outflow":
      case "zeroGradient":
        normal[normalAt] = normal[faces.normalInterior(t)];
        tangential[ghostAt] = inside;
        break;
      default:
        throw new Error(`Unknown ${side} BC type: ${condition.type}`);
    }
  }
}

export function applyVelocityBoundaryConditions(grid, bc, u, v, mass = null) {
  const plan = boundaryPlanFor(grid, bc);

  // The vertical sides must be done before the horizontal ones and this is not
  // cosmetic. The four corner ghosts are written by two sides each - u at
  // (0,0) is set by the left side at j=0 and again by the bottom side at i=0 -
  // so the second pass wins, and the bottom side reads u at (0,1), which the
  // left side has just written. Reordering these two loops changes the corner
  // values. Left/right and bottom/top within a pass touch disjoint indices, so
  // their order does not matter.
  applySideBoundary(grid, plan, "left", u, v);
  applySideBoundary(grid, plan, "right", u, v);
  applySideBoundary(grid, plan, "bottom", u, v);
  applySideBoundary(grid, plan, "top", u, v);

  applySolidBoundaryConditions(grid, u, v, plan.surfaces);
  return enforceFluxBalance(grid, plan, u, v, mass);
}

// No-slip on the surface of an obstacle.
//
// A face with exactly one solid neighbour cell lies on the body surface, and
// its velocity component is normal to that surface: it is set to zero, which
// is both no-penetration and half of no-slip.
//
// A face with two solid neighbours lies inside the body. Those faces are not
// degrees of freedom, but they are read by the stencils of the fluid faces
// one layer out, where they act as ghosts for the *tangential* no-slip
// condition. Setting them to zero would place the wall half a cell inside
// the body; reflecting the adjacent fluid value instead puts the zero
// exactly on the cell boundary where the surface actually is.
//
// Worth knowing: the reflection is the textbook-correct treatment, but at 8
// cells per diameter it moves the Re=40 wake length by only 0.8% against
// simply zeroing those faces. The test suite does not resolve that
// difference, so this choice rests on the argument above rather than on
// measurement.
export function applySolidBoundaryConditions(grid, u, v, surfaces = null) {
  const { nx, ny, solid } = grid;
  const idx = idxFor(grid);

  // What a surface face's normal component becomes. Without an attachment this
  // is zero - no-slip, as it always was - and the whole branch is skipped when
  // no surface conditions are declared, so every existing scenario takes the
  // identical path.
  const normalAt = (table, faceIndex, current, interior) => {
    if (surfaces === null) return 0;
    const index = table[faceIndex];
    if (index < 0) return 0;
    const attachment = surfaces.attachments.find((a) => a.index === index);
    const condition = attachment.condition;
    switch (condition.type) {
      case "wall":
      case "freeSlip":
        return 0;
      case "inflow":
        // Cartesian: the sign says which way along the axis, not whether it
        // enters. Same convention as every domain-edge condition.
        return condition[table === surfaces.u ? "u" : "v"];
      case "flowInlet":
        return attachment.faceVelocity;
      case "outflow":
      case "zeroGradient":
        return interior;
      case "pressure":
        // A predictor only; the projection sets this face from the pressure
        // gradient, exactly as it does on a domain edge.
        return interior;
      default:
        return 0;
    }
  };

  // Whether a surface adjacent to an in-body face lets the fluid slip along
  // it, and how fast that surface is moving tangentially. Looked up from the
  // PERPENDICULAR face's attachment: a u-face buried in the body is the
  // tangential ghost for the horizontal surface above or below it, which is a
  // v-face. Unambiguous because an attachment that prescribes anything must be
  // axis-aligned, so every face it covers agrees.
  const tangentialRule = (table, faceIndex) => {
    if (surfaces === null) return null;
    const index = table[faceIndex];
    if (index < 0) return null;
    const attachment = surfaces.attachments.find((a) => a.index === index);
    return attachment.condition;
  };

  for (let j = 1; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const a = solid[idx(i, j)];
      const b = solid[idx(i + 1, j)];
      if (!a && !b) continue;
      const k = idx(i, j);
      if (a !== b) {
        // On the surface: the normal component, from whatever condition is
        // attached here.
        u[k] = normalAt(surfaces?.u, k, u[k], a ? u[idx(i + 1, j)] : u[idx(i - 1, j)]);
        continue;
      }
      const fluidAbove = !solid[idx(i, j + 1)] && !solid[idx(i + 1, j + 1)];
      const fluidBelow = !solid[idx(i, j - 1)] && !solid[idx(i + 1, j - 1)];
      if (fluidAbove && !fluidBelow) {
        u[k] = reflectTangential(u[idx(i, j + 1)], tangentialRule(surfaces?.v, idx(i, j)) ?? tangentialRule(surfaces?.v, idx(i + 1, j)), "u");
      } else if (fluidBelow && !fluidAbove) {
        u[k] = reflectTangential(u[idx(i, j - 1)], tangentialRule(surfaces?.v, idx(i, j - 1)) ?? tangentialRule(surfaces?.v, idx(i + 1, j - 1)), "u");
      } else u[k] = 0;
    }
  }

  for (let i = 1; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const a = solid[idx(i, j)];
      const b = solid[idx(i, j + 1)];
      if (!a && !b) continue;
      const k = idx(i, j);
      if (a !== b) {
        v[k] = normalAt(surfaces?.v, k, v[k], a ? v[idx(i, j + 1)] : v[idx(i, j - 1)]);
        continue;
      }
      const fluidRight = !solid[idx(i + 1, j)] && !solid[idx(i + 1, j + 1)];
      const fluidLeft = !solid[idx(i - 1, j)] && !solid[idx(i - 1, j + 1)];
      if (fluidRight && !fluidLeft) {
        v[k] = reflectTangential(v[idx(i + 1, j)], tangentialRule(surfaces?.u, idx(i, j)) ?? tangentialRule(surfaces?.u, idx(i, j + 1)), "v");
      } else if (fluidLeft && !fluidRight) {
        v[k] = reflectTangential(v[idx(i - 1, j)], tangentialRule(surfaces?.u, idx(i - 1, j)) ?? tangentialRule(surfaces?.u, idx(i - 1, j + 1)), "v");
      } else v[k] = 0;
    }
  }
}

// The tangential ghost just inside a body.
//
// With no attachment, or a stationary wall, this is the reflection that has
// always been here: it places zero exactly on the cell boundary where the
// surface is, rather than half a cell inside the body. A moving wall reflects
// about its own speed instead, and free slip copies the value out, which is
// what "no shear" means.
function reflectTangential(neighbour, condition, component) {
  if (condition === null || condition === undefined) return -neighbour;
  if (condition.type === "freeSlip") return neighbour;
  if (condition.type === "wall") return 2 * (condition[component] ?? 0) - neighbour;
  return -neighbour;
}

// Rescales faces on "outflow" sides so outflow matches inflow, PER CONNECTED
// FLUID REGION.
//
// Without this the pure-Neumann pressure problem is not solvable: a uniform
// inlet paired with a zero-gradient outlet does not conserve mass on its own,
// and the projection has no way to fix an imbalance.
//
// Per region rather than globally, which is the one thing the solver turned
// out to depend on when a drawn wall can split the domain. The two are
// identical while there is one region, which is why this was invisible until
// M5. With two, a single uniform correction cannot satisfy both: a channel
// split into an upper half fed at u = 2 and a lower half fed at u = 1, with an
// outlet on each, balances globally and is impossible in each half. Measured
// before this change, that geometry threw at step one with the pressure at
// 9.7e16; after it, it runs at a divergence of 8.6e-8.
//
// What this does NOT do is fix a region with inflow and no outlet at all -
// there is nothing to rescale. That case is detected here and reported to
// step(), which rejects it by name rather than letting it surface as an
// unexplained divergence failure.
//
// The accumulation order is unchanged from the global version. `net` was a
// running float sum and still is, one per region, visiting faces in the same
// order; faces adjacent to solid carry exactly zero velocity and so
// contribute nothing whether they are summed or skipped.
function enforceFluxBalance(grid, plan, u, v, mass = null) {
  const { nx, ny, h, solid } = grid;
  const idx = idxFor(grid);
  const { label, count: regionCount, cellCounts } = fluidRegions(grid);
  // With segments, "is this an outflow" is a property of a face rather than of
  // a whole side, so the test is per face. The traversal and accumulation
  // order below is unchanged from the per-side version: `net` is a running
  // floating-point sum, and reordering it would move the last bits of every
  // rescaled face for reasons that have nothing to do with physics.
  const { outflowMask } = plan;
  const isOutflow = { left: plan.faces.left, right: plan.faces.right,
                      bottom: plan.faces.bottom, top: plan.faces.top };

  // Net flux counted positive *into* the domain, per region.
  const nets = new Float64Array(regionCount);

  // Interior mass sources count too, and this is the sixth instance of the bug
  // shape in working agreement item 8.
  //
  // Every other contribution below crosses a boundary face - a domain side or a
  // drawn surface - so the accumulation was written as a walk over boundary
  // faces. A mass source adds volume in the MIDDLE of a region and crosses
  // nothing, so it contributed zero and the outflow correction came out short
  // by exactly the source rate. Measured: a source of 0.05 in a box with an
  // outlet, which is a perfectly solvable configuration, left every region
  // carrying a forced divergence of 5.000e-2 and was rejected as unsolvable.
  // With this loop it reads 1.645e-17 and runs.
  //
  // The filter was "is this a boundary face". The property is "does this region
  // gain or lose volume".
  if (mass !== null) {
    const h2 = h * h;
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const k = idx(i, j);
        if (solid[k]) continue;
        const row = mass.cells[k];
        if (row < 0) continue;
        const region = label[k];
        if (region < 0) continue;
        nets[region] += mass.table[row].q * h2;
      }
    }
  }
  const outflowCounts = new Int32Array(regionCount);
  // A region touching a prescribed-pressure boundary determines its own flux
  // through it, so it is never "unbalanceable" in the sense the rejection
  // below means. Without this a pressure-driven region whose predictor happens
  // not to balance would be refused for a geometry that is perfectly sound.
  const freeBoundary = new Uint8Array(regionCount);
  const faces = [];

  for (let j = 1; j <= ny; j++) {
    const kL = idx(0, j);
    const kR = idx(nx, j);
    const rL = label[idx(1, j)];
    const rR = label[idx(nx, j)];
    if (rL >= 0) nets[rL] += u[kL] * h;
    if (rR >= 0) nets[rR] -= u[kR] * h;
    if (plan.pressureMask[plan.faces.left[j]] && !solid[idx(1, j)]) freeBoundary[label[idx(1, j)]] = 1;
    if (plan.pressureMask[plan.faces.right[j]] && !solid[idx(nx, j)]) freeBoundary[label[idx(nx, j)]] = 1;
    if (outflowMask[isOutflow.left[j]] && !solid[idx(1, j)]) {
      const region = label[idx(1, j)];
      outflowCounts[region] += 1;
      faces.push({ arr: u, k: kL, sign: 1, region });
    }
    if (outflowMask[isOutflow.right[j]] && !solid[idx(nx, j)]) {
      const region = label[idx(nx, j)];
      outflowCounts[region] += 1;
      faces.push({ arr: u, k: kR, sign: -1, region });
    }
  }
  for (let i = 1; i <= nx; i++) {
    const kB = idx(i, 0);
    const kT = idx(i, ny);
    const rB = label[idx(i, 1)];
    const rT = label[idx(i, ny)];
    if (rB >= 0) nets[rB] += v[kB] * h;
    if (rT >= 0) nets[rT] -= v[kT] * h;
    if (plan.pressureMask[plan.faces.bottom[i]] && !solid[idx(i, 1)]) freeBoundary[label[idx(i, 1)]] = 1;
    if (plan.pressureMask[plan.faces.top[i]] && !solid[idx(i, ny)]) freeBoundary[label[idx(i, ny)]] = 1;
    if (outflowMask[isOutflow.bottom[i]] && !solid[idx(i, 1)]) {
      const region = label[idx(i, 1)];
      outflowCounts[region] += 1;
      faces.push({ arr: v, k: kB, sign: 1, region });
    }
    if (outflowMask[isOutflow.top[i]] && !solid[idx(i, ny)]) {
      const region = label[idx(i, ny)];
      outflowCounts[region] += 1;
      faces.push({ arr: v, k: kT, sign: -1, region });
    }
  }

  // The correction is applied ALONG each face's outward normal: a face carries
  // sign*delta, not delta.
  //
  // This matters wherever a region has outlets on sides facing different ways.
  // The influx through a face is sign*value*h, so adding a flat delta to every
  // face changes the net by delta*h*sum(sign) - which is zero when the signs
  // cancel, and the rescale then does nothing at all. Adding sign*delta
  // instead changes it by delta*h*sum(sign^2) = delta*h*count, which can never
  // be degenerate, and it is what "push harder out of every outlet" actually
  // means: increase u at a right-hand outlet, decrease v at a bottom one.
  //
  // Where every outlet of a region faces the same way the two forms are
  // identical - sign factors out - which is every validated scenario, and the
  // golden fields confirm it.
  // Surface faces take part in the same balance. EVERY attached face
  // contributes its influx, not only the outflow ones: a flow-rate inlet
  // drawn on a block injects mass into the region exactly as a domain inlet
  // does, and leaving it out of the net means nothing compensates for it.
  //
  // Measured when it was left out: a blowing face delivered its requested
  // 0.15 exactly, and the field it produced had a divergence of 5.3e-2
  // against a bound of 1e-7 - with nothing throwing, because the region did
  // have an outlet and the residual could not see the inconsistency. The same
  // blind spot as the two bugs step 3 turned up.
  //
  // Faces with no attachment are walls carrying exactly zero, so skipping them
  // is the same as summing them. Collected after the domain edges so the
  // accumulation order over those is untouched, and skipped entirely when no
  // surface conditions are declared.
  if (plan.surfaces !== null) {
    const { surfaces } = plan;
    const visit = (table, arr, k, solidSide, fluidCell) => {
      const index = table[k];
      if (index < 0) return;
      const region = label[fluidCell];
      if (region < 0) return;
      const condition = surfaces.conditions[index];
      // Fluid on the low side means the outward normal points along +axis, so
      // influx into the fluid is -value*h.
      const sign = solidSide ? 1 : -1;
      nets[region] += sign * arr[k] * h;
      if (condition.type === "outflow") {
        outflowCounts[region] += 1;
        faces.push({ arr, k, sign, region });
      } else if (condition.type === "pressure") {
        freeBoundary[region] = 1;
      }
    };
    for (let j = 1; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const k = idx(i, j);
        const a = solid[k];
        if (a === solid[idx(i + 1, j)]) continue;
        visit(surfaces.u, u, k, a, a ? idx(i + 1, j) : k);
      }
    }
    for (let i = 1; i <= nx; i++) {
      for (let j = 0; j <= ny; j++) {
        const k = idx(i, j);
        const a = solid[k];
        if (a === solid[idx(i, j + 1)]) continue;
        visit(surfaces.v, v, k, a, a ? idx(i, j + 1) : k);
      }
    }
  }

  const deltas = new Float64Array(regionCount);
  for (let r = 0; r < regionCount; r++) {
    if (outflowCounts[r] === 0) continue;
    deltas[r] = -nets[r] / (outflowCounts[r] * h);
  }
  for (const f of faces) f.arr[f.k] += f.sign * deltas[f.region];

  // A region carrying net flux with no outflow face to rescale cannot be made
  // divergence-free by any pressure field. Reported rather than thrown here,
  // so the decision about what is tolerable stays with step(), which knows the
  // divergence bound that was promised.
  // Whether each region CAN be balanced is no longer judged here. Counting
  // boundary faces means depending on having enumerated every kind of face
  // correctly, and that dependency is exactly what failed three times: an
  // outflow rescale that cancelled itself, a domain whose only openings took
  // no part in the balance, and a surface inflow left out of it. The question
  // is asked of the Poisson right-hand side instead, where the inconsistency
  // lands whatever produced it - see assertRegionsAreSolvable.
}

// Pressure: zero-gradient (Neumann) at every boundary, domain and obstacle
// alike. M0 never prescribes pressure, so this is the complete set. The
// Poisson solve does not read these ghost values (see the reduced-diagonal
// treatment below); they are maintained so the stored field is consistent
// for anything that reads it.
export function applyPressureBoundaryConditions(grid, bc) {
  const { nx, ny, p } = grid;
  const idx = idxFor(grid);
  const plan = bc === undefined ? null : boundaryPlanFor(grid, bc);

  // Without a pressure boundary this is exactly the previous zero-gradient
  // pass. With one, the prescribed value sits ON the boundary face, halfway
  // between the last cell and the ghost, so the ghost is reflected about it:
  // p_ghost = 2*p_boundary - p_interior. Setting the ghost to p_boundary
  // directly would place the condition half a cell outside the domain - the
  // same half-cell error as a mishandled moving wall, and just as invisible.
  const ghost = (index, interior, sideFaces, t) => {
    if (plan && plan.hasPressure) {
      const condition = plan.conditions[sideFaces[t]];
      if (condition.type === "pressure") {
        p[index] = 2 * condition.p - p[interior];
        return;
      }
    }
    p[index] = p[interior];
  };

  for (let j = 1; j <= ny; j++) {
    ghost(idx(0, j), idx(1, j), plan?.faces.left, j);
    ghost(idx(nx + 1, j), idx(nx, j), plan?.faces.right, j);
  }
  for (let i = 1; i <= nx; i++) {
    ghost(idx(i, 0), idx(i, 1), plan?.faces.bottom, i);
    ghost(idx(i, ny + 1), idx(i, ny), plan?.faces.top, i);
  }
}

export function applyBoundaryConditions(grid, bc) {
  applyVelocityBoundaryConditions(grid, bc, grid.u, grid.v);
  applyPressureBoundaryConditions(grid, bc);
}

// `sources` is a compiled source plan's `momentum` (or null). The relaxation it
// applies is added AFTER the `dt * (...)` bracket rather than folded into it as
// an acceleration, and that is deliberate.
//
// The source is defined by the velocity change it makes in one step,
// du = alpha * (target - u). Expressing that as a force means writing
// f = alpha * (target - u) / dt and then multiplying by dt again, and in
// floating point dt * (x / dt) is not x. Adding the increment directly is the
// same operator split evaluated without the round trip: the change is EXACTLY
// alpha * (target - u), so the bound the formulation exists for holds exactly
// rather than nearly.
//
// What that bound says, precisely: the SOURCE's contribution to this face
// cannot carry it past its target, so the source alone cannot leave the field
// faster than max(|u|, |target|). Advection and diffusion still contribute
// their own change, and the projection changes u again afterwards - those are
// what the ordinary CFL and diffusion limits are for. The point is that the
// source no longer adds an unbounded amount on top of them.
//
// When `sources` is null nothing here is evaluated and the arithmetic is the
// expression it has always been, which is what keeps the golden fields
// byte-identical.
function computeIntermediateVelocities(grid, nu, dt, fx, fy, F, G, sources = null) {
  const { nx, ny, h, u, v, solid } = grid;
  const idx = idxFor(grid);
  const h2 = h * h;
  const relaxU = sources === null ? null : sources.u;
  const relaxV = sources === null ? null : sources.v;
  const relaxTable = sources === null ? null : sources.table;

  // F at u-locations. Interior: i = 1..nx-1, j = 1..ny. Faces touching a
  // solid cell are not degrees of freedom and are set by the BC pass.
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx - 1; i++) {
      const k = idx(i, j);
      if (solid[k] || solid[idx(i + 1, j)]) continue;
      const uij = u[k];
      const d2udx2 = (u[idx(i + 1, j)] - 2 * uij + u[idx(i - 1, j)]) / h2;
      const d2udy2 = (u[idx(i, j + 1)] - 2 * uij + u[idx(i, j - 1)]) / h2;

      const ue = (uij + u[idx(i + 1, j)]) / 2;
      const uw = (u[idx(i - 1, j)] + uij) / 2;
      const du2dx = (ue * ue - uw * uw) / h;

      const un = (uij + u[idx(i, j + 1)]) / 2;
      const us = (u[idx(i, j - 1)] + uij) / 2;
      const vn = (v[idx(i, j)] + v[idx(i + 1, j)]) / 2;
      const vs = (v[idx(i, j - 1)] + v[idx(i + 1, j - 1)]) / 2;
      const duvdy = (un * vn - us * vs) / h;

      F[k] = uij + dt * (nu * (d2udx2 + d2udy2) - du2dx - duvdy + fx);

      if (relaxU !== null) {
        const row = relaxU[k];
        if (row >= 0) {
          const source = relaxTable[row];
          // alpha clamps at 1, so a relaxation time shorter than the timestep
          // means "reach the target this step" rather than overshooting past
          // it. The bound holds for any tau and any dt.
          const alpha = Math.min(1, dt / source.relaxationTime);
          F[k] += alpha * (source.u - uij);
        }
      }
    }
  }

  // G at v-locations. Interior: i = 1..nx, j = 1..ny-1.
  for (let i = 1; i <= nx; i++) {
    for (let j = 1; j <= ny - 1; j++) {
      const k = idx(i, j);
      if (solid[k] || solid[idx(i, j + 1)]) continue;
      const vij = v[k];
      const d2vdx2 = (v[idx(i + 1, j)] - 2 * vij + v[idx(i - 1, j)]) / h2;
      const d2vdy2 = (v[idx(i, j + 1)] - 2 * vij + v[idx(i, j - 1)]) / h2;

      const vn = (vij + v[idx(i, j + 1)]) / 2;
      const vs = (v[idx(i, j - 1)] + vij) / 2;
      const dv2dy = (vn * vn - vs * vs) / h;

      const ve = (vij + v[idx(i + 1, j)]) / 2;
      const vw = (v[idx(i - 1, j)] + vij) / 2;
      const ue = (u[idx(i, j)] + u[idx(i, j + 1)]) / 2;
      const uw = (u[idx(i - 1, j)] + u[idx(i - 1, j + 1)]) / 2;
      const duvdx = (ue * ve - uw * vw) / h;

      G[k] = vij + dt * (nu * (d2vdx2 + d2vdy2) - duvdx - dv2dy + fy);

      if (relaxV !== null) {
        const row = relaxV[k];
        if (row >= 0) {
          const source = relaxTable[row];
          const alpha = Math.min(1, dt / source.relaxationTime);
          G[k] += alpha * (source.v - vij);
        }
      }
    }
  }
}

// Also accumulates the right-hand side per connected region, which is how each
// region's solvability is judged - see assertRegionsAreSolvable.
function computeRHS(grid, F, G, dt, rho, rhs, cells, regionSums, mass = null) {
  const { nx, ny, h, solid } = grid;
  const idx = idxFor(grid);
  const { dirichletRHS } = cells;
  const { label } = fluidRegions(grid);
  const h2 = h * h;
  // A mass source makes the flow deliberately non-solenoidal: the equation
  // becomes laplacian(p) = (rho/dt) * (div u* - q), so q is subtracted from the
  // predictor's divergence here and the projection then delivers a field whose
  // divergence IS q at those cells rather than zero. Everything downstream that
  // asks "how close to zero is the divergence" has to ask a different question
  // once this is non-null - see computeContinuityError.
  const massCells = mass === null ? null : mass.cells;
  const massTable = mass === null ? null : mass.table;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = idx(i, j);
      if (solid[k]) { rhs[k] = 0; continue; }
      let div = (F[k] - F[idx(i - 1, j)]) / h + (G[k] - G[idx(i, j - 1)]) / h;
      if (massCells !== null) {
        const row = massCells[k];
        if (row >= 0) div -= massTable[row].q;
      }
      // The known 2*p_b/h^2 from each Dirichlet face - see scratchFor.
      rhs[k] = (rho / dt) * div - (dirichletRHS === null ? 0 : dirichletRHS[k] / h2);
      regionSums[label[k]] += rhs[k];
    }
  }
}

// Pressure Poisson solve: conjugate gradient.
//
// History, because the choice is only sensible in light of it. Jacobi was
// first: simplest possible, but O(N^2) iterations - 19,600 per timestep on a
// 64x64 cavity, about 3 hours for one steady-state run. That was replaced by
// red-black SOR, which is O(N) at the optimal relaxation factor but needs to
// be TOLD that factor, and the estimate for it was wrong everywhere:
//
//   geometry          measured optimum   formula gave    cost of the error
//   cavity 64x64      1.930              1.9065          1.70x more iterations
//   bend 84x84        1.970              1.9279          2.60x
//   cylinder 168x73   1.970              1.9633          1.14x
//
// Deriving the estimate properly does not rescue it. The formula in use came
// from the Dirichlet Jacobi spectral radius; for the Neumann problem here the
// slowest convergent mode is [cos(pi/N)+1]/2 rather than
// [cos(pi/nx)+cos(pi/ny)]/2, which is exactly why every estimate came in low.
// That correction is exact for the cavity (1.9329 vs 1.930 measured) and still
// 1.87x off for the bend, because a bounding box says nothing useful about an
// L-shaped channel whose slowest mode runs the length of the duct. No formula
// over the grid dimensions can fix that.
//
// CG needs no such parameter. The operator is the discrete Laplacian
// restricted to fluid cells: symmetric, negative semi-definite, with the
// constant as its only null direction. Measured against the tuning each
// scenario was actually using:
//
//   cavity            313 -> 193 iterations per step
//   bend              372 -> 232
//   cylinder          419 -> 321
//
// It also cannot be mis-tuned, which SOR emphatically can: omega = 1.99 on the
// cavity costs 1223 iterations against 184 at the optimum. Trading a small
// amount of best-case speed for the removal of a parameter that was wrong in
// every geometry tried is the point of the exercise.
//
// Neumann boundaries - domain walls and obstacle surfaces alike - are imposed
// by dropping the out-of-domain or solid neighbour and reducing the diagonal,
// which is algebraically identical to mirroring a ghost cell. Obstacles fall
// out for free: a solid neighbour is dropped exactly like a wall.
//
// The system is singular (defined up to an additive constant). The residual is
// projected to zero mean every iteration so roundoff cannot excite the null
// direction, and the result is zero-meaned at the end.
function solvePressurePoisson(grid, rhs, cells, { residualTol, maxIterations }) {
  const { h, p } = grid;
  const h2 = h * h;
  const { fluid, offsets, counts, work, singular } = cells;
  const n = fluid.length;
  const { r, d, Ad } = work;

  const applyA = (src, dst) => {
    for (let m = 0; m < n; m++) {
      const k = fluid[m];
      const c = counts[k];
      if (c === 0) { dst[k] = 0; continue; }
      let sum = 0;
      const base = k * 4;
      for (let q = 0; q < 4; q++) {
        const o = offsets[base + q];
        if (o !== 0) sum += src[k + o];
      }
      dst[k] = (sum - c * src[k]) / h2;
    }
  };

  // Only the pure-Neumann problem has a constant null space to remove. With a
  // prescribed pressure the solution is unique, and subtracting the mean would
  // be discarding part of the answer rather than a spurious mode.
  const projectToZeroMean = (a) => {
    if (!singular) return;
    let total = 0;
    for (let m = 0; m < n; m++) total += a[fluid[m]];
    const mean = total / n;
    for (let m = 0; m < n; m++) a[fluid[m]] -= mean;
  };

  const dot = (a, b) => {
    let total = 0;
    for (let m = 0; m < n; m++) { const k = fluid[m]; total += a[k] * b[k]; }
    return total;
  };

  // Non-finite entries are COUNTED, never folded into a maximum by comparison.
  // `v > mx` is false for NaN and would report a healthy residual on a field
  // that has already blown up; so would `!(v <= mx)`, which survives only if
  // the NaN happens to come last. See tests/regression_nonfinite_reporting.js.
  const maxAbs = (a) => {
    let mx = 0;
    let bad = 0;
    for (let m = 0; m < n; m++) {
      const v = Math.abs(a[fluid[m]]);
      if (!Number.isFinite(v)) { bad++; continue; }
      if (v > mx) mx = v;
    }
    return bad > 0 ? NaN : mx;
  };

  if (n === 0) return { iterations: 0, residual: 0, converged: true };

  applyA(p, Ad);
  for (let m = 0; m < n; m++) { const k = fluid[m]; r[k] = rhs[k] - Ad[k]; }
  projectToZeroMean(r);
  for (let m = 0; m < n; m++) d[fluid[m]] = r[fluid[m]];
  let rr = dot(r, r);

  let iterations = 0;
  let residual = maxAbs(r);
  let converged = Number.isFinite(residual) && residual < residualTol;

  while (!converged && iterations < maxIterations) {
    if (!Number.isFinite(residual)) break;
    applyA(d, Ad);
    const dAd = dot(d, Ad);
    if (!Number.isFinite(dAd) || dAd === 0) { residual = NaN; break; }

    const alpha = rr / dAd;
    for (let m = 0; m < n; m++) {
      const k = fluid[m];
      p[k] += alpha * d[k];
      r[k] -= alpha * Ad[k];
    }
    projectToZeroMean(r);

    const rrNext = dot(r, r);
    iterations++;
    residual = maxAbs(r);
    if (!Number.isFinite(residual)) break;
    if (residual < residualTol) { converged = true; break; }

    const beta = rrNext / rr;
    for (let m = 0; m < n; m++) { const k = fluid[m]; d[k] = r[k] + beta * d[k]; }
    rr = rrNext;
  }

  projectToZeroMean(p);

  return { iterations, residual, converged };
}

// The projected velocity is the intermediate field everywhere, minus the
// pressure gradient on exactly those faces the Poisson operator treated as
// degrees of freedom.
//
// The whole of F,G is copied across first, rather than only the corrected
// faces. F,G already satisfy the boundary and obstacle conditions, so this
// leaves u,v equal to the field whose divergence the pressure solve actually
// controlled. Re-deriving the boundary faces from u,v *after* this point
// would break that: an extrapolating outflow condition would recompute
// u[nx] from the just-corrected u[nx-1] and reintroduce divergence in the
// outlet column.
function correctVelocities(grid, F, G, dt, rho, plan) {
  const { nx, ny, h, u, v, p, solid } = grid;
  const idx = idxFor(grid);

  u.set(F);
  v.set(G);

  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx - 1; i++) {
      const k = idx(i, j);
      if (solid[k] || solid[idx(i + 1, j)]) continue;
      u[k] = F[k] - (dt / rho) * (p[idx(i + 1, j)] - p[k]) / h;
    }
  }
  for (let i = 1; i <= nx; i++) {
    for (let j = 1; j <= ny - 1; j++) {
      const k = idx(i, j);
      if (solid[k] || solid[idx(i, j + 1)]) continue;
      v[k] = G[k] - (dt / rho) * (p[idx(i, j + 1)] - p[k]) / h;
    }
  }

  // Boundary faces are normally prescribed, so the loops above skip them. A
  // pressure face is the exception: the velocity through it is unknown and the
  // pressure gradient across it is what sets it.
  //
  // The gradient uses the reflected ghost, p_g = 2*p_b - p_interior, so it
  // comes out as twice the difference between the boundary value and the
  // adjacent cell over h. That factor of two is not a fudge - it is the
  // half-cell between the last pressure node and the face where the condition
  // is imposed, and it is exactly what makes the divergence of the corrected
  // field equal the Laplacian assembled in scratchFor. The identity behind the
  // divergence check in step() depends on the two agreeing.
  if (!plan?.hasPressure && !plan?.surfaces?.hasSurfacePressure) return;
  const scale = (2 * dt) / (rho * h);

  // Pressure attached to a drawn surface. `a` says which side the solid sits
  // on, which flips the gradient's sign exactly as the left and right domain
  // edges differ from each other.
  if (plan?.surfaces?.hasSurfacePressure) {
    const { surfaces } = plan;
    const boundaryPressure = (table, k) => {
      const index = table[k];
      if (index < 0) return null;
      const condition = surfaces.conditions[index];
      return condition.type === "pressure" ? condition.p : null;
    };
    for (let j = 1; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const k = idx(i, j);
        const a = solid[k];
        if (a === solid[idx(i + 1, j)]) continue;
        const pb = boundaryPressure(surfaces.u, k);
        const fluidCell = a ? idx(i + 1, j) : k;
        if (pb === null || solid[fluidCell]) continue;
        u[k] = a ? F[k] - scale * (p[fluidCell] - pb) : F[k] - scale * (pb - p[fluidCell]);
      }
    }
    for (let i = 1; i <= nx; i++) {
      for (let j = 0; j <= ny; j++) {
        const k = idx(i, j);
        const a = solid[k];
        if (a === solid[idx(i, j + 1)]) continue;
        const pb = boundaryPressure(surfaces.v, k);
        const fluidCell = a ? idx(i, j + 1) : k;
        if (pb === null || solid[fluidCell]) continue;
        v[k] = a ? G[k] - scale * (p[fluidCell] - pb) : G[k] - scale * (pb - p[fluidCell]);
      }
    }
  }

  if (!plan?.hasPressure) return;
  for (let j = 1; j <= ny; j++) {
    if (plan.pressureMask[plan.faces.left[j]] && !solid[idx(1, j)]) {
      const k = idx(0, j);
      u[k] = F[k] - scale * (p[idx(1, j)] - plan.conditions[plan.faces.left[j]].p);
    }
    if (plan.pressureMask[plan.faces.right[j]] && !solid[idx(nx, j)]) {
      const k = idx(nx, j);
      u[k] = F[k] - scale * (plan.conditions[plan.faces.right[j]].p - p[idx(nx, j)]);
    }
  }
  for (let i = 1; i <= nx; i++) {
    if (plan.pressureMask[plan.faces.bottom[i]] && !solid[idx(i, 1)]) {
      const k = idx(i, 0);
      v[k] = G[k] - scale * (p[idx(i, 1)] - plan.conditions[plan.faces.bottom[i]].p);
    }
    if (plan.pressureMask[plan.faces.top[i]] && !solid[idx(i, ny)]) {
      const k = idx(i, ny);
      v[k] = G[k] - scale * (plan.conditions[plan.faces.top[i]].p - p[idx(i, ny)]);
    }
  }
}

// Per-grid scratch buffers and the precomputed fluid-cell topology, reused
// across timesteps. Kept out of StaggeredGrid so the geometry layer stays
// free of solver internals. Rebuilt when the obstacle mask changes.
const scratchByGrid = new WeakMap();

function scratchFor(grid, plan) {
  let s = scratchByGrid.get(grid);
  if (
    s &&
    s.F.length === grid.u.length &&
    s.maskVersion === grid.maskVersion &&
    s.plan === plan
  ) {
    return s;
  }

  const size = grid.u.length;
  const { nx, ny, stride, solid } = grid;
  const idx = (i, j) => i + stride * j;

  // For each fluid cell, the offsets of its fluid neighbours (0 = dropped,
  // i.e. a domain boundary or an obstacle face, which are the same Neumann
  // condition) and how many there are.
  const offsets = new Int32Array(size * 4);
  const counts = new Uint8Array(size);
  const fluid = [];
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = idx(i, j);
      if (solid[k]) continue;
      let n = 0;
      const base = k * 4;
      if (i > 1 && !solid[k - 1]) { offsets[base] = -1; n++; }
      if (i < nx && !solid[k + 1]) { offsets[base + 1] = 1; n++; }
      if (j > 1 && !solid[k - stride]) { offsets[base + 2] = -stride; n++; }
      if (j < ny && !solid[k + stride]) { offsets[base + 3] = stride; n++; }
      counts[k] = n;
      fluid.push(k);
    }
  }

  // Dirichlet pressure faces change the operator rather than sitting beside it.
  //
  // Eliminating the reflected ghost p_g = 2*p_b - p_k from the Laplacian turns
  // that direction's contribution from the dropped Neumann term (nothing) into
  //
  //     (p_g - p_k) = 2*p_b - 2*p_k
  //
  // so the cell's diagonal gains 2 and a known 2*p_b/h^2 moves to the
  // right-hand side. Folding the diagonal into `counts` keeps the inner loop
  // of applyA byte-for-byte what it was: with no pressure boundary, nothing
  // below executes and nothing downstream can tell the difference.
  let dirichletRHS = null;
  let dirichletRegions = null;
  const regionLabel = fluidRegions(grid).label;
  const regionCount = fluidRegions(grid).count;
  if (plan?.hasPressure) {
    dirichletRHS = new Float64Array(size);
    dirichletRegions ??= new Uint8Array(regionCount);
    const at = (faceConditions, faceIndex, cell) => {
      const condition = plan.conditions[faceConditions[faceIndex]];
      if (condition.type !== "pressure" || solid[cell]) return;
      counts[cell] += 2;
      dirichletRHS[cell] += 2 * condition.p;
      dirichletRegions[regionLabel[cell]] = 1;
    };
    for (let j = 1; j <= ny; j++) {
      at(plan.faces.left, j, idx(1, j));
      at(plan.faces.right, j, idx(nx, j));
    }
    for (let i = 1; i <= nx; i++) {
      at(plan.faces.bottom, i, idx(i, 1));
      at(plan.faces.top, i, idx(i, ny));
    }
  }

  // The same elimination for a pressure condition attached to a drawn surface.
  // The face lies between a fluid cell and a solid one, and the solid cell's
  // pressure slot plays the ghost, so the arithmetic is identical to a domain
  // edge - only the geometry differs.
  if (plan?.surfaces?.hasSurfacePressure) {
    dirichletRHS ??= new Float64Array(size);
    dirichletRegions ??= new Uint8Array(regionCount);
    const { surfaces } = plan;
    const attach = (table, k, fluidCell) => {
      const index = table[k];
      if (index < 0 || solid[fluidCell]) return;
      const condition = surfaces.conditions[index];
      if (condition.type !== "pressure") return;
      counts[fluidCell] += 2;
      dirichletRHS[fluidCell] += 2 * condition.p;
      dirichletRegions[regionLabel[fluidCell]] = 1;
    };
    for (let j = 1; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const k = idx(i, j);
        const a = solid[k];
        if (a === solid[idx(i + 1, j)]) continue;
        attach(surfaces.u, k, a ? idx(i + 1, j) : k);
      }
    }
    for (let i = 1; i <= nx; i++) {
      for (let j = 0; j <= ny; j++) {
        const k = idx(i, j);
        const a = solid[k];
        if (a === solid[idx(i, j + 1)]) continue;
        attach(surfaces.v, k, a ? idx(i, j + 1) : k);
      }
    }
  }

  s = {
    F: new Float64Array(size),
    G: new Float64Array(size),
    rhs: new Float64Array(size),
    maskVersion: grid.maskVersion,
    plan,
    cells: {
      fluid: Int32Array.from(fluid),
      offsets,
      counts,
      dirichletRHS,
      dirichletRegions,
      // With a prescribed pressure anywhere the constant null space is gone,
      // and projecting it out would remove a component the boundary condition
      // legitimately fixes.
      singular: !plan?.hasPressure && !plan?.surfaces?.hasSurfacePressure,
      // CG work vectors, allocated once per grid rather than per timestep.
      work: {
        r: new Float64Array(size),
        d: new Float64Array(size),
        Ad: new Float64Array(size),
      },
    },
  };
  scratchByGrid.set(grid, s);
  return s;
}

// Advance the grid state by one timestep. Mutates grid.u, grid.v, grid.p.
//
// divergenceTol is the knob for how hard the pressure solve works, expressed
// in the units that actually matter. After the correction step the remaining
// velocity divergence is exactly -(dt/rho) * (Poisson residual), so a
// residual tolerance of divergenceTol*rho/dt bounds the divergence of the
// field this step produces.
// Is each region's pressure problem solvable at all?
//
// Measured where the inconsistency actually lands rather than by enumerating
// boundary faces, and that distinction is the point.
//
// Every row of the pure-Neumann operator sums to zero, so sum(A p) = 0 for any
// p, so sum(residual) === sum(rhs) at every iteration - unchanged, whatever
// caused it. If that sum is not zero the region has NO solution: no pressure
// field makes it divergence-free. And the zero-mean projection is precisely
// what strips that component out of the reported residual, which is why an
// unsolvable region used to converge to a healthy-looking number while sitting
// on a field whose divergence was orders of magnitude worse.
//
// Three bugs of that shape were found before this existed - an outflow rescale
// that cancelled itself, a domain whose only openings took no part in the
// balance, and a surface inflow left out of it. Each was fixed at its own site
// and each was found by accident. This catches the class rather than the
// instances: measured on the surface-inflow bug, the figure below was 5.28e-2
// against an actual divergence of 5.28e-2, while every healthy configuration
// sits at 1e-17.
//
// Regions carrying a prescribed pressure are exempt: their operator is not
// singular, every right-hand side is solvable, and the row-sum identity this
// rests on does not hold for them.
function assertRegionsAreSolvable(cells, regions, regionSums, dt, rho, divergenceTol) {
  const { dirichletRegions } = cells;
  const unsolvable = [];
  for (let r = 0; r < regions.count; r++) {
    if (dirichletRegions !== null && dirichletRegions !== undefined && dirichletRegions[r]) continue;
    const cellCount = regions.cellCounts[r];
    if (cellCount === 0) continue;
    // The divergence this inconsistency forces, spread over the region.
    // Compared against the caller's own bound rather than an invented constant.
    const forcedDivergence = (Math.abs(regionSums[r]) * dt) / (rho * cellCount);
    if (forcedDivergence > divergenceTol) unsolvable.push({ region: r, cellCount, forcedDivergence });
  }
  if (unsolvable.length === 0) return;

  const worst = unsolvable.reduce((a, b) => (a.forcedDivergence > b.forcedDivergence ? a : b));
  throw new SolverGeometryError(
    `fluid region ${worst.region} (${worst.cellCount} cells) carries a net flux that nothing ` +
    `in it can absorb, so no pressure field can make it divergence-free. ` +
    `${unsolvable.length > 1 ? `${unsolvable.length} regions are in this state. ` : ""}` +
    `It would force a divergence of ${worst.forcedDivergence.toExponential(2)} against a bound ` +
    `of ${divergenceTol.toExponential(2)}. This is a geometry and boundary-condition problem ` +
    `rather than a solver one - most often a wall drawn across the domain separating an inlet ` +
    `from every outlet, or a domain whose only openings copy their velocity and take no part ` +
    `in the flux balance. Give the region an outlet or a pressure boundary, or remove the ` +
    `inflow feeding it.`,
    { reason: "unsolvable-region", regions: unsolvable }
  );
}

export function step(grid, bc, params) {
  const {
    nu,
    rho,
    dt,
    fx = 0,
    fy = 0,
    sources = null,
    divergenceTol = 1e-8,
    poissonMaxIterations = 5000,
  } = params;

  const plan = boundaryPlanFor(grid, bc);
  const sourcePlan = sourcePlanFor(grid, sources);

  const { F, G, rhs, cells } = scratchFor(grid, plan);

  // Reject a timestep this field cannot survive, before doing any work. If the
  // field arrived already non-finite this returns rather than throwing: step()
  // reports on what it was handed, and throws only for what it would itself
  // produce. The existing non-finite reporting path covers the former.
  const entryLimits = assertTimestepIsStable(grid, nu, dt);
  const enteredFinite = entryLimits.finite;

  applyBoundaryConditions(grid, bc);

  // Seed the whole intermediate field from the current velocity so that every
  // face the momentum update skips (boundary faces, and faces on or inside an
  // obstacle) still carries a meaningful value for the BC pass to work from.
  F.set(grid.u);
  G.set(grid.v);
  computeIntermediateVelocities(grid, nu, dt, fx, fy, F, G, sourcePlan.momentum);
  applyVelocityBoundaryConditions(grid, bc, F, G, sourcePlan.mass);


  const regions = fluidRegions(grid);
  const regionSums = new Float64Array(regions.count);
  computeRHS(grid, F, G, dt, rho, rhs, cells, regionSums, sourcePlan.mass);
  assertRegionsAreSolvable(cells, regions, regionSums, dt, rho, divergenceTol);
  const poisson = solvePressurePoisson(grid, rhs, cells, {
    residualTol: (divergenceTol * rho) / dt,
    maxIterations: poissonMaxIterations,
  });
  correctVelocities(grid, F, G, dt, rho, plan);

  // Only the pressure ghosts are refreshed here. The velocity boundary values
  // already came through F,G and must not be re-derived - see correctVelocities.
  applyPressureBoundaryConditions(grid, bc);

  // Backstop. The pre-step check is necessary but not sufficient: it bounds the
  // timestep against the field as it stands, and a sharp geometric corner can
  // still produce something non-finite within the step. If the field was sound
  // on entry and is not on exit, this step broke it and that is worth an
  // exception rather than a value nobody reads.
  if (enteredFinite) {
    const exit = peakCellSpeed(grid);
    if (!exit.finite) {
      throw new SolverStabilityError(
        `the velocity field became non-finite during this step: ${exit.nonFiniteCells} cells. ` +
        `The timestep passed the stability limits for the field at the start of the step, so ` +
        `this is a local blow-up rather than a global CFL violation - most often a singular ` +
        `corner or a badly resolved obstacle boundary.`,
        { reason: "became-non-finite", nonFiniteCells: exit.nonFiniteCells, dt }
      );
    }
  }

  // Divergence control: enforce the bound, do not merely report it.
  //
  // divergenceTol is stated as a promise about the field this step produces,
  // and until now it was only a target. A pressure solve that ran out of
  // iterations returned poissonConverged: false and step() carried on, so the
  // caller could receive a field whose divergence exceeded the requested bound
  // by five orders of magnitude with nothing but an easily ignored flag to say
  // so - measured at 9.0e-3 against a promised 1e-8. That is the same
  // ignorable-status pattern that produced the two non-finite reporting bugs.
  //
  // The check is free. After the correction the remaining divergence is exactly
  // -(dt/rho) times the Poisson residual, so the achieved value is already
  // known from the solve and needs no second pass over the field. The identity
  // itself is pinned by a test rather than trusted.
  // This is the CONTINUITY ERROR, not the divergence, and the distinction only
  // became visible with mass sources. The residual measures how far the solve
  // is from the equation it was given, and that equation targets div u = q -
  // so this is max|div u - q|, which is max|div u| exactly when q is zero
  // everywhere. Measured with a source running: 8.5702e-8 here against a raw
  // max|div u| of 1.8000e+0, and the identity holds against the former to
  // 1.21e-18.
  const achievedDivergence = (dt / rho) * poisson.residual;
  if (enteredFinite && achievedDivergence > divergenceTol) {
    throw new SolverDivergenceError(
      `the pressure solve could not meet the requested continuity bound: ` +
      `asked for ${divergenceTol.toExponential(2)}, achieved ` +
      `${achievedDivergence.toExponential(2)} after ${poisson.iterations} iterations ` +
      `(${(achievedDivergence / divergenceTol).toExponential(1)}x over). ` +
      `Raise poissonMaxIterations, or loosen divergenceTol if this accuracy is ` +
      `genuinely not needed.`,
      {
        reason: "divergence-bound",
        requested: divergenceTol,
        achieved: achievedDivergence,
        iterations: poisson.iterations,
        residual: poisson.residual,
      }
    );
  }

  return {
    poissonIterations: poisson.iterations,
    poissonResidual: poisson.residual,
    poissonConverged: poisson.converged,
    // How far the field this step produced is from the continuity it was asked
    // for, from the identity above. Named `continuityError` rather than
    // `divergence` because with a mass source running those are two different
    // numbers, and the one this is has always been the former.
    continuityError: achievedDivergence,
    // How much divergence the sources deliberately impose, and over how many
    // cells - zero and zero unless a mass source is active. Reported so a
    // reader of the raw divergence can tell an imposed value from a failure.
    imposedDivergence: sourcePlan.mass === null ? 0 : maxImposedDivergence(sourcePlan.mass),
    imposedCells: sourcePlan.mass === null ? 0 : countImposedCells(grid, sourcePlan.mass),
  };
}

function maxImposedDivergence(mass) {
  let worst = 0;
  for (const row of mass.table) worst = Math.max(worst, Math.abs(row.q));
  return worst;
}

function countImposedCells(grid, mass) {
  let n = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      if (!grid.solid[grid.idx(i, j)] && mass.cells[grid.idx(i, j)] >= 0) n++;
    }
  }
  return n;
}

// How far the field is from the continuity it was ASKED for: max and rms of
// |div u - q|, where q is whatever a mass source deliberately imposes.
//
// This exists as a second, differently named function rather than as an
// argument to computeDivergence, and the reason is the rule in working
// agreement item 8. `computeDivergence` returns the divergence. Making it
// return something else when handed an extra argument would be one name with
// two meanings depending on a call site's details - the same shape as the six
// bugs that rule is about, built in deliberately this time.
//
// The precedent is ui/fieldHealth.js, which keeps `inspection.maxSpeed` (the
// raw quantity the colour scale needs) separate from `reportedPeakSpeed` (the
// one the panel is allowed to show) for exactly this reason.
//
// The property that makes this cheap: with no mass source, q is zero
// everywhere and this is IDENTICAL to computeDivergence - not close, identical,
// because it is the same subtraction of the same numbers minus zero. So every
// existing test, harness and validation claim keeps its meaning untouched.
//
// This is also the quantity the M1 identity is about. div_k - q_k =
// -(dt/rho)*r_k holds per cell whether or not q is zero; it was only ever
// written as "divergence" because q had always been zero. Measured with a
// source running: this reads 8.5702e-8 against a raw max|div u| of 1.8000e+0,
// and agrees with (dt/rho)*residual to 1.21e-18.
export function computeContinuityError(grid, sources = null) {
  const mass = sources === null ? null : (sources.mass ?? null);
  if (mass === null) return computeDivergence(grid);

  const { nx, ny, h, u, v, solid } = grid;
  const idx = idxFor(grid);
  let max = 0;
  let sumSquares = 0;
  let cells = 0;
  let nonFiniteCells = 0;

  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = idx(i, j);
      if (solid[k]) continue;
      const row = mass.cells[k];
      const imposed = row >= 0 ? mass.table[row].q : 0;
      const value = Math.abs(
        (u[k] - u[idx(i - 1, j)]) / h + (v[k] - v[idx(i, j - 1)]) / h - imposed
      );
      // Same rule as computeDivergence: non-finite cells are COUNTED, never
      // folded into the maximum, because `a > max` is false for NaN and would
      // silently skip them.
      if (!Number.isFinite(value)) {
        nonFiniteCells++;
        continue;
      }
      cells++;
      if (value > max) max = value;
      sumSquares += value * value;
    }
  }

  // Exactly computeDivergence's shape. One branch of this function delegates to
  // it, so a field present in one and not the other would be undefined for
  // half the callers with nothing to say so.
  if (nonFiniteCells > 0) return { max: NaN, rms: NaN, nonFiniteCells };
  return { max, rms: cells > 0 ? Math.sqrt(sumSquares / cells) : 0, nonFiniteCells: 0 };
}

// Divergence of the velocity field at fluid cell centers.
//
// This is the ACTUAL divergence, always. Where a mass source is running it is
// meant to be non-zero there, and this reports that faithfully rather than
// hiding it - see computeContinuityError for the question "is the projection
// doing its job", which is a different question once q is non-zero.
export function computeDivergence(grid) {
  const { nx, ny, h, u, v, solid } = grid;
  const idx = idxFor(grid);

  // Non-finite cells are COUNTED, not folded into the maximum. `a > max` skips
  // NaN outright, so an all-NaN field reported max divergence of exactly zero
  // and looked perfectly incompressible. The negated form `!(a <= max)` is no
  // better: it survives only if the NaN happens to be the last value seen, and
  // any finite cell after it restores a healthy-looking number. Counting is
  // the only version of this that no ordering can defeat.
  let max = 0;
  let sumSq = 0;
  let count = 0;
  let nonFiniteCells = 0;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = idx(i, j);
      if (solid[k]) continue;
      const div = (u[k] - u[idx(i - 1, j)]) / h + (v[k] - v[idx(i, j - 1)]) / h;
      if (!Number.isFinite(div)) { nonFiniteCells++; continue; }
      const a = Math.abs(div);
      if (a > max) max = a;
      sumSq += div * div;
      count++;
    }
  }
  if (nonFiniteCells > 0) return { max: NaN, rms: NaN, nonFiniteCells };
  return { max, rms: count > 0 ? Math.sqrt(sumSq / count) : 0, nonFiniteCells: 0 };
}
