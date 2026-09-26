// The momentum budget of the last solver step, term by term.
//
// The equation the solver advances, per unit mass:
//
//   du/dt  =  -(u.grad)u  -  grad(p)/rho  +  nu lap(u)  +  f
//   ------    ----------     -----------     ---------     -
//   unsteady  advection      pressure        viscous       source
//
// Each term here is computed with the SOLVER'S OWN STENCILS, from the state the
// solver actually used: the velocity at the start of the step with its ghost
// values rebuilt exactly as step() rebuilds them, and the pressure the
// projection produced. The unsteady term is not computed at all - it is
// MEASURED, as the change the step made divided by its timestep.
//
// That is what makes the budget checkable rather than illustrative. On every
// face the solver updates, the measured change must equal the sum of the four
// forcing terms to rounding - and `closure` reports how far it is. If any
// stencil below drifted from the one in solver/ns2d.js, the budget would stop
// closing and the tests would say so. A picture of "where advection dominates"
// is only worth looking at if the advection in it is the advection that moved
// the fluid.
//
// ADVECTION IS COMPUTED IN CONSERVATIVE FORM, div(uu), because that is what the
// solver computes. It equals (u.grad)u only where div u = 0, which the
// projection holds to its stated bound (1e-7 by default) - so the two agree to
// that bound, and the explorer says which form is meant.
//
// Nothing here writes to the grid. The boundary pass runs on copies.

import { applyVelocityBoundaryConditions } from "../solver/ns2d.js";
import { sourcePlanFor } from "../sources/compile.js";

export const TERMS = ["unsteady", "advection", "pressure", "viscous", "source"];

// Returns the face-by-face budget of the step that took the field from
// (previousU, previousV) to the grid's current state, or null if there is no
// such step to describe.
export function momentumBudget(grid, bc, { nu, rho, dt, fx = 0, fy = 0, sources = null }, previousU, previousV) {
  if (!(dt > 0) || previousU === null || previousV === null) return null;
  const { nx, ny, h, u, v, p, solid } = grid;
  const stride = nx + 2;
  const idx = (i, j) => i + stride * j;
  const h2 = h * h;

  // The start-of-step velocity with its ghosts as step() saw them. step()
  // calls applyBoundaryConditions(grid, bc) before anything else, and after a
  // step the ghosts are NOT already in that state (measured: up to 0.10 in the
  // cavity's wall ghosts), so this is required, not a formality.
  const un = previousU.slice();
  const vn = previousV.slice();
  applyVelocityBoundaryConditions(grid, bc, un, vn);

  const momentum = sourcePlanFor(grid, sources).momentum;
  const relaxU = momentum === null ? null : momentum.u;
  const relaxV = momentum === null ? null : momentum.v;
  const table = momentum === null ? null : momentum.table;

  const size = u.length;
  const make = () => Object.fromEntries(TERMS.map((term) => [term, new Float64Array(size)]));
  const U = make();
  const V = make();
  // 1 where the solver updates this face from the momentum equation. Boundary
  // faces and faces touching a solid are set by the boundary pass instead, and
  // have no budget.
  const uActive = new Uint8Array(size);
  const vActive = new Uint8Array(size);

  let closure = 0;
  let largest = 0;
  const account = (T, k) => {
    const sum = T.advection[k] + T.pressure[k] + T.viscous[k] + T.source[k];
    closure = Math.max(closure, Math.abs(T.unsteady[k] - sum));
    for (const term of TERMS) largest = Math.max(largest, Math.abs(T[term][k]));
  };

  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx - 1; i++) {
      const k = idx(i, j);
      if (solid[k] || solid[idx(i + 1, j)]) continue;
      uActive[k] = 1;
      const uij = un[k];
      const d2udx2 = (un[idx(i + 1, j)] - 2 * uij + un[idx(i - 1, j)]) / h2;
      const d2udy2 = (un[idx(i, j + 1)] - 2 * uij + un[idx(i, j - 1)]) / h2;
      const ue = (uij + un[idx(i + 1, j)]) / 2;
      const uw = (un[idx(i - 1, j)] + uij) / 2;
      const du2dx = (ue * ue - uw * uw) / h;
      const unorth = (uij + un[idx(i, j + 1)]) / 2;
      const usouth = (un[idx(i, j - 1)] + uij) / 2;
      const vnorth = (vn[idx(i, j)] + vn[idx(i + 1, j)]) / 2;
      const vsouth = (vn[idx(i, j - 1)] + vn[idx(i + 1, j - 1)]) / 2;
      const duvdy = (unorth * vnorth - usouth * vsouth) / h;

      U.viscous[k] = nu * (d2udx2 + d2udy2);
      U.advection[k] = -(du2dx + duvdy);
      U.pressure[k] = -((p[idx(i + 1, j)] - p[k]) / h) / rho;
      let source = fx;
      if (relaxU !== null && relaxU[k] >= 0) {
        const entry = table[relaxU[k]];
        source += (Math.min(1, dt / entry.relaxationTime) * (entry.u - uij)) / dt;
      }
      U.source[k] = source;
      U.unsteady[k] = (u[k] - uij) / dt;
      account(U, k);
    }
  }

  for (let i = 1; i <= nx; i++) {
    for (let j = 1; j <= ny - 1; j++) {
      const k = idx(i, j);
      if (solid[k] || solid[idx(i, j + 1)]) continue;
      vActive[k] = 1;
      const vij = vn[k];
      const d2vdx2 = (vn[idx(i + 1, j)] - 2 * vij + vn[idx(i - 1, j)]) / h2;
      const d2vdy2 = (vn[idx(i, j + 1)] - 2 * vij + vn[idx(i, j - 1)]) / h2;
      const vnorth = (vij + vn[idx(i, j + 1)]) / 2;
      const vsouth = (vn[idx(i, j - 1)] + vij) / 2;
      const dv2dy = (vnorth * vnorth - vsouth * vsouth) / h;
      const veast = (vij + vn[idx(i + 1, j)]) / 2;
      const vwest = (vn[idx(i - 1, j)] + vij) / 2;
      const ueast = (un[idx(i, j)] + un[idx(i, j + 1)]) / 2;
      const uwest = (un[idx(i - 1, j)] + un[idx(i - 1, j + 1)]) / 2;
      const duvdx = (ueast * veast - uwest * vwest) / h;

      V.viscous[k] = nu * (d2vdx2 + d2vdy2);
      V.advection[k] = -(duvdx + dv2dy);
      V.pressure[k] = -((p[idx(i, j + 1)] - p[k]) / h) / rho;
      let source = fy;
      if (relaxV !== null && relaxV[k] >= 0) {
        const entry = table[relaxV[k]];
        source += (Math.min(1, dt / entry.relaxationTime) * (entry.v - vij)) / dt;
      }
      V.source[k] = source;
      V.unsteady[k] = (v[k] - vij) / dt;
      account(V, k);
    }
  }

  return { u: U, v: V, uActive, vActive, dt, closure, largest, relativeClosure: largest > 0 ? closure / largest : 0 };
}

