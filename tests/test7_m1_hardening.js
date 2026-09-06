// M1 - solver hardening.
//
// Three things are under test here, all of them about the solver's behaviour
// rather than its physics:
//
//   1. The timestep is chosen from the field instead of picked by hand, and
//      the choice actually respects the scheme's stability limits.
//   2. A timestep the field cannot survive is rejected with a usable message,
//      rather than silently producing NaN.
//   3. Adapting the timestep does not change the answer. This is the one that
//      matters most: a timestep controller that quietly altered the steady
//      state would be worse than the fixed values it replaced.

import test from "node:test";
import assert from "node:assert/strict";

import { StaggeredGrid } from "../geometry/grid.js";
import {
  step, computeDivergence, computeContinuityError, SolverDivergenceError,
} from "../solver/ns2d.js";
import { sourcePlanFor } from "../sources/compile.js";
import {
  computeStableTimestep,
  stabilityLimits,
  peakCellSpeed,
  assertTimestepIsStable,
  SolverStabilityError,
} from "../solver/stability.js";

// node:assert's throws() does not hand back the error, and every rejection
// test here needs to inspect the reason and the message.
function captureThrow(fn, what) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail(`expected ${what} to throw, but it returned normally`);
}

const CLOSED_BOX = {
  left: { type: "wall" },
  right: { type: "wall" },
  top: { type: "wall" },
  bottom: { type: "wall" },
};

function cavity(n, Re, U = 1) {
  const grid = new StaggeredGrid(n, n, 1 / n);
  return {
    grid,
    bc: { ...CLOSED_BOX, top: { type: "wall", u: U } },
    params: { nu: U / Re, rho: 1, divergenceTol: 1e-8 },
  };
}

// Marches with the timestep chosen from the field before every step.
function marchAdaptively({ grid, bc, params }, { safety, until, maxSteps = 40000 }) {
  let t = 0;
  let steps = 0;
  let previousTimestep = null;
  let worstCfl = 0;
  let worstDiffusion = 0;
  let smallest = Infinity;
  let largest = 0;
  let biggestGrowth = 0;

  while (t < until && steps < maxSteps) {
    const selection = computeStableTimestep(grid, {
      nu: params.nu,
      safety,
      previousTimestep,
    });
    if (previousTimestep !== null) {
      biggestGrowth = Math.max(biggestGrowth, selection.dt / previousTimestep);
    }
    previousTimestep = selection.dt;
    smallest = Math.min(smallest, selection.dt);
    largest = Math.max(largest, selection.dt);

    step(grid, bc, { ...params, dt: selection.dt });
    t += selection.dt;
    steps++;

    // The realised numbers are measured against the field AFTER the step, not
    // the one the timestep was chosen from. That is the honest test: the
    // controller looks backwards, and what matters is whether the step it
    // authorised was survivable by the field it produced.
    const after = stabilityLimits(grid, params.nu);
    worstCfl = Math.max(worstCfl, selection.dt / after.convective);
    worstDiffusion = Math.max(worstDiffusion, selection.dt / after.viscous);
  }

  return { t, steps, worstCfl, worstDiffusion, smallest, largest, biggestGrowth };
}

test("M1 - the adaptive timestep keeps the realised CFL inside the stability limit", () => {
  const safety = 0.4;
  const setup = cavity(32, 400);
  const run = marchAdaptively(setup, { safety, until: 6 });

  console.log(
    `[M1 CFL] cavity 32x32 Re=400, safety=${safety}: ${run.steps} steps to t=${run.t.toFixed(2)}\n` +
    `         dt ranged ${run.smallest.toExponential(3)} .. ${run.largest.toExponential(3)} ` +
    `(${(run.largest / run.smallest).toFixed(2)}x)\n` +
    `         worst realised CFL=${run.worstCfl.toFixed(4)} diffusion number=${run.worstDiffusion.toFixed(4)}`
  );

  // The hard limit is 1. Staying under it is the whole point of the controller.
  assert.ok(run.worstCfl < 1, `realised CFL reached ${run.worstCfl}`);
  assert.ok(run.worstDiffusion < 1, `realised diffusion number reached ${run.worstDiffusion}`);
  // And it should not be wildly conservative either - a controller that always
  // picked a thousandth of the limit would pass the above and be useless.
  assert.ok(
    Math.max(run.worstCfl, run.worstDiffusion) > safety / 2,
    "the timestep should actually approach the limit it is sized against"
  );
});

