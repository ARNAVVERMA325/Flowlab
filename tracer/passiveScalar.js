// Passive scalar tracer - a visualization aid, not part of the fluid state.
//
// VISION 4.2 draws a hard line between what the simulation computes and what
// the display invents. Dye sits on the display side of that line: it is
// advected by the velocity field the solver produced, and it feeds nothing
// back. Deleting this directory must leave the solver bit-for-bit unchanged,
// and tests/test9_m3_visualization.js asserts exactly that rather than
// trusting the arrangement.
//
// Three rules keep the separation mechanical rather than a matter of care:
//
//   1. The concentration lives here, in this object's own array. It is NOT
//      stored on the grid. Hanging it off `grid` would make it part of the
//      fluid state object, and the next person to touch the solver would find
//      it sitting there looking like something the physics uses.
//   2. This module reads grid.u, grid.v and grid.solid and writes none of
//      them. Nothing in this file assigns to a grid field.
//   3. The tracer never influences the timestep. See advect() for why that
//      is the one coupling that would be easy to introduce by accident.
//
// ---------------------------------------------------------------------------
// NUMERICS
// ---------------------------------------------------------------------------
//
// The scalar satisfies pure advection, with no diffusion term:
//
//     dc/dt + u . grad c = 0
//
// discretised in conservative flux form on the same cells the pressure uses,
// using the MAC face velocities directly:
//
//     c[i,j] -= (dt/h) * ( Fx[i,j] - Fx[i-1,j] + Fy[i,j] - Fy[i,j-1] )
//     Fx[i,j] = u[i,j] * cFace     (donor cell plus a limited slope)
//
// Why not the solver's own scheme. The momentum equation is advected with
// explicit central differences and no upwinding, which is defensible there
// because physical viscosity damps the 2h mode. A tracer with zero diffusivity
// has no such damping, and forward-Euler central differencing applied to pure
// advection is UNCONDITIONALLY unstable - the von Neumann amplification factor
// exceeds one for every timestep, however small. Copying the surrounding code
// would produce a field that blows up regardless of dt.
//
// Why not first-order donor cell. It is monotone and about thirty lines, but
// its modified equation carries a numerical diffusivity |u|*h*(1-CFL)/2, which
// at the shipped scenario parameters is several times the physical viscosity
// (roughly 4.7x nu for the cavity, 2.5x nu for the cylinder). Dye would spread
// several times faster than momentum does and every thin filament would be
// gone within a few hundred steps: a picture that looks plausible and is wrong
// about the one thing dye exists to show. tests/test9 measures the difference
// against an exact solution rather than leaving that as an assertion.
//
// Why van Leer. It is TVD, so no new extrema: negative dye and dye brighter
// than what was injected are both visibly nonsense, and the limiter rules them
// out in 1D rather than merely discouraging them. It is also a drop-in - the
// limiter is a function, and returning zero from it recovers donor cell
// exactly, which is how the comparison test drives both schemes down the same
// code path.
//
// Two honest limits, carried in the tests rather than assumed away:
//
//   - TVD is a one-dimensional result. In 2D unsplit with forward Euler
//     boundedness is not proven, so the tests MEASURE the overshoot instead of
//     asserting c stays in [0,1].
//   - Truncation error still smears dye. This is less diffusive than donor
//     cell, not non-diffusive.

// Sweby-form van Leer limiter. psi(r) <= min(2r, 2) is what makes the scheme
// TVD under forward Euler; r <= 0 means a local extremum, where the limiter
// must drop the slope entirely and fall back to donor cell.
import { injectSourceDye } from "./sourceDye.js";

export function vanLeer(r) {
  if (!Number.isFinite(r) || r <= 0) return 0;
  return (r + Math.abs(r)) / (1 + Math.abs(r));
}

// Recovers first-order donor cell from the same code path, for the comparison
// in tests/test9 and for nothing else.
export function donorCell() {
  return 0;
}

// The concentration a fully dyed cell carries. The seed functions produce 0 or
// 1, so this is the range the colour scale is built around, and an interior
// source is clamped to it: a cell allowed to accumulate without bound would
// flatten the scale for everything else and show nothing.
export const MAX_CONCENTRATION = 1;

