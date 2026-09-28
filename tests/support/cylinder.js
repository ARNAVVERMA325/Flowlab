// Flow past a circular cylinder in a channel: harness plus the measurements
// Test 5 validates against.
//
// Test-support code only - nothing here is imported by /solver or /geometry.

import { StaggeredGrid } from "../../geometry/grid.js";
import { applyDocument } from "../../geometry/document.js";
import { cylinderDocument } from "../../geometry/documents.js";
import { step, computeDivergence } from "../../solver/ns2d.js";
import { wakeLength } from "../../physics/features.js";

const cache = new Map();

// Geometry is expressed in cylinder diameters so the physics is independent
// of the arbitrary length unit: D = 1, channel HD diameters tall and LD long,
// cylinder centred xD diameters from the inlet.
//
// The row count is forced odd so the channel centreline runs through the
// centre of a row of u samples rather than between two of them. That makes
// the cylinder's staircase mask exactly symmetric about the centreline, so
// any asymmetry in the result is solver error rather than a lopsided mask.
// See the note on cavityBoundary: shared with the golden-field fixture so the
// two cannot drift apart.
export function cylinderBoundary(U0) {
  return {
    left: { type: "inflow", u: U0, v: 0 },
    right: { type: "outflow" },
    top: { type: "freeSlip" },
    bottom: { type: "freeSlip" },
  };
}

export function runCylinderToSteadyState({
  Re,
  cpd = 12,
  HD = 6,
  LD = 10,
  xD = 3.5,
  U0 = 1,
  rho = 1,
  dtSafety = 0.6,
  steadyTol = 1e-5,
  // 1e-9 rather than the 1e-7 used elsewhere, because this scenario asserts
  // that a mirror-symmetric problem gives a mirror-symmetric answer.
  //
  // Under the previous red-black SOR pressure solve that assertion was free:
  // SOR is a stationary iteration whose colouring is itself mirror-symmetric
  // when the row count is odd, so symmetry held to 2e-15 no matter how loosely
  // it converged. Conjugate gradient has no such structural guarantee - its
  // symmetry is only as good as its convergence, and it leaves asymmetric
  // error at the tolerance level on every step. The Re=40 wake sits just under
  // the shedding threshold near Re=47 and accumulates that error rather than
  // damping it: 1.7e-10 by step 200, 1.0e-7 by step 1200.
  //
  // Measured here: 1e-7 gives asymmetry 3.9e-8 (fails), 1e-8 gives 3.2e-9
  // (fails), 1e-9 gives 5.4e-11 - an 18x margin against the unchanged 1e-9
  // assertion - and 1e-10 gives 4.3e-12. Divergence improves from 9.4e-8 to
  // 9.5e-10 at the same time. This changes how well the simulation converges,
  // not what counts as passing.
  divergenceTol = 1e-9,
  omega = 1.97,
  maxTime = 400,
}) {
  const key = `${Re}:${cpd}:${HD}:${LD}:${xD}:${U0}:${steadyTol}:${divergenceTol}`;
  if (cache.has(key)) return cache.get(key);

  const D = 1;
  const h = D / cpd;
  const nu = (U0 * D) / Re;
  let ny = Math.round(HD * cpd);
  if (ny % 2 === 0) ny += 1;
  const nx = Math.round(LD * cpd);

  const grid = new StaggeredGrid(nx, ny, h);
  const jc = (ny + 1) / 2;
  const yc = (jc - 0.5) * h;
  const ic = Math.round((xD * D) / h + 0.5);
  const xc = (ic - 0.5) * h;
  // M5: the body is a geometry document rather than a direct stamp. Byte-
  // identical to stampCircle - tests/test11 checks it cell for cell.
  const solidCells = applyDocument(grid, cylinderDocument({ cx: xc, cy: yc, radius: D / 2 }));

  const bc = cylinderBoundary(U0);
  for (let j = 0; j <= ny + 1; j++) {
    for (let i = 0; i <= nx + 1; i++) {
      if (!grid.solid[grid.idx(i, j)]) grid.u[grid.idx(i, j)] = U0;
    }
  }

  const dt = dtSafety * Math.min((0.25 * h * h) / nu, h / (2 * U0));
  const params = { nu, rho, dt, divergenceTol, omega, poissonMaxIterations: 20000 };
  const maxSteps = Math.ceil(maxTime / dt);

  // Steadiness is measured as max|du/dt| over a WINDOW of steps, not between
  // consecutive ones. The pressure solve leaves a per-step noise floor of
  // roughly divergenceTol, so a consecutive-step rate is about
  // divergenceTol/dt - which grows as dt shrinks, and at low Reynolds number
  // dt is small because the diffusive stability limit binds. Measured that
  // way a perfectly steady Re=1 flow reports a rate of ~2e-5 and never
  // converges, because the criterion is reading solver tolerance rather than
  // physics. Across a window the noise stays bounded while genuine drift
  // accumulates, so the ratio reflects the flow. Real unsteadiness (vortex
  // shedding) still registers: it changes the field a lot over a window.
  const WINDOW = 200;
  const snapshot = new Float64Array(grid.u.length);
  snapshot.set(grid.u);

  let t = 0;
  let steps = 0;
  let rate = Infinity;
  let poissonConvergedEverywhere = true;

  while (steps < maxSteps) {
    const r = step(grid, bc, params);
    if (!r.poissonConverged) poissonConvergedEverywhere = false;
    t += dt;
    steps++;
    if (steps % WINDOW === 0) {
      let m = 0;
      for (let k = 0; k < grid.u.length; k++) {
        const d = Math.abs(grid.u[k] - snapshot[k]);
        if (d > m) m = d;
      }
      rate = m / (WINDOW * dt);
      snapshot.set(grid.u);
      if (rate < steadyTol) break;
    }
  }

  const result = {
    grid, D, h, nx, ny, jc, yc, ic, xc, solidCells, dt, nu, t, steps, rate, U0, Re,
    blockage: D / (ny * h),
    reachedSteady: rate < steadyTol,
    poissonConvergedEverywhere,
    divergence: computeDivergence(grid),
  };
  cache.set(key, result);
  return result;
}

