// M11 - the equation explorer.
//
// The explorer points at a term of the momentum equation and says "this is
// where it acts". That is only worth anything if the term it is showing is the
// term that moved the fluid, so the central test here is the budget CLOSING:
// on every face the solver updated, the measured du/dt must equal the sum of
// the four forcing terms computed with the solver's stencils, to rounding. A
// stencil copied wrongly, a ghost value taken from the wrong moment, a source
// left out - each breaks that equality, and the mutation run for this
// milestone checks that each one does.
//
// The rest checks the physics the explorer then reports: a developed channel
// is a pressure-viscous balance and is SAID to be one, advection gains ground
// with Reynolds number, a source term appears exactly where a source is.

import test from "node:test";
import assert from "node:assert/strict";

import { StaggeredGrid } from "../geometry/grid.js";
import { applyVelocityBoundaryConditions, step } from "../solver/ns2d.js";
import { SimulationSession } from "../ui/session.js";
import { SCENARIOS } from "../scenarios/index.js";
import {
  DOMINANCE_MARGIN, QUIET, TERMS, momentumBudget, termMagnitudeAt, termShares,
} from "../physics/momentumBudget.js";
import { TERM_INFO, describeClosure, describeTerm, dominanceEdges } from "../ui/equationExplorer.js";
import { fieldSourceAvailable, prepareView } from "../visualization/fieldSources.js";

// A bit-exact fingerprint of everything the solver owns.
function fingerprint(grid) {
  let hash = 0;
  for (const array of [grid.u, grid.v, grid.p]) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let k = 0; k < bytes.length; k++) hash = (Math.imul(hash, 31) + bytes[k]) | 0;
  }
  return hash;
}

function advance(session, steps) {
  for (let n = 0; n < steps; n++) session.advance();
  return session;
}

// Rounding in (u_new - u_old)/dt, relative to the largest term. Measured
// 1.2e-15 to 2.6e-14 across the six scenarios; a wrong stencil is O(1).
const CLOSES = 1e-11;

// ---------------------------------------------------------------------------
// The budget closes
// ---------------------------------------------------------------------------

test("the momentum budget closes to rounding in every scenario", () => {
  for (const { id } of SCENARIOS) {
    const session = advance(new SimulationSession(id), 60);
    const budget = session.momentumBudget();
    assert.ok(budget.largest > 0, `${id}: the flow is moving`);
    assert.ok(budget.relativeClosure < CLOSES, `${id}: closes to ${budget.relativeClosure}`);
  }
});

test("the budget closes with a momentum source, a mass source and the brush running", () => {
  const session = new SimulationSession("cavity");
  const disk = { kind: "disk", cx: 0.3, cy: 0.5, radius: 0.1, metric: "squared", closed: true };
  session.addSource({ kind: "momentum", where: disk, u: 0, v: 1, relaxationTime: 0.05 });
  // A source and an equal sink: a closed cavity cannot absorb a net flux, and
  // the solver rightly refuses one on its own.
  session.addSource({ kind: "mass", where: { kind: "rect", x0: 0.6, y0: 0.2, x1: 0.7, y1: 0.3 }, rate: 0.5 });
  session.addSource({ kind: "mass", where: { kind: "rect", x0: 0.2, y0: 0.2, x1: 0.3, y1: 0.3 }, rate: -0.5 });
  session.setBrushSource({ kind: "momentum", where: { ...disk, cx: 0.7, cy: 0.7 }, u: -1, v: 0, relaxationTime: 0.02 });
  advance(session, 40);
  const budget = session.momentumBudget();
  assert.ok(budget.relativeClosure < CLOSES, `closes to ${budget.relativeClosure}`);

  // The source term is non-zero on the faces a momentum source covers and
  // exactly zero everywhere else: nothing else in the equation is external.
  let inside = 0;
  let outside = 0;
  for (let k = 0; k < budget.u.source.length; k++) {
    if (!budget.uActive[k]) continue;
    const i = k % (session.grid.nx + 2);
    const j = Math.floor(k / (session.grid.nx + 2));
    const x = i * session.grid.h;
    const y = (j - 0.5) * session.grid.h;
    const inDisk = (x - 0.3) ** 2 + (y - 0.5) ** 2 < 0.1 ** 2 || (x - 0.7) ** 2 + (y - 0.7) ** 2 < 0.1 ** 2;
    const nearDisk = (x - 0.3) ** 2 + (y - 0.5) ** 2 < 0.12 ** 2 || (x - 0.7) ** 2 + (y - 0.7) ** 2 < 0.12 ** 2;
    if (budget.u.source[k] !== 0) {
      assert.ok(nearDisk, `source term at (${x.toFixed(3)}, ${y.toFixed(3)}), outside every source`);
      inside++;
    } else if (!nearDisk) {
      outside++;
    }
    if (inDisk && (x - 0.3) ** 2 + (y - 0.5) ** 2 < 0.08 ** 2) assert.notEqual(budget.u.source[k], 0);
  }
  assert.ok(inside > 10 && outside > 1000, `${inside} source faces, ${outside} clear`);
});