test("M1 - the timestep responds to the flow rather than staying fixed", () => {
  const setup = cavity(32, 400);
  const run = marchAdaptively(setup, { safety: 0.4, until: 6 });

  // Starting from rest there is no convective limit at all, so the first steps
  // are viscous-limited and large; as the lid drags fluid into motion the
  // convective limit tightens. A fixed timestep cannot express that.
  assert.ok(
    run.largest / run.smallest > 1.5,
    `the timestep should vary over the run, got ${run.smallest} .. ${run.largest}`
  );
  assert.ok(
    run.biggestGrowth <= 1.1 + 1e-12,
    `growth limiter should cap increases at 1.1x per step, saw ${run.biggestGrowth}`
  );
  console.log(
    `[M1 adaptivity] dt varied ${(run.largest / run.smallest).toFixed(2)}x, ` +
    `largest single-step growth ${run.biggestGrowth.toFixed(4)}x (limit 1.1)`
  );
});

test("M1 - the growth limiter caps how fast the timestep may rise", () => {
  // Exercised directly. In the cavity march the timestep only ever falls (it
  // starts viscous-limited from rest and the convective limit tightens as the
  // lid drags fluid into motion), so the march alone does not test this.
  const { grid, params } = cavity(32, 400);
  const unconstrained = computeStableTimestep(grid, { nu: params.nu, safety: 0.4 });
  const tiny = unconstrained.dt / 100;
  const limited = computeStableTimestep(grid, {
    nu: params.nu,
    safety: 0.4,
    previousTimestep: tiny,
    growthLimit: 1.1,
  });

  console.log(
    `[M1 growth] unconstrained dt=${unconstrained.dt.toExponential(3)}; ` +
    `after a step of ${tiny.toExponential(3)} the next is ${limited.dt.toExponential(3)} ` +
    `(limited by "${limited.limitedBy}")`
  );

  assert.equal(limited.limitedBy, "growthLimit");
  assert.ok(Math.abs(limited.dt - tiny * 1.1) < 1e-18, `expected ${tiny * 1.1}, got ${limited.dt}`);
  // Falling is not limited - the controller must be free to drop immediately.
  const dropping = computeStableTimestep(grid, {
    nu: params.nu,
    safety: 0.4,
    previousTimestep: unconstrained.dt * 1000,
  });
  assert.ok(dropping.dt <= unconstrained.dt, "a timestep must be free to fall in one step");
});

test("M1 - a field at rest is limited by viscosity, not by CFL", () => {
  const { grid, params } = cavity(32, 400);
  const selection = computeStableTimestep(grid, { nu: params.nu, safety: 0.4 });

  console.log(
    `[M1 rest] peak speed=${selection.peakSpeed}, limited by "${selection.limitedBy}", ` +
    `dt=${selection.dt.toExponential(3)} (viscous limit ${selection.viscousLimit.toExponential(3)}, ` +
    `convective limit ${selection.convectiveLimit})`
  );

  assert.equal(selection.peakSpeed, 0);
  assert.equal(selection.convectiveLimit, Infinity, "a still field has no convective limit");
  assert.equal(selection.limitedBy, "viscous");
  assert.ok(Number.isFinite(selection.dt) && selection.dt > 0);
  // h^2/(4*nu) with h = 1/32 and nu = 1/400.
  assert.ok(Math.abs(selection.viscousLimit - (1 / 32) ** 2 / (4 * (1 / 400))) < 1e-15);
});

test("M1 - an unstable timestep is rejected before it can produce NaN", () => {
  const { grid, bc, params } = cavity(32, 400);
  const limits = stabilityLimits(grid, params.nu);

  // Viscous violation on a field at rest.
  const tooBig = limits.viscous * 1.5;
  const viscousError = captureThrow(() => step(grid, bc, { ...params, dt: tooBig }), "an oversized viscous step");
  assert.ok(viscousError instanceof SolverStabilityError, `expected SolverStabilityError, got ${viscousError}`);
  console.log(`[M1 reject] viscous: ${viscousError.message}`);
  assert.equal(viscousError.reason, "viscous");
  assert.ok(viscousError.ratio > 1);
  // The message has to be usable: it names the limit, the actual value, and
  // what to do. A bare "unstable" would not be an improvement on NaN.
  assert.match(viscousError.message, /viscous stability limit/);
  assert.match(viscousError.message, /diffusion number/);
  assert.match(viscousError.message, /Reduce dt/);

  // The field must be untouched - the rejection happens before any work.
  let maxSpeed = 0;
  for (const value of grid.u) maxSpeed = Math.max(maxSpeed, Math.abs(value));
  assert.equal(maxSpeed, 0, "a rejected step must not have modified the field");

  // Convective violation: give the field a large velocity so CFL binds first.
  const moving = cavity(32, 400);
  for (let k = 0; k < moving.grid.u.length; k++) moving.grid.u[k] = 50;
  const movingLimits = stabilityLimits(moving.grid, moving.params.nu);
  assert.ok(movingLimits.convective < movingLimits.viscous, "test setup: CFL should bind");
  const cflError = captureThrow(
    () => step(moving.grid, moving.bc, { ...moving.params, dt: movingLimits.convective * 1.2 }),
    "an oversized convective step"
  );
  assert.ok(cflError instanceof SolverStabilityError, `expected SolverStabilityError, got ${cflError}`);
  console.log(`[M1 reject] convective: ${cflError.message}`);
  assert.equal(cflError.reason, "convective");
  assert.match(cflError.message, /CFL/);
  assert.match(cflError.message, /computeStableTimestep/);
});