function isFluidUFace(grid, i, j) {
  return !grid.solid[grid.idx(i, j)] && !grid.solid[grid.idx(i + 1, j)];
}

// Length of the standing recirculation bubble, measured from the rear of the
// cylinder to where the centreline velocity returns to zero.
//
// Only faces with fluid on both sides are considered. Faces lying on the
// cylinder surface carry a hard zero (no-penetration) and faces inside the
// body carry reflected ghost values; treating either as flow data would put
// the reattachment point on the cylinder itself.
export function wakeBubbleLength(run) {
  // Delegates to physics/features.js since M10, so the app's cylinder
  // experiment and this validated measurement are one definition.
  const { grid, jc, xc, D } = run;
  return wakeLength(grid, { row: jc, rear: xc + D / 2, D });
}

// Peak reverse velocity on the centreline, as a fraction of the inlet speed.
export function peakReverseVelocity(run) {
  const { grid, jc, xc, D, h, nx, U0 } = run;
  let worst = 0;
  for (let i = 1; i <= nx - 1; i++) {
    const x = i * h;
    if (x <= xc + D / 2 || !isFluidUFace(grid, i, jc)) continue;
    const u = grid.u[grid.idx(i, jc)];
    if (u < worst) worst = u;
  }
  return worst / U0;
}

// Pressure difference between the front and rear stagnation regions, sampled
// at the fluid cells immediately upstream and downstream of the cylinder on
// the centreline. Positive means higher pressure on the upstream face, which
// is the pressure signature of form drag. Reported as a physical readout
// only - integrating it into an actual drag coefficient is out of scope.
export function stagnationPressureDifference(run) {
  const { grid, jc, nx } = run;
  let front = null;
  let rear = null;
  for (let i = 1; i <= nx; i++) {
    const here = grid.solid[grid.idx(i, jc)];
    const next = grid.solid[grid.idx(i + 1, jc)];
    if (!here && next && front === null) front = grid.p[grid.idx(i, jc)];
    if (here && !next) rear = grid.p[grid.idx(i + 1, jc)];
  }
  if (front === null || rear === null) return NaN;
  return front - rear;
}

// Peak flow speed anywhere in the domain, which for a blocked channel sits in
// the accelerated region beside the cylinder.
export function peakSpeed(run) {
  const { grid, nx, ny } = run;
  let m = 0;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = grid.idx(i, j);
      if (grid.solid[k]) continue;
      const uc = (grid.u[grid.idx(i - 1, j)] + grid.u[k]) / 2;
      const vc = (grid.v[grid.idx(i, j - 1)] + grid.v[k]) / 2;
      m = Math.max(m, Math.hypot(uc, vc));
    }
  }
  return m;
}

// Volume flux through every vertical cut. In a steady incompressible flow
// this must equal the inlet flux at every station. Faces on or inside the
// cylinder are excluded: they are not flow area.
export function fluxThroughCuts(run) {
  const { grid, nx, ny, h } = run;
  const flux = [];
  for (let i = 0; i <= nx; i++) {
    let q = 0;
    for (let j = 1; j <= ny; j++) {
      if (i > 0 && i < nx && !isFluidUFace(grid, i, j)) continue;
      q += grid.u[grid.idx(i, j)] * h;
    }
    flux.push(q);
  }
  const inlet = flux[0];
  let maxDeviation = 0;
  for (const q of flux) maxDeviation = Math.max(maxDeviation, Math.abs(q - inlet));
  return { inlet, maxDeviation, relative: maxDeviation / inlet, flux };
}

// Symmetric geometry and symmetric boundary conditions must give a symmetric
// steady solution: u mirrored about the centreline, v antisymmetric. Any
// departure is numerical, so this bounds the bias introduced by the obstacle
// treatment.
export function centrelineAsymmetry(run) {
  const { grid, nx, ny, jc } = run;
  let u = 0;
  let v = 0;
  for (let m = 1; jc - m >= 1 && jc + m <= ny; m++) {
    for (let i = 1; i <= nx - 1; i++) {
      u = Math.max(u, Math.abs(grid.u[grid.idx(i, jc - m)] - grid.u[grid.idx(i, jc + m)]));
    }
    for (let i = 1; i <= nx; i++) {
      v = Math.max(v, Math.abs(grid.v[grid.idx(i, jc - m)] + grid.v[grid.idx(i, jc + m - 1)]));
    }
  }
  return { u, v };
}

// Every face lying on the cylinder surface must carry exactly zero normal
// velocity. Faces strictly inside the body are excluded: those are ghosts
// holding reflected values, which is what enforces tangential no-slip.
export function maxVelocityOnSolidSurface(run) {
  const { grid, nx, ny } = run;
  const idx = (i, j) => grid.idx(i, j);
  let m = 0;
  for (let j = 1; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const a = grid.solid[idx(i, j)];
      const b = grid.solid[idx(i + 1, j)];
      if (a !== b) m = Math.max(m, Math.abs(grid.u[idx(i, j)]));
    }
  }
  for (let i = 1; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const a = grid.solid[idx(i, j)];
      const b = grid.solid[idx(i, j + 1)];
      if (a !== b) m = Math.max(m, Math.abs(grid.v[idx(i, j)]));
    }
  }
  return m;
}