test("the budget closes when a source's relaxation is clamped to one step", () => {
  // A relaxation time shorter than the timestep means "reach the target this
  // step": the solver clamps dt/tau at 1. The sources above all relax slower
  // than a step, so the clamp is exercised here on its own.
  const session = new SimulationSession("cavity");
  const disk = { kind: "disk", cx: 0.5, cy: 0.4, radius: 0.12, metric: "squared", closed: true };
  session.addSource({ kind: "momentum", where: disk, u: 0.8, v: 0.3, relaxationTime: 1e-6 });
  advance(session, 20);
  assert.ok(session.lastTimestep > 1e-6, "the clamp is active");
  const budget = session.momentumBudget();
  assert.ok(budget.relativeClosure < CLOSES, `closes to ${budget.relativeClosure}`);
});

test("the budget closes with a body force, and the force appears as the source term", () => {
  // No scenario carries fx, so this goes through step() with a grid of its own
  // - the budget takes the same parameters step() does.
  const n = 16;
  const grid = new StaggeredGrid(n, n, 1 / n);
  const bc = { left: { type: "wall" }, right: { type: "wall" }, bottom: { type: "wall" }, top: { type: "wall", u: 1 } };
  const params = { nu: 0.05, rho: 1.3, dt: 0.002, fx: 0.7, fy: -0.4, divergenceTol: 1e-9, poissonMaxIterations: 5000 };
  for (let s = 0; s < 10; s++) step(grid, bc, params);
  const u0 = grid.u.slice();
  const v0 = grid.v.slice();
  step(grid, bc, params);
  const budget = momentumBudget(grid, bc, params, u0, v0);
  assert.ok(budget.relativeClosure < CLOSES, `closes to ${budget.relativeClosure}`);
  const k = grid.idx(5, 5);
  assert.equal(budget.u.source[k], 0.7);
  assert.equal(budget.v.source[k], -0.4);
  // rho = 1.3: the pressure term is grad p / rho, per unit mass like the rest.
  assert.ok(Math.abs(budget.u.pressure[k] + (grid.p[grid.idx(6, 5)] - grid.p[k]) / grid.h / 1.3) < 1e-12);
});

test("the stored start-of-step field does not carry the ghosts the step used", () => {
  // The premise for rebuilding them. After a step the wall ghosts are NOT what
  // the next step's boundary pass makes them, so a budget taken from the raw
  // stored field would use different wall values from the solver's and fail to
  // close next to every wall. (Removing the rebuild from momentumBudget() is
  // one of this milestone's mutants; the closure tests above kill it.)
  const session = advance(new SimulationSession("cavity"), 30);
  const { bc } = session.lastStepInputs;
  const u = session.previousU.slice();
  const v = session.previousV.slice();
  applyVelocityBoundaryConditions(session.grid, bc, u, v);
  let changed = 0;
  for (let k = 0; k < u.length; k++) changed = Math.max(changed, Math.abs(u[k] - session.previousU[k]));
  assert.ok(changed > 1e-3, `ghosts moved by ${changed}`);
});

