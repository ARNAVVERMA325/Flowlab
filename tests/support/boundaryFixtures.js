// Golden-field cases: the evidence that an M4 boundary-condition change did
// not move the physics.
//
// The M4 refactor replaces four duplicated per-side if/else chains with one
// implementation parameterised by side. That is exactly the kind of change
// that passes every tolerance while being subtly wrong: the four chains are
// NOT symmetric with each other, and an index confused between them puts a
// wall half a cell out of place. The left wall reflects the tangential
// velocity about ghost i=0 against interior i=1; the right wall reflects
// about ghost i=nx+1 against interior i=nx, while its NORMAL component lives
// at face i=nx rather than at the ghost. Getting one of those wrong produces a
// field that still looks like a cavity flow.
//
// So the guarantee is not "the tests still pass". It is that these fields come
// back BYTE FOR BYTE identical to what the pre-refactor solver produced. The
// hashes are generated from the code as it stood before any M4 work and
// committed, so the guard outlives this milestone and protects the next
// refactor too.
//
// This works because the solver is deterministic: single-threaded, no random
// input, fixed reduction order. Two things would break byte-equality for
// reasons that are not physics, and the refactor has to preserve both:
//
//   - the summation order in enforceGlobalFluxBalance, which accumulates net
//     flux across boundary faces;
//   - the order in which ghost values are written where one depends on
//     another.
//
// Two groups of cases:
//
//   REAL          the validated configurations, built from the same boundary
//                 specifications the M0 tests use (imported, not copied - a
//                 copy could drift and then the fixture would be proving
//                 something about the wrong specification).
//   COVERAGE      every boundary type in every position, including
//                 combinations no scenario uses. The real cases between them
//                 never put an inflow on the top, an outflow on the left, or a
//                 wall moving in v on a vertical side, and those are precisely
//                 the branches where a per-side index error hides.

import { createHash } from "node:crypto";

import { StaggeredGrid, stampCircle } from "../../geometry/grid.js";
import { applyDocument } from "../../geometry/document.js";
import { bendDocument, cylinderDocument } from "../../geometry/documents.js";
import { step } from "../../solver/ns2d.js";
import { cavityBoundary } from "./cavity.js";
import { cylinderBoundary } from "./cylinder.js";
import { bendBoundary } from "./bend.js";

// Deliberately small. These runs exist to detect a changed field, not to reach
// a steady state - a boundary condition applied wrongly is wrong on step one,
// and a short run keeps the guard inside `npm test` rather than making it a
// separate ceremony people skip.
const STEPS = 30;

function uniformFlow(grid, u0) {
  for (let k = 0; k < grid.u.length; k++) grid.u[k] = u0;
}

// ---------------------------------------------------------------------------
// REAL - the validated configurations
// ---------------------------------------------------------------------------

function cavityCase() {
  const n = 32;
  const U = 1;
  const Re = 400;
  const h = 1 / n;
  const nu = (U * 1) / Re;
  const grid = new StaggeredGrid(n, n, h);
  return {
    grid,
    bc: cavityBoundary(U),
    params: { nu, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / nu, h / U), divergenceTol: 1e-7 },
  };
}

function cylinderCase() {
  const D = 1;
  const cpd = 8;
  const h = D / cpd;
  const U0 = 1;
  const nu = (U0 * D) / 100;
  let ny = Math.round(4 * cpd);
  if (ny % 2 === 0) ny += 1;
  const nx = Math.round(8 * cpd);
  const grid = new StaggeredGrid(nx, ny, h);
  const jc = (ny + 1) / 2;
  const ic = Math.round(2.5 / h + 0.5);
  applyDocument(grid, cylinderDocument({ cx: (ic - 0.5) * h, cy: (jc - 0.5) * h, radius: D / 2 }));
  for (let j = 0; j <= ny + 1; j++) {
    for (let i = 0; i <= nx + 1; i++) {
      if (!grid.solid[grid.idx(i, j)]) grid.u[grid.idx(i, j)] = U0;
    }
  }
  return {
    grid,
    bc: cylinderBoundary(U0),
    params: {
      nu, rho: 1,
      dt: 0.4 * Math.min((0.25 * h * h) / nu, h / (2 * U0)),
      divergenceTol: 1e-7, poissonMaxIterations: 20000,
    },
  };
}

function bendCase(innerRadius) {
  const w = 1;
  const cpw = 8;
  const legLen = 4;
  const h = w / cpw;
  const U0 = 1;
  const nu = (U0 * w) / 200;
  const Lx = legLen * w + w;
  const nx = Math.round(Lx / h);
  const grid = new StaggeredGrid(nx, nx, h);
  applyDocument(grid, bendDocument({ Lx, Ly: Lx, w, innerRadius }));
  return {
    grid,
    bc: bendBoundary(U0),
    params: {
      nu, rho: 1,
      dt: 0.3 * Math.min((0.25 * h * h) / nu, h / (4 * U0)),
      divergenceTol: 1e-7, poissonMaxIterations: 20000,
    },
  };
}

// ---------------------------------------------------------------------------
// COVERAGE - every type in every position
// ---------------------------------------------------------------------------