// Each term as a vector at the cell centre, from the updated faces around the
// cell, and its magnitude. A component with no updated face on either side
// (a cell walled in on both sides in that direction) is zero: nothing in the
// momentum equation acts there in that direction.
export function termMagnitudeAt(grid, budget, term, i, j) {
  const stride = grid.nx + 2;
  const k = i + stride * j;
  const component = (T, active, a, b) => {
    const n = active[a] + active[b];
    return n === 0 ? 0 : (active[a] * T[a] + active[b] * T[b]) / n;
  };
  const x = component(budget.u[term], budget.uActive, k - 1, k);
  const y = component(budget.v[term], budget.vActive, k - stride, k);
  return Math.hypot(x, y);
}

// For every fluid cell: each term's magnitude, its SHARE of the five together,
// and which term dominates - if any does.
//
// Two ways a cell has no winner, and both are measured rather than assumed:
//
// QUIET. All five together below QUIET of the largest total anywhere. In still
// fluid the "largest" term is whichever rounding error happens to be biggest.
//
// BALANCED. The largest term does not beat the runner-up by DOMINANCE_MARGIN.
// The first version named the plain largest, and reported the steady pressure
// channel as PRESSURE-dominated in 100% of cells and viscous in 0% - when
// plane Poiseuille flow is, exactly, pressure and viscosity in balance: the two
// are equal and opposite at every face, and "largest" was decided by the last
// bit. It is the same failure as M9's bare Q > 0 test, and gets the same fix:
// a stated margin, and a balance reported as a balance, naming both terms.
export const QUIET = 1e-6;
export const DOMINANCE_MARGIN = 0.1;

export function termShares(grid, budget) {
  const { nx, ny, solid } = grid;
  const stride = nx + 2;
  const size = (nx + 2) * (ny + 2);
  const magnitude = Object.fromEntries(TERMS.map((term) => [term, new Float64Array(size)]));
  const share = Object.fromEntries(TERMS.map((term) => [term, new Float64Array(size)]));
  const total = new Float64Array(size);
  const dominant = new Int8Array(size).fill(-1);
  let peakTotal = 0;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = i + stride * j;
      if (solid[k]) continue;
      let sum = 0;
      for (const term of TERMS) {
        const m = termMagnitudeAt(grid, budget, term, i, j);
        magnitude[term][k] = m;
        sum += m;
      }
      total[k] = sum;
      if (!(sum <= peakTotal)) peakTotal = sum;
    }
  }
  const wins = Object.fromEntries(TERMS.map((term) => [term, 0]));
  // Balances by the pair of terms involved, keyed "pressure+viscous" in TERMS
  // order, so the same pair always has the same name.
  const balances = {};
  let balanced = 0;
  let fluid = 0;
  let quiet = 0;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = i + stride * j;
      if (solid[k]) continue;
      fluid++;
      if (!(total[k] > QUIET * peakTotal)) {
        quiet++;
        continue;
      }
      let best = -1;
      let second = -1;
      TERMS.forEach((term, n) => {
        share[term][k] = magnitude[term][k] / total[k];
        const m = magnitude[term][k];
        if (best < 0 || m > magnitude[TERMS[best]][k]) {
          second = best;
          best = n;
        } else if (second < 0 || m > magnitude[TERMS[second]][k]) {
          second = n;
        }
      });
      const top = magnitude[TERMS[best]][k];
      const runnerUp = magnitude[TERMS[second]][k];
      if (top > (1 + DOMINANCE_MARGIN) * runnerUp) {
        dominant[k] = best;
        wins[TERMS[best]]++;
      } else {
        balanced++;
        const pair = [best, second].sort((a, b) => a - b).map((n) => TERMS[n]).join("+");
        balances[pair] = (balances[pair] ?? 0) + 1;
      }
    }
  }
  return { magnitude, share, total, dominant, wins, balances, balanced, fluid, quiet, peakTotal };
}