test("a boundary edit after the step does not change the budget of that step", () => {
  const session = advance(new SimulationSession("cavity"), 20);
  session.setBoundary("top", { type: "wall", u: -2 });
  const budget = session.momentumBudget();
  assert.ok(budget.relativeClosure < CLOSES,
    `the budget of the step that ran, under the conditions it ran with: ${budget.relativeClosure}`);
});

test("taking the budget writes nothing and is computed once per step", () => {
  const session = advance(new SimulationSession("bend-sharp"), 20);
  const before = fingerprint(session.grid);
  const a = session.momentumBudget();
  const b = session.momentumBudget();
  termShares(session.grid, a);
  assert.equal(fingerprint(session.grid), before);
  assert.equal(a, b, "cached until the next step");
  session.advance();
  assert.notEqual(session.momentumBudget(), a);
  session.reset();
  assert.equal(session.momentumBudget(), null, "no step since the reset, so no budget");
});

// ---------------------------------------------------------------------------
// The physics it then reports
// ---------------------------------------------------------------------------

test("a developed channel is a pressure-viscous balance, and is reported as one", () => {
  const session = new SimulationSession("pressure-channel");
  while (session.changeRate > 1e-6 && session.simulatedTime < 60) session.advance();
  const budget = session.momentumBudget();
  const shares = termShares(session.grid, budget);
  const active = shares.fluid - shares.quiet;
  // Parallel flow: v = 0 and u independent of x, so advection vanishes - to
  // the level the projection holds div u = 0 (1e-7 here) and no further,
  // because v and du/dx are only as small as that. Measured 1.9e-7 of the
  // largest term.
  let advection = 0;
  for (let k = 0; k < budget.u.advection.length; k++) advection = Math.max(advection, Math.abs(budget.u.advection[k]));
  assert.ok(advection < 1e-5 * budget.largest, `advection ${advection}`);
  const balanced = shares.balances["pressure+viscous"] ?? 0;
  assert.ok(balanced / active > 0.95, `pressure+viscous balance in ${balanced} of ${active} cells`);
  assert.equal(shares.wins.pressure, 0, "pressure must not be called dominant in a balance");
  const text = describeTerm("pressure", shares);
  assert.match(text, /dominates nowhere/);
  assert.match(text, /in balance with a second term, most often viscous diffusion/);
});

test("advection takes over from viscosity as the Reynolds number rises", () => {
  // The Reynolds number IS the ratio of the two, by scaling: |u.grad u| over
  // |nu lap u| goes as U L / nu. So the measured ratio of their totals over the
  // cavity should climb steeply with Re - not match it exactly, since the
  // velocity field itself changes shape - and the cells viscosity wins should
  // shrink. Each run is taken to the same simulated time from rest.
  const measure = (Re) => {
    const session = new SimulationSession("cavity");
    session.setReynolds(Re);
    while (session.simulatedTime < 1.5) session.advance();
    const shares = termShares(session.grid, session.momentumBudget());
    let advection = 0;
    let viscous = 0;
    for (let k = 0; k < shares.total.length; k++) {
      advection += shares.magnitude.advection[k];
      viscous += shares.magnitude.viscous[k];
    }
    return { ratio: advection / viscous, viscousWins: shares.wins.viscous / shares.fluid };
  };
  const [re10, re100, re1000] = [10, 100, 1000].map(measure);
  assert.ok(re10.ratio < re100.ratio && re100.ratio < re1000.ratio,
    `advection/viscous ${re10.ratio} -> ${re100.ratio} -> ${re1000.ratio}`);
  assert.ok(re1000.ratio / re10.ratio > 10, `grew by ${re1000.ratio / re10.ratio}`);
  assert.ok(re10.viscousWins > re1000.viscousWins, `viscous wins ${re10.viscousWins} -> ${re1000.viscousWins}`);
});