test("M1 - nonsense timesteps are rejected too", () => {
  const { grid, bc, params } = cavity(16, 100);
  for (const dt of [0, -1e-3, NaN, Infinity]) {
    const error = captureThrow(() => step(grid, bc, { ...params, dt }), `dt=${dt}`);
    assert.ok(error instanceof SolverStabilityError, `dt=${dt}: expected SolverStabilityError, got ${error}`);
    assert.equal(error.reason, "invalid-timestep");
  }
});

test("M1 - a field that arrives broken is reported, not thrown at", () => {
  // step() throws for what it would itself produce. A field that was already
  // non-finite on entry is the caller's problem and goes down the reporting
  // path instead, which is what tests/regression_nonfinite_reporting.js pins.
  // This test exists so that distinction cannot be erased by accident.
  const { grid, bc, params } = cavity(16, 100);
  grid.u[grid.idx(8, 8)] = NaN;

  const limits = assertTimestepIsStable(grid, params.nu, 1e-4);
  assert.equal(limits.finite, false, "the guard should notice, and return rather than throw");

  const result = step(grid, bc, { ...params, dt: 1e-4 });
  assert.equal(result.poissonConverged, false);
  assert.ok(!Number.isFinite(result.poissonResidual));
  console.log(
    `[M1 broken input] no throw; reported poissonConverged=${result.poissonConverged} ` +
    `residual=${result.poissonResidual}`
  );

  // But choosing a timestep from a broken field is not something that can be
  // done sensibly at all, so that does throw.
  const error = captureThrow(
    () => computeStableTimestep(grid, { nu: params.nu, safety: 0.4 }),
    "choosing a timestep from a broken field"
  );
  assert.ok(error instanceof SolverStabilityError);
  assert.equal(error.reason, "non-finite-field");
  console.log(`[M1 broken input] computeStableTimestep refuses: ${error.message}`);
});

test("M1 - peakCellSpeed reports non-finite rather than a calm maximum", () => {
  // Same rule as everywhere else in this project, applied to the new code.
  const { grid } = cavity(16, 100);
  for (let k = 0; k < grid.u.length; k++) grid.u[k] = 0.3;
  assert.ok(Number.isFinite(peakCellSpeed(grid).peak));

  // Poisoned early, with hundreds of finite cells after it - the ordering that
  // defeats a comparison-based reduction.
  grid.u[grid.idx(1, 1)] = NaN;
  const scan = peakCellSpeed(grid);
  assert.equal(scan.finite, false);
  assert.ok(scan.nonFiniteCells > 0);
  assert.ok(!Number.isFinite(scan.peak), `peak must not be a calm number, got ${scan.peak}`);
});