// A small grid with a seeded shear so that every boundary has something
// non-trivial to act on. A field of zeros would make most of these cases
// indistinguishable from each other.
function shearedBox(bc, { seedU = true, solidBlob = false } = {}) {
  const n = 16;
  const h = 1 / n;
  const grid = new StaggeredGrid(n, n, h);
  if (seedU) {
    for (let j = 0; j <= n + 1; j++) {
      for (let i = 0; i <= n + 1; i++) {
        const { x, y } = grid.cellCentre(i, j);
        grid.u[grid.idx(i, j)] = Math.sin(3 * y) + 0.25 * Math.cos(2 * x);
        grid.v[grid.idx(i, j)] = 0.4 * Math.sin(2 * x) - 0.1 * Math.cos(3 * y);
      }
    }
  }
  if (solidBlob) stampCircle(grid, 0.5, 0.5, 0.15);
  const nu = 0.01;
  return {
    grid,
    bc,
    params: { nu, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / nu, h / 2), divergenceTol: 1e-7 },
  };
}

const W = { type: "wall" };
const FS = { type: "freeSlip" };
const ZG = { type: "zeroGradient" };

export const FIXTURE_CASES = [
  { id: "real-cavity", group: "real", description: "lid-driven cavity, moving wall on top", build: cavityCase },
  { id: "real-cylinder", group: "real", description: "cylinder in a channel: inflow, outflow, free-slip walls", build: cylinderCase },
  { id: "real-bend-sharp", group: "real", description: "mitre bend: inflow left, outflow bottom, walls", build: () => bendCase(null) },
  { id: "real-bend-smooth", group: "real", description: "radiused bend, same boundaries", build: () => bendCase(1) },

  {
    id: "closed-box",
    group: "coverage",
    description: "closed domain, four no-slip walls",
    build: () => shearedBox({ left: W, right: W, top: W, bottom: W }),
  },
  {
    // Every side carries a moving wall, and the two vertical sides move in v -
    // a combination no validated scenario uses, and the one where a confused
    // normal/tangential index on a vertical side would show up.
    id: "moving-walls-all-sides",
    group: "coverage",
    description: "moving wall on every side, vertical sides moving in v",
    build: () =>
      shearedBox({
        left: { type: "wall", v: 0.7 },
        right: { type: "wall", v: -0.5 },
        top: { type: "wall", u: 1 },
        bottom: { type: "wall", u: -0.3 },
      }),
  },
  {
    id: "inflow-top-outflow-bottom",
    group: "coverage",
    description: "vertical flow: inflow on the top, outflow on the bottom",
    build: () =>
      shearedBox({ left: W, right: W, top: { type: "inflow", v: -1 }, bottom: { type: "outflow" } }),
  },
  {
    // Reversed against every real scenario, which all flow left-to-right or
    // left-to-bottom. Flow enters on the right and leaves on the left.
    id: "inflow-right-outflow-left",
    group: "coverage",
    description: "reversed flow: inflow on the right, outflow on the left",
    build: () =>
      shearedBox({ left: { type: "outflow" }, right: { type: "inflow", u: -1 }, top: FS, bottom: FS }),
  },
  {
    // The mirror of inflow-top-outflow-bottom. Added because the coverage test
    // caught that no case put an inflow on the bottom or an outflow on the
    // top, which are two of the eight type-by-side branches the refactor
    // rewrites.
    id: "inflow-bottom-outflow-top",
    group: "coverage",
    description: "vertical flow the other way: inflow on the bottom, outflow on the top",
    build: () =>
      shearedBox({ left: W, right: W, bottom: { type: "inflow", v: 1 }, top: { type: "outflow" } }),
  },
  {
    id: "free-slip-box",
    group: "coverage",
    description: "free-slip on all four sides",
    build: () => shearedBox({ left: FS, right: FS, top: FS, bottom: FS }),
  },
  {
    // DEMONSTRATED ILL-POSED. Every side copies its interior velocity and none
    // of them participates in the flux balance, so the domain carries a net
    // flux that nothing can remove. Measured against the pre-M5 solver: it
    // reported a divergence of 9.889e-8 as converged while the field's actual
    // max|div u| was 1.206e-2, equal to the unbalanced net flux.
    //
    // The recorded hashes below are therefore hashes of a broken field. They
    // are left in place rather than deleted, as the record of what was being
    // asserted; `invalid` takes the case out of the byte-identity comparison,
    // and tests/test11 asserts what it does now instead.
    id: "zero-gradient-box",
    group: "coverage",
    invalid: "unbalanceable: no boundary condition here can absorb the net flux",
    description: "zero-gradient on all four sides",
    build: () => shearedBox({ left: ZG, right: ZG, top: ZG, bottom: ZG }),
  },
  {
    // Two inflows facing each other, which is what Test 2 actually specifies:
    // under the Cartesian convention u = U0 on both sides means flow passing
    // straight through, not a collision. Pinned because an "inward normal"
    // convention would silently invert the right-hand side.
    id: "through-flow-both-inflow",
    group: "coverage",
    description: "inflow on left AND right with the same u - flow passes through",
    build: () =>
      shearedBox({
        left: { type: "inflow", u: 1, v: 0 },
        right: { type: "inflow", u: 1, v: 0 },
        top: FS,
        bottom: FS,
      }),
  },
  {
    // DEMONSTRATED BROKEN WHEN RECORDED. Outflow on two sides at once was
    // meant to exercise the multi-face branch of the flux balance. It exposed
    // the opposite: the rescale added a FLAT delta to every outflow face, and
    // because influx through a face is sign*value*h, opposed outlets cancelled
    // and the rescale did nothing at all. Measured against the pre-M5 solver:
    // divergence reported as 8.115e-8 while the field's actual max|div u| was
    // 2.950e-1.
    //
    // Fixed in M5 by applying the correction along each face's outward normal.
    // The recorded hashes below predate that fix and are hashes of a broken
    // field, so they are excluded from the comparison rather than regenerated
    // - regenerating would quietly overwrite the evidence. tests/test11
    // asserts the corrected behaviour.
    id: "two-outflows",
    invalid: "recorded before the outward-normal rescale fix; hashes are of an unbalanced field",
    group: "coverage",
    description: "inflow left, outflow on both the right and the bottom",
    build: () =>
      shearedBox({
        left: { type: "inflow", u: 1, v: 0 },
        right: { type: "outflow" },
        top: W,
        bottom: { type: "outflow" },
      }),
  },
  {
    // The well-posed replacement for `zero-gradient-box`. It carries
    // zeroGradient on all four sides, which is the coverage that case was
    // supposed to provide, but pairs it with a real outlet so the net flux the
    // copied faces carry has somewhere to go. That is the whole difference: a
    // zeroGradient face passes flux and takes no part in balancing it, so a
    // domain made only of them has nothing that can absorb what it carries.
    //
    // Segments make this expressible at all - one condition per side cannot
    // say "open along this stretch, wall along the rest".
    id: "zero-gradient-with-outlet",
    group: "coverage",
    description: "zero-gradient stretches on all four sides, with an inlet and a real outlet",
    build: () =>
      shearedBox({
        left: [
          { from: 0, to: 0.25, type: "zeroGradient" },
          { from: 0.25, to: 1, type: "inflow", u: 1, v: 0 },
        ],
        right: [
          { from: 0, to: 0.25, type: "zeroGradient" },
          { from: 0.25, to: 1, type: "outflow" },
        ],
        bottom: [
          { from: 0, to: 0.25, type: "zeroGradient" },
          { from: 0.25, to: 1, type: "wall" },
        ],
        top: [
          { from: 0, to: 0.25, type: "zeroGradient" },
          { from: 0.25, to: 1, type: "wall" },
        ],
      }),
  },
  {
    // An obstacle touching an outflow side, so some boundary faces are solid
    // and must be excluded from the flux rescale.
    id: "obstacle-with-outflow",
    group: "coverage",
    description: "inflow left, outflow right, obstacle in the domain",
    build: () =>
      shearedBox(
        { left: { type: "inflow", u: 1, v: 0 }, right: { type: "outflow" }, top: W, bottom: W },
        { solidBlob: true }
      ),
  },
];