test("still fluid has no dominant term and says so", () => {
  const n = 8;
  const grid = new StaggeredGrid(n, n, 1 / n);
  const bc = { left: { type: "wall" }, right: { type: "wall" }, bottom: { type: "wall" }, top: { type: "wall" } };
  const params = { nu: 0.01, rho: 1, dt: 0.01, divergenceTol: 1e-9 };
  const u0 = grid.u.slice();
  const v0 = grid.v.slice();
  step(grid, bc, params);
  const shares = termShares(grid, momentumBudget(grid, bc, params, u0, v0));
  assert.equal(shares.quiet, shares.fluid);
  for (const term of TERMS) assert.equal(shares.wins[term], 0);
  assert.match(describeTerm("viscous", shares), /Nothing is moving/);
});

// ---------------------------------------------------------------------------
// termShares and the margin
// ---------------------------------------------------------------------------

// A hand-built budget with chosen magnitudes at one interior cell, so the
// classification rules can be checked without a flow.
function budgetAtOneCell(values) {
  const grid = new StaggeredGrid(3, 3, 1);
  const size = grid.u.length;
  const make = () => Object.fromEntries(TERMS.map((t) => [t, new Float64Array(size)]));
  const budget = { u: make(), v: make(), uActive: new Uint8Array(size), vActive: new Uint8Array(size) };
  // Cell (2,2): its x component is the mean of u faces (1,2) and (2,2).
  for (const k of [grid.idx(1, 2), grid.idx(2, 2)]) {
    budget.uActive[k] = 1;
    TERMS.forEach((t) => { budget.u[t][k] = values[t] ?? 0; });
  }
  return { grid, budget, k: grid.idx(2, 2) };
}

test("a term dominates only by the margin; closer than that is a balance naming both", () => {
  const clear = budgetAtOneCell({ advection: 1.2, pressure: 1.0 });
  const s1 = termShares(clear.grid, clear.budget);
  assert.equal(s1.dominant[clear.k], TERMS.indexOf("advection"), `1.2 vs 1.0 beats a ${DOMINANCE_MARGIN} margin`);

  const close = budgetAtOneCell({ advection: 1.05, pressure: 1.0 });
  const s2 = termShares(close.grid, close.budget);
  assert.equal(s2.dominant[close.k], -1);
  assert.equal(s2.balances["advection+pressure"] >= 1, true, "named in TERMS order");

  const reversed = budgetAtOneCell({ pressure: 1.05, advection: 1.0 });
  assert.ok(termShares(reversed.grid, reversed.budget).balances["advection+pressure"] >= 1, "same pair, same name");

  // Shares are fractions of the five together.
  const shares = s1.share;
  const sum = TERMS.reduce((acc, t) => acc + shares[t][clear.k], 0);
  assert.ok(Math.abs(sum - 1) < 1e-15);
  assert.ok(Math.abs(shares.advection[clear.k] - 1.2 / 2.2) < 1e-15);
});

test("the vector at a cell centre averages only the faces the solver updates", () => {
  const { grid, budget } = budgetAtOneCell({ viscous: 2 });
  // Switch one of the two faces off: the component is the other face alone,
  // not the mean with a zero that was never a value.
  budget.uActive[grid.idx(1, 2)] = 0;
  assert.equal(termMagnitudeAt(grid, budget, "viscous", 2, 2), 2);
  budget.uActive[grid.idx(2, 2)] = 0;
  assert.equal(termMagnitudeAt(grid, budget, "viscous", 2, 2), 0);
});