test("M1 - adapting the timestep does not change the steady state", () => {
  // The load-bearing test for M1. A driven cavity is marched twice to the same
  // physical time: once with the timestep chosen per step, once with a fixed
  // conservative timestep of the kind the scenarios used before. If the
  // controller altered the physics, the two would disagree.
  const until = 8;

  const adaptive = cavity(32, 400);
  const adaptiveRun = marchAdaptively(adaptive, { safety: 0.4, until });

  const fixed = cavity(32, 400);
  const fixedDt = stabilityLimits(fixed.grid, fixed.params.nu).viscous * 0.1;
  let t = 0;
  let fixedSteps = 0;
  while (t < until) {
    step(fixed.grid, fixed.bc, { ...fixed.params, dt: fixedDt });
    t += fixedDt;
    fixedSteps++;
  }

  // Compare u along the vertical centreline.
  const { grid: a } = adaptive;
  const { grid: b } = fixed;
  const i = a.nx / 2;
  let worst = 0;
  let peak = 0;
  for (let j = 1; j <= a.ny; j++) {
    worst = Math.max(worst, Math.abs(a.u[a.idx(i, j)] - b.u[b.idx(i, j)]));
    peak = Math.max(peak, Math.abs(b.u[b.idx(i, j)]));
  }

  console.log(
    `[M1 equivalence] cavity 32x32 Re=400 marched to t=${until}\n` +
    `         adaptive: ${adaptiveRun.steps} steps, dt ${adaptiveRun.smallest.toExponential(2)}..${adaptiveRun.largest.toExponential(2)}\n` +
    `         fixed:    ${fixedSteps} steps, dt ${fixedDt.toExponential(2)}\n` +
    `         max centreline difference = ${worst.toExponential(3)} against a peak of ${peak.toFixed(4)} ` +
    `(${((worst / peak) * 100).toFixed(3)}% of peak)`
  );

  assert.ok(adaptiveRun.steps < fixedSteps, "adapting should need fewer steps than a fixed conservative dt");
  assert.ok(
    worst / peak < 0.02,
    `adaptive and fixed marching should agree, differ by ${((worst / peak) * 100).toFixed(2)}% of peak`
  );
});

test("M1 - the pressure solve meets the divergence tolerance it is given", () => {
  // CG replaced SOR; this pins the contract that survived the swap - the
  // tolerance is expressed as a bound on the divergence of the resulting field,
  // and it is actually met.
  for (const tol of [1e-6, 1e-8, 1e-10]) {
    const setup = cavity(32, 400);
    setup.params.divergenceTol = tol;
    marchAdaptively(setup, { safety: 0.4, until: 2 });
    const divergence = computeDivergence(setup.grid);
    console.log(`[M1 tolerance] divergenceTol=${tol.toExponential(0)} -> max|div u|=${divergence.max.toExponential(2)}`);
    assert.ok(
      divergence.max <= tol,
      `requested divergence below ${tol}, got ${divergence.max}`
    );
  }
});


// ---------------------------------------------------------------------------
// Divergence control. Distinct from the failure handling above: that is about
// the scheme coming apart, this is about the continuity constraint being met.
// ---------------------------------------------------------------------------

test("M1 - the divergence bound is enforced, not merely reported", () => {
  const setup = cavity(32, 400);
  marchAdaptively(setup, { safety: 0.4, until: 1 });
  const { grid, bc, params } = setup;
  const dt = computeStableTimestep(grid, { nu: params.nu, safety: 0.4 }).dt;

  // Starve the pressure solve so it cannot reach the requested bound. Before
  // this was enforced, step() returned normally here with divergence 9.0e-3
  // against a promised 1e-8 - five orders of magnitude out, flagged only by a
  // poissonConverged field that nothing was obliged to read.
  const error = captureThrow(
    () => step(grid, bc, { ...params, dt, poissonMaxIterations: 3 }),
    "a pressure solve that cannot meet its divergence bound"
  );

  console.log(`[M1 divergence] ${error.message}`);
  assert.ok(error instanceof SolverDivergenceError, `expected SolverDivergenceError, got ${error}`);
  assert.equal(error.reason, "divergence-bound");
  assert.equal(error.requested, params.divergenceTol);
  assert.ok(error.achieved > error.requested, "the error must carry what was actually achieved");
  assert.match(error.message, /asked for/);
  assert.match(error.message, /achieved/);
  // The message has to name a remedy, not just complain.
  assert.match(error.message, /poissonMaxIterations/);
});

test("M1 - a solve that meets its bound does not throw", () => {
  const setup = cavity(32, 400);
  const { grid, bc, params } = setup;
  const dt = computeStableTimestep(grid, { nu: params.nu, safety: 0.4 }).dt;
  const result = step(grid, bc, { ...params, dt });
  assert.equal(result.poissonConverged, true);
  assert.ok(result.continuityError <= params.divergenceTol);
});