export class PassiveTracer {
  // maxCFL is the tracer's OWN stability bound, not the solver's. 0.5 is the
  // 2D unsplit forward-Euler figure; the 1D TVD result allows 1.
  constructor(grid, { maxCFL = 0.5, limiter = vanLeer } = {}) {
    this.nx = grid.nx;
    this.ny = grid.ny;
    this.h = grid.h;
    this.stride = grid.stride;
    this.maxCFL = maxCFL;
    this.limiter = limiter;

    const size = (grid.nx + 2) * (grid.ny + 2);
    this.c = new Float64Array(size);
    this.fx = new Float64Array(size);
    this.fy = new Float64Array(size);

    // Reported for the readouts, so a substep or a CFL excursion is visible
    // rather than silent.
    this.lastCFL = 0;
    this.lastSubsteps = 0;
    this.steps = 0;
  }

  idx(i, j) {
    return i + this.stride * j;
  }

  clear() {
    this.c.fill(0);
    this.steps = 0;
  }

  // Sets the initial concentration from a function of physical position.
  // Solid cells are forced to zero: dye inside a wall is not a thing.
  seed(grid, concentrationAt) {
    const { nx, ny } = this;
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const k = this.idx(i, j);
        if (grid.solid[k]) {
          this.c[k] = 0;
          continue;
        }
        const { x, y } = grid.cellCentre(i, j);
        this.c[k] = concentrationAt(x, y);
      }
    }
    this.steps = 0;
  }

  // Total dye over the fluid cells. Non-finite entries are counted, never
  // summed into the total: a NaN anywhere would otherwise turn the whole sum
  // into a single NaN and lose the count of how much of the field is broken.
  total(grid) {
    let sum = 0;
    let nonFiniteCells = 0;
    for (let j = 1; j <= this.ny; j++) {
      for (let i = 1; i <= this.nx; i++) {
        const k = this.idx(i, j);
        if (grid.solid[k]) continue;
        const value = this.c[k];
        if (!Number.isFinite(value)) {
          nonFiniteCells++;
          continue;
        }
        sum += value;
      }
    }
    return { total: nonFiniteCells > 0 ? NaN : sum, nonFiniteCells };
  }

  // Advances the tracer across one solver timestep, using the velocity field
  // the solver has just produced.
  //
  // THE TRACER NEVER VOTES ON dt. If its own CFL bound is tighter than the
  // step it was handed, it subdivides that step for itself. Asking the driver
  // for a smaller dt instead would change the fluid solution - a display
  // feature altering the physics, which is precisely the coupling this whole
  // arrangement exists to prevent.
  //
  // The bound does bind, and knowing where matters. In steady operation the
  // tracer sees a CFL around 0.39-0.50 against its own bound of 0.5, so it
  // takes one substep. But on the FIRST step of an impulsively started
  // scenario it sees 5.1 and takes eleven.
  //
  // That is not a defect in either layer. computeStableTimestep sizes dt from
  // the field as it is BEFORE the step, and before the first step the bend is
  // at rest: there is no convective limit to find, so dt comes from the
  // viscous one and is roughly thirteen times what the next step will use.
  // The flow that exists afterwards is moving at speed 3. The tracer advects
  // with that post-step field, so it is the one layer that sees the real
  // number.
  //
  // Had the tracer instead asked for a smaller dt, it would have changed the
  // fluid solution on the first step of every scenario - a display feature
  // silently altering the physics, which is exactly the coupling this
  // arrangement exists to prevent. It subdivides its own work instead.
  advect(grid, bc, dt, options = {}) {
    const cfl = this.courantNumber(grid, dt);
    const substeps =
      Number.isFinite(cfl) && cfl > this.maxCFL ? Math.ceil(cfl / this.maxCFL) : 1;

    const sub = dt / substeps;
    let injected = { added: 0, cells: 0 };
    for (let n = 0; n < substeps; n++) {
      this.applyBoundary(grid, bc, options.inject);
      this.advance(grid, sub);
      // Interior sources release dye per SUBSTEP, at dye*sub, so the total over
      // the step is dye*dt whether the tracer subdivided once or eleven times.
      // Releasing dye*dt inside the loop would multiply it by the substep count
      // - which varies with the flow, so the dye would depend on how fast the
      // fluid happened to be moving.
      if (options.sources) {
        const round = injectSourceDye(this, grid, options.sources, sub, MAX_CONCENTRATION);
        injected = { added: injected.added + round.added, cells: round.cells };
      }
    }

    this.lastCFL = cfl;
    this.lastSubsteps = substeps;
    this.lastInjected = injected;
    this.steps++;
    return { cfl, substeps, dt, injected };
  }

  // The Courant number that actually governs this update.
  //
  // Not (|u| + |v|)*dt/h. Writing the donor-cell update out, the coefficient
  // multiplying a cell's own concentration is
  //
  //     1 - (dt/h) * (sum of the OUTWARD face velocities)
  //
  // and the scheme stays positive exactly while that coefficient does. So the
  // quantity to measure is the outflow sum per cell - inward faces bring dye
  // in and cannot drive the cell negative. Two looser measures were tried
  // first and both overstated it on the bend, which would have made the
  // tracer substep for a constraint that was not binding:
  //
  //     largest |u| anywhere + largest |v| anywhere    0.85   (peaks are in
  //                                                            different places)
  //     per cell, max of the two faces on each axis    0.81   (counts inward
  //                                                            faces as if they
  //                                                            destabilised)
  //     per cell, outward faces only                   0.45   (this one)
  //
  // all measured on the sharp bend at the same moment. The first two would
  // have had the tracer substepping permanently at twice the cost for a bound
  // that was never binding.
  //
  // Faces against a solid contribute nothing because advance() forces their
  // flux to zero, so counting them here would be measuring a flux that does
  // not exist.
  //
  // This is a different measure from solver/stability.js peakCellSpeed, which
  // uses cell-centred averages. That is the right measure for the momentum
  // equation's cell-centred advection and the wrong one for a flux through a
  // single face. The two sit close in practice - 3.087 against 3.090 at the
  // bend's corner cell, and up to about 20% apart where the shear across a
  // cell is strongest - and where they differ this one is the higher. That is
  // not a disagreement between them.
  //
  // Non-finite velocities produce NaN rather than being skipped: a CFL that
  // silently ignores a broken cell is the same masking bug the solver had.
  courantNumber(grid, dt) {
    const { nx, ny, h } = this;
    const { u, v, solid } = grid;
    let peak = 0;
    let nonFinite = 0;
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const k = this.idx(i, j);
        if (solid[k]) continue;
        const west = this.idx(i - 1, j);
        const south = this.idx(i, j - 1);
        const outflow =
          (solid[this.idx(i + 1, j)] ? 0 : Math.max(u[k], 0)) +
          (solid[west] ? 0 : Math.max(-u[west], 0)) +
          (solid[this.idx(i, j + 1)] ? 0 : Math.max(v[k], 0)) +
          (solid[south] ? 0 : Math.max(-v[south], 0));
        if (!Number.isFinite(outflow)) {
          nonFinite++;
          continue;
        }
        if (outflow > peak) peak = outflow;
      }
    }
    if (nonFinite > 0) return NaN;
    return (peak * dt) / h;
  }

  // Ghost-cell concentrations, which is all the boundary treatment this scheme
  // needs: every domain-edge flux is then just the uniform face formula with a
  // ghost cell on one side.
  //
  //   inflow      the ghost carries the injected concentration, so dye enters
  //   outflow     zero gradient, so the upwind value is the interior one and
  //               dye leaves without reflecting
  //   wall/slip   the normal velocity is zero there, so the flux is zero
  //               whatever the ghost holds
  applyBoundary(grid, bc, inject = {}) {
    const { nx, ny } = this;
    const c = this.c;

    for (let j = 0; j <= ny + 1; j++) {
      c[this.idx(0, j)] = this.ghostValue(grid, bc?.left, inject.left, 0, j, 1, j);
      c[this.idx(nx + 1, j)] = this.ghostValue(grid, bc?.right, inject.right, nx + 1, j, nx, j);
    }
    for (let i = 0; i <= nx + 1; i++) {
      c[this.idx(i, 0)] = this.ghostValue(grid, bc?.bottom, inject.bottom, i, 0, i, 1);
      c[this.idx(i, ny + 1)] = this.ghostValue(grid, bc?.top, inject.top, i, ny + 1, i, ny);
    }
  }

  ghostValue(grid, side, injector, gi, gj, ii, ij) {
    if (side?.type === "inflow" && injector) {
      const { x, y } = grid.cellCentre(gi, gj);
      return injector(x, y);
    }
    return this.c[this.idx(ii, ij)];
  }

  // One forward-Euler flux update. Fluxes are computed from the current field
  // first and the cells updated afterwards, so the in-place update is safe.
  advance(grid, dt) {
    const { nx, ny, h } = this;
    const { u, v, solid } = grid;
    const c = this.c;
    const fx = this.fx;
    const fy = this.fy;
    const limiter = this.limiter;

    // ----- x fluxes on faces i = 0..nx -----
    for (let j = 1; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const face = this.idx(i, j);
        const left = face;
        const right = this.idx(i + 1, j);
        const speed = u[face];
        // A face with solid on BOTH sides is inside the body and carries
        // nothing. A face with solid on one side is a surface, and since M5 it
        // can carry real flux - a drawn outlet or inlet. Skipping those by the
        // presence of solid rather than by the absence of flow meant dye could
        // not leave through a drawn outlet: measured at 70.4% accumulation over
        // 400 steps in a channel whose only outlet was a surface. A wall face
        // still carries exactly zero, so `speed === 0` skips it first.
        if (speed === 0 || (solid[left] && solid[right])) {
          fx[face] = 0;
          continue;
        }
        const courant = (speed * dt) / h;
        let value;
        if (speed > 0) {
          const back = this.idx(i - 1, j);
          value =
            i >= 1 && !solid[back]
              ? faceValue(c, left, back, right, limiter, courant)
              : c[left];
        } else {
          const back = this.idx(i + 2, j);
          value =
            i <= nx - 1 && !solid[back]
              ? faceValue(c, right, back, left, limiter, courant)
              : c[right];
        }
        fx[face] = speed * value;
      }
    }

    // ----- y fluxes on faces j = 0..ny -----
    for (let j = 0; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const face = this.idx(i, j);
        const below = face;
        const above = this.idx(i, j + 1);
        const speed = v[face];
        if (speed === 0 || (solid[below] && solid[above])) {
          fy[face] = 0;
          continue;
        }
        const courant = (speed * dt) / h;
        let value;
        if (speed > 0) {
          const back = this.idx(i, j - 1);
          value =
            j >= 1 && !solid[back]
              ? faceValue(c, below, back, above, limiter, courant)
              : c[below];
        } else {
          const back = this.idx(i, j + 2);
          value =
            j <= ny - 1 && !solid[back]
              ? faceValue(c, above, back, below, limiter, courant)
              : c[above];
        }
        fy[face] = speed * value;
      }
    }

    const scale = dt / h;
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        const k = this.idx(i, j);
        if (solid[k]) {
          c[k] = 0;
          continue;
        }
        c[k] -=
          scale *
          (fx[k] - fx[this.idx(i - 1, j)] + fy[k] - fy[this.idx(i, j - 1)]);
      }
    }
  }
}