test("a tiny but non-zero cell is quiet; one above the threshold is not", () => {
  // Exact zeros would pass a bare "== 0" test too, so this uses a flow that is
  // small, not absent: 1e-9 of the busiest cell is quiet, 1e-3 is not.
  const grid = new StaggeredGrid(8, 3, 1);
  const size = grid.u.length;
  const make = () => Object.fromEntries(TERMS.map((t) => [t, new Float64Array(size)]));
  const budget = { u: make(), v: make(), uActive: new Uint8Array(size), vActive: new Uint8Array(size) };
  const put = (i, value) => {
    const k = grid.idx(i, 2);
    budget.uActive[k] = 1;
    budget.u.viscous[k] = value;
  };
  put(1, 1);
  put(4, 1e-9);
  put(7, 1e-3);
  const shares = termShares(grid, budget);
  const busy = shares.total[grid.idx(1, 2)];
  assert.ok(shares.total[grid.idx(4, 2)] > 0 && shares.total[grid.idx(4, 2)] < QUIET * busy);
  assert.equal(shares.dominant[grid.idx(4, 2)], -1, "tiny: quiet, no winner named");
  assert.equal(shares.dominant[grid.idx(7, 2)], TERMS.indexOf("viscous"), "small but real: counted");
});

test("the quiet threshold is relative to the busiest cell", () => {
  assert.equal(QUIET, 1e-6);
  const { grid, budget } = budgetAtOneCell({ viscous: 1 });
  const shares = termShares(grid, budget);
  // The two active faces sit either side of cell (2,2) and also border cells
  // (1,2) and (3,2), so those three carry the flow; the other six are exactly
  // zero and quiet.
  assert.equal(shares.fluid, 9);
  assert.equal(shares.quiet, 6);
});

// ---------------------------------------------------------------------------
// What the panel and the picture say
// ---------------------------------------------------------------------------

test("every term has a symbol, a name and an explanation, and describeTerm refuses an unknown one", () => {
  for (const term of TERMS) {
    for (const key of ["symbol", "name", "explain"]) assert.ok(TERM_INFO[term][key], `${term}.${key}`);
  }
  const { grid, budget } = budgetAtOneCell({ viscous: 1 });
  assert.throws(() => describeTerm("gravity", termShares(grid, budget)), RangeError);
});

test("describeTerm points at the leading term when the chosen one is quiet", () => {
  const session = advance(new SimulationSession("cylinder"), 200);
  const shares = termShares(session.grid, session.momentumBudget());
  const text = describeTerm("source", shares);
  assert.match(text, /dominates nowhere/);
  assert.match(text, /The term that dominates most of this flow is advection/);
  const closure = describeClosure(session.momentumBudget());
  assert.match(closure, /to \d\.\de-1\d of the largest term/);
});

test("the dominance outline is closed around each region", () => {
  const grid = new StaggeredGrid(4, 4, 1);
  const dominant = new Int8Array(grid.u.length).fill(-1);
  dominant[grid.idx(2, 2)] = 3;
  assert.equal(dominanceEdges(grid, dominant, 3).length, 4, "one cell, four sides");
  dominant[grid.idx(3, 2)] = 3;
  assert.equal(dominanceEdges(grid, dominant, 3).length, 6, "two cells share the side between them");
  assert.equal(dominanceEdges(grid, dominant, 1).length, 0);
  // At the domain edge the outline closes against it rather than leaving it open.
  dominant.fill(3);
  assert.equal(dominanceEdges(grid, dominant, 3).length, 16);
});

test("the term view shows the share on a fixed 0..1 scale, and nothing before the first step", () => {
  const session = new SimulationSession("jet");
  assert.equal(fieldSourceAvailable("term", { grid: session.grid, shares: null, term: "advection" }), false);
  assert.equal(prepareView("term", { grid: session.grid, shares: null, term: "advection" }), null);
  advance(session, 30);
  const shares = termShares(session.grid, session.momentumBudget());
  const view = prepareView("term", { grid: session.grid, shares, term: "viscous" });
  assert.equal(view.id, "term");
  assert.match(view.label, /viscous/);
  assert.deepEqual([view.scale.lo, view.scale.hi, view.scale.fixed], [0, 1, true]);
  const i = 20;
  const j = 10;
  assert.equal(view.valueAt(i, j), shares.share.viscous[session.grid.idx(i, j)]);
});