test("M1 - the reported divergence is the divergence the field actually has", () => {
  // step() reports the achieved divergence from the identity
  // div = -(dt/rho) * residual, which costs nothing because the residual is
  // already known. That is only worth doing if the identity is real, so it is
  // checked against an independent scan of the field rather than assumed.
  const setup = cavity(32, 400);
  const { grid, bc, params } = setup;
  let previousTimestep = null;
  let worstRatio = 0;

  for (let n = 0; n < 120; n++) {
    const selection = computeStableTimestep(grid, {
      nu: params.nu, safety: 0.4, previousTimestep,
    });
    previousTimestep = selection.dt;
    const result = step(grid, bc, { ...params, dt: selection.dt });
    const measured = computeDivergence(grid).max;
    worstRatio = Math.max(worstRatio, Math.abs(result.continuityError / measured - 1));
  }

  console.log(`[M1 identity] reported vs measured divergence agree to ${worstRatio.toExponential(2)} relative over 120 steps`);

  // The two agree exactly in real arithmetic - div_k = -(dt/rho)*r_k holds per
  // cell, so the same cell attains both maxima. They differ only in floating
  // point, and the gap is dominated by cancellation in the direct scan rather
  // than by anything wrong with the identity: computeDivergence differences
  // velocities of order 1 to produce a result of order 1e-10, which costs
  // roughly eps*|u|/|div| ~ 7e-7 of relative accuracy. Measured worst over 120
  // steps is 3.6e-6; 1e-4 leaves headroom without being meaningless.
  assert.ok(
    worstRatio < 1e-4,
    `the reported divergence should match a direct scan, worst relative gap ${worstRatio}`
  );
});

test("M1 - the identity is about the CONTINUITY ERROR, not the divergence", () => {
  // The identity above was written as "divergence" because q had always been
  // zero. It is not: div_k - q_k = -(dt/rho)*r_k holds per cell whether or not
  // a source imposes q, and once one does the two are different numbers. This
  // pins which of them step() actually returns, on a case where they differ by
  // seven orders of magnitude - so the statement can no longer be true by the
  // coincidence that made it ambiguous.
  const n = 24;
  const h = 1 / n;
  const nu = 0.01;
  const grid = new StaggeredGrid(n, n, h);
  const bc = {
    left: { type: "wall" }, right: { type: "outflow" },
    top: { type: "wall" }, bottom: { type: "wall" },
  };
  const sources = [{
    kind: "mass",
    where: { kind: "rect", x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 },
    rate: 0.05,
  }];
  const params = {
    nu, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / nu, h / 4),
    divergenceTol: 1e-7, poissonMaxIterations: 20000, sources,
  };
  const plan = sourcePlanFor(grid, sources);

  let result;
  for (let k = 0; k < 200; k++) result = step(grid, bc, params);

  const raw = computeDivergence(grid).max;
  const continuity = computeContinuityError(grid, plan).max;

  console.log(
    `[M1 identity, q != 0] raw max|div u| ${raw.toExponential(4)}   ` +
    `max|div u - q| ${continuity.toExponential(4)}   ` +
    `step() reported ${result.continuityError.toExponential(4)}`
  );

  // They differ by orders of magnitude, so "which one" is a real question.
  assert.ok(raw > 1, `the raw divergence should be about q here, got ${raw}`);
  assert.ok(continuity < params.divergenceTol);

  // And the identity holds against the continuity error, to floating point.
  assert.ok(
    Math.abs(result.continuityError - continuity) < 1e-12,
    `step() returned ${result.continuityError}, a direct scan gives ${continuity}`
  );
  // Not against the raw divergence, which is the thing this test exists to say.
  assert.ok(Math.abs(result.continuityError - raw) > 1);

  // With no source at all the two functions are the same function.
  const plain = new StaggeredGrid(n, n, h);
  plain.u[plain.idx(5, 5)] = 0.3;
  assert.deepEqual(computeContinuityError(plain, null), computeDivergence(plain));
  assert.deepEqual(
    computeContinuityError(plain, sourcePlanFor(plain, [])), computeDivergence(plain)
  );
});

test("M1 - divergence does not accumulate over a long run", () => {
  // The projection re-enforces incompressibility every step, so divergence
  // should sit at the tolerance indefinitely rather than creeping upward. If
  // it crept, the bound would be meaningless over a long integration.
  const setup = cavity(32, 400);
  const { grid, bc, params } = setup;
  let previousTimestep = null;
  const samples = [];
  let worst = 0;

  for (let n = 1; n <= 1200; n++) {
    const selection = computeStableTimestep(grid, {
      nu: params.nu, safety: 0.4, previousTimestep,
    });
    previousTimestep = selection.dt;
    const result = step(grid, bc, { ...params, dt: selection.dt });
    worst = Math.max(worst, result.continuityError);
    if (n % 400 === 0) samples.push(`step ${n}: ${result.continuityError.toExponential(2)}`);
  }

  console.log(`[M1 no drift] ${samples.join("   ")}   worst=${worst.toExponential(2)} (bound ${params.divergenceTol.toExponential(0)})`);
  assert.ok(worst <= params.divergenceTol, `divergence must stay within its bound, worst ${worst}`);
});
