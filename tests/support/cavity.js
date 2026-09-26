// Lid-driven cavity harness: drives the solver to steady state and extracts
// the quantities the Ghia et al. benchmark reports.
//
// Test-support code only - nothing here is imported by /solver or /geometry.

import { StaggeredGrid } from "../../geometry/grid.js";
import { step, computeDivergence } from "../../solver/ns2d.js";

const cache = new Map();

// Runs the unit-square cavity at the given Reynolds number until the flow
// stops changing. Results are memoised because several tests compare
// different aspects of the same run and these are the slowest runs in the
// suite.
//
// The timestep is set from the explicit stability limits of the scheme:
// the diffusive limit nu*dt/h^2 < 1/4 and the convective limit |u|*dt/h < 1,
// with a safety factor. Adaptive timestep control is M1 work; this just
// picks a safe fixed value and reports it.
// The boundary specification, separated from the run so that the golden-field
// fixture can drive the SAME object this scenario is validated with rather
// than a copy of it. A copy would let the two drift, and the whole point of
// the fixture is to prove a boundary-condition change did not move the
// physics - which it cannot do if it is checking a different specification.
export function cavityBoundary(U) {
  return {
    left: { type: "wall" },
    right: { type: "wall" },
    bottom: { type: "wall" },
    top: { type: "wall", u: U }, // the sliding lid
  };
}

export function runCavityToSteadyState({
  n,
  Re,
  U = 1,
  rho = 1,
  dtSafety = 0.65,
  steadyTol = 1e-5,
  divergenceTol = 1e-7,
  maxTime = 300,
}) {
  const key = `${n}:${Re}:${U}:${rho}:${dtSafety}:${steadyTol}:${divergenceTol}`;
  if (cache.has(key)) return cache.get(key);

  const h = 1 / n;
  const nu = (U * 1) / Re; // Re = U*L/nu with L = 1
  const dt = dtSafety * Math.min((0.25 * h * h) / nu, h / U);

  const grid = new StaggeredGrid(n, n, h);
  const bc = cavityBoundary(U);
  const params = { nu, rho, dt, divergenceTol };

  const prevU = new Float64Array(grid.u.length);
  const prevV = new Float64Array(grid.v.length);
  const maxSteps = Math.ceil(maxTime / dt);

  let t = 0;
  let steps = 0;
  let rate = Infinity;
  let poissonConvergedEverywhere = true;

  while (steps < maxSteps) {
    prevU.set(grid.u);
    prevV.set(grid.v);
    const r = step(grid, bc, params);
    if (!r.poissonConverged) poissonConvergedEverywhere = false;
    t += dt;
    steps++;

    // Steady state is declared on the rate of change of the field itself,
    // max|du/dt|, not on a fixed number of iterations.
    if (steps % 100 === 0) {
      let m = 0;
      for (let k = 0; k < grid.u.length; k++) {
        const du = Math.abs(grid.u[k] - prevU[k]);
        const dv = Math.abs(grid.v[k] - prevV[k]);
        if (du > m) m = du;
        if (dv > m) m = dv;
      }
      rate = m / dt;
      if (rate < steadyTol) break;
    }
  }

  const result = {
    grid,
    n,
    Re,
    U,
    dt,
    nu,
    t,
    steps,
    rate,
    reachedSteady: rate < steadyTol,
    poissonConvergedEverywhere,
    divergence: computeDivergence(grid),
    cellReynolds: h / nu, // |u|*h/nu with |u| ~ U = 1
  };
  cache.set(key, result);
  return result;
}

function interpolate(xs, fs, x) {
  if (x <= xs[0]) return fs[0];
  if (x >= xs[xs.length - 1]) return fs[fs.length - 1];
  let k = 1;
  while (xs[k] < x) k++;
  const w = (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
  return fs[k - 1] * (1 - w) + fs[k] * w;
}

// u along the vertical line through the cavity centre. On the MAC grid u
// lives on faces x = i*h, so for even n the centreline x = 0.5 is exactly a
// face - no interpolation in x is needed. In y, u lives at cell centres, so
// we interpolate between them, using the physical wall values as end nodes.
export function uAlongVerticalCentreline(grid, targetY, U) {
  const { nx, ny, h } = grid;
  const i = nx / 2;
  const ys = [0];
  const us = [0];
  for (let j = 1; j <= ny; j++) {
    ys.push((j - 0.5) * h);
    us.push(grid.u[grid.idx(i, j)]);
  }
  ys.push(1);
  us.push(U);
  return targetY.map((y) => interpolate(ys, us, y));
}

// v along the horizontal line through the cavity centre. Mirror image of the
// above: v lives on faces y = j*h, so y = 0.5 is exact for even n.
export function vAlongHorizontalCentreline(grid, targetX) {
  const { nx, ny, h } = grid;
  const j = ny / 2;
  const xs = [0];
  const vs = [0];
  for (let i = 1; i <= nx; i++) {
    xs.push((i - 0.5) * h);
    vs.push(grid.v[grid.idx(i, j)]);
  }
  xs.push(1);
  vs.push(0);
  return targetX.map((x) => interpolate(xs, vs, x));
}

// Centre of the primary vortex. Moved to physics/features.js in M10 so the
// app's experiments use the very measurement the Ghia comparison is built on;
// this re-export keeps every existing caller - and the validated numbers -
// on the one definition.
export { primaryVortexCentre } from "../../physics/features.js";

export function maxAbsDifference(a, b) {
  let m = 0;
  for (let k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k] - b[k]));
  return m;
}