// Runs one case and returns the fields. Deterministic by construction: the
// grid is built fresh, the timestep is fixed rather than adaptive, and nothing
// here reads a clock or a random source.
// `pressureSolver` defaults to "cg", the solver these fixtures were generated
// with, so the original record keeps pinning the reference solve byte for
// byte whatever step() defaults to. The preconditioned solve has its own
// record (tests/fixtures/golden-fields-mic-pcg.json).
export function runFixtureCase(entry, { pressureSolver = "cg" } = {}) {
  const { grid, bc, params } = entry.build();
  const pinned = { ...params, pressureSolver };
  for (let n = 0; n < STEPS; n++) step(grid, bc, pinned);
  return grid;
}

function hashField(array) {
  return createHash("sha256")
    .update(Buffer.from(array.buffer, array.byteOffset, array.byteLength))
    .digest("hex")
    .slice(0, 32);
}

// Scalars alongside the hashes so a failure says something physical before
// anyone runs the diff tool. A hash mismatch alone tells you that the field
// changed; `peakU` moving from 1.0 to 0.5 tells you roughly how.
export function measureFixtureCase(entry, options = {}) {
  const grid = runFixtureCase(entry, options);
  let peakU = 0;
  let peakV = 0;
  let nonFinite = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      if (grid.solid[k]) continue;
      const u = grid.u[k];
      const v = grid.v[k];
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      peakU = Math.max(peakU, Math.abs(u));
      peakV = Math.max(peakV, Math.abs(v));
    }
  }
  return {
    id: entry.id,
    group: entry.group,
    description: entry.description,
    steps: STEPS,
    grid: `${grid.nx}x${grid.ny}`,
    u: hashField(grid.u),
    v: hashField(grid.v),
    p: hashField(grid.p),
    peakU: nonFinite > 0 ? null : peakU,
    peakV: nonFinite > 0 ? null : peakV,
    nonFiniteCells: nonFinite,
  };
}