// Limited reconstruction of the concentration at a face.
//
//   donor       the upwind cell
//   back        the cell upwind of the donor
//   forward     the cell downwind of the face
//   courant     u*dt/h at this face
//
// The (1 - |courant|) factor on the antidiffusive part is not optional and is
// easy to leave out. Without it the correction is the second-order SPATIAL
// one, which paired with forward Euler is the unstable central scheme held
// together only by the limiter clamping it; the profile survives but lags,
// because the antidiffusive flux is too large by 1/(1 - |courant|). With it,
// this is the standard Sweby flux-limited form: second order in space and
// time, exactly donor cell at |courant| = 1 (where upwind transport is exact),
// and TVD for |courant| <= 1 given psi <= min(2r, 2).
//
// Measured cost of getting this wrong, on the translation test in
// tests/test9: the crest still held at 0.9996, so nothing looked broken, while
// the peak error was 1.40e-1 against 1.02e-2 with the factor present.
//
// Zero downwind difference means a flat profile, where any slope would be
// invention; the limiter's r would also be a division by zero.
function faceValue(c, donor, back, forward, limiter, courant) {
  const delta = c[forward] - c[donor];
  if (delta === 0) return c[donor];
  const r = (c[donor] - c[back]) / delta;
  return c[donor] + 0.5 * limiter(r) * (1 - Math.abs(courant)) * delta;
}
