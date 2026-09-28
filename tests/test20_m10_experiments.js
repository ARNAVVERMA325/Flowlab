// M10 - experiment mode.
//
// An experiment is a claim the app makes to a person: "we ran this, and here
// is what came out". So these tests go through the same objects the app uses -
// a SimulationSession driven by an ExperimentRunner - and check three things:
// that a run really ends the way it says it did (steady, capped, averaged,
// stopped, failed), that the parameter override behind a Reynolds sweep is
// the Reynolds number it claims to be, and that the sentences an experiment
// writes follow from its measurements rather than from what was expected.

import test from "node:test";
import assert from "node:assert/strict";

import { SimulationSession } from "../ui/session.js";
import { EXPERIMENTS, experimentById } from "../experiments/definitions.js";
import { ExperimentRunner, average } from "../experiments/runner.js";
import { bodyExtent, boundaryMeanPressure, primaryVortexCentre, wakeLength } from "../physics/features.js";
import { primaryVortexCentre as fromCavitySupport } from "./support/cavity.js";
import { PRIMARY_VORTEX_CENTRE } from "./support/ghia.js";
import { PRIMARY_VORTEX_CENTRE as fromValidation } from "../validation/ghia.js";
import { boundaryPlanFor } from "../solver/ns2d.js";
import { show } from "../ui/format.js";

// Drives a runner the way the harness does: step, then ask the runner.
function drive(runner, maxSteps = 200000) {
  runner.start();
  for (let n = 0; n < maxSteps && runner.state === "running"; n++) {
    runner.session.advance();
    runner.afterStep();
  }
  return runner;
}

// ---------------------------------------------------------------------------
// The Reynolds override
// ---------------------------------------------------------------------------

test("setReynolds sets nu = U*L/Re from the scenario's reference and survives a reset", () => {
  const session = new SimulationSession("cavity");
  const { U, L } = session.scenario.reference;
  const defaultNu = session.scenario.params.nu;
  assert.equal(session.scenario.defaultRe, 1000);

  session.setReynolds(100);
  assert.equal(session.scenario.params.nu, (U * L) / 100);
  assert.equal(session.scenario.Re, 100);
  assert.equal(session.scenario.defaultRe, 1000, "the scenario's own Re is still reported beside it");
  assert.equal(session.iteration, 0, "a new viscosity is a new problem: the field is rebuilt");

  for (let n = 0; n < 5; n++) session.advance();
  session.reset();
  assert.equal(session.scenario.params.nu, (U * L) / 100, "reset keeps the override");

  session.setReynolds(null);
  assert.equal(session.scenario.params.nu, defaultNu);
  assert.equal(session.scenario.Re, 1000);

  // The cavity's L is 1 (and so is the cylinder's D), which would hide a
  // missing L. The jet's is the inlet width, w/3.
  const jet = new SimulationSession("jet");
  const ref = jet.scenario.reference;
  assert.notEqual(ref.L, 1);
  jet.setReynolds(40);
  assert.ok(Math.abs(jet.scenario.params.nu - (ref.U * ref.L) / 40) < 1e-15);
  assert.ok(Math.abs((ref.U * ref.L) / jet.scenario.params.nu - 40) < 1e-9, "and that is Re 40");
});

test("setReynolds is the viscosity the solver actually steps with", () => {
  // A diffusion-limited timestep reads params.nu, so the override reaching the
  // solver shows up in the timestep the session picks.
  const low = new SimulationSession("cavity");
  low.setReynolds(10);
  low.advance();
  const high = new SimulationSession("cavity");
  high.setReynolds(1000);
  high.advance();
  assert.ok(low.lastTimestep < high.lastTimestep,
    `Re 10 must be diffusion-limited to a smaller dt: ${low.lastTimestep} vs ${high.lastTimestep}`);
});

test("setReynolds is cleared by loading a scenario, and refuses nonsense", () => {
  const session = new SimulationSession("cavity");
  session.setReynolds(400);
  session.load("cavity");
  assert.equal(session.scenario.Re, 1000, "a fresh load is the scenario as defined");
  for (const bad of [0, -5, NaN, Infinity, "400"]) {
    assert.throws(() => session.setReynolds(bad), RangeError, String(bad));
  }
  assert.equal(session.scenario.Re, 1000, "a refused value changes nothing");
});

test("setReynolds refuses a flow whose speed is set by its viscosity", () => {
  // In the pressure-driven channel U = dp*w^2/(12*mu*L): nu = U*L/Re would move
  // U too, and the flow would run at roughly Re^2/Re_default, not at Re.
  const session = new SimulationSession("pressure-channel");
  assert.throws(() => session.setReynolds(40), /no imposed speed/);
  assert.equal(session.scenario.Re, session.scenario.defaultRe);
});

// ---------------------------------------------------------------------------
// The change rate
// ---------------------------------------------------------------------------

test("changeRate is max|du|,|dv| over the last step divided by its dt", () => {
  const session = new SimulationSession("cavity");
  assert.equal(session.changeRate, Infinity, "no step taken: nothing is known to be steady");
  session.advance();
  session.advance();
  const before = { u: session.grid.u.slice(), v: session.grid.v.slice() };
  session.advance();
  let worst = 0;
  for (let k = 0; k < before.u.length; k++) {
    worst = Math.max(worst, Math.abs(session.grid.u[k] - before.u[k]), Math.abs(session.grid.v[k] - before.v[k]));
  }
  assert.equal(session.changeRate, worst / session.lastTimestep);
  session.reset();
  assert.equal(session.changeRate, Infinity);
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

function fakeExperiment(runs, conclude = (results) => ({ rows: [], summary: `${results.length} runs` })) {
  return { id: "fake", title: "fake", runs, conclude };
}

test("a run that reaches its steady criterion is recorded steady, with its measurement", () => {
  const pipe = experimentById("pipe");
  const runner = drive(new ExperimentRunner(pipe, new SimulationSession("cavity")));
  assert.equal(runner.state, "finished");
  const [run] = runner.results;
  assert.equal(run.steady, true);
  assert.ok(run.changeRate < 1e-4, `normalised rate ${run.changeRate}`);
  assert.ok(run.time < 60, "it stopped because it was steady, not at the cap");
  assert.equal(runner.session.scenarioId, "pressure-channel", "the runner loaded its own scenario");
  for (const row of runner.conclusion.rows) assert.equal(row.status, "agrees", `${row.quantity}: ${row.measured} vs ${row.reference}`);
});

test("a run that hits its cap is recorded NOT steady, and still measured", () => {
  const experiment = fakeExperiment([
    { label: "capped", scenario: "cavity", stop: { steady: 1e-12, maxTime: 0.05 }, measure: () => ({ measured: true }) },
  ]);
  const runner = drive(new ExperimentRunner(experiment, new SimulationSession("cavity")));
  assert.equal(runner.state, "finished");
  const [run] = runner.results;
  assert.equal(run.steady, false);
  assert.ok(run.time >= 0.05 && run.time < 0.05 + 0.05, `stopped at the cap, t = ${run.time}`);
  assert.deepEqual(run.measured, { measured: true });
});

test("an averaged run samples only inside its window, every Nth step, and reports mean and spread", () => {
  const seen = [];
  const experiment = fakeExperiment([
    {
      label: "window",
      scenario: "cavity",
      stop: { average: { from: 0.1, to: 0.4, every: 3 } },
      sample(session) {
        seen.push({ time: session.simulatedTime, iteration: session.iteration });
        return { t: session.simulatedTime };
      },
    },
  ]);
  const runner = drive(new ExperimentRunner(experiment, new SimulationSession("cavity")));
  const [run] = runner.results;
  assert.ok(seen.length >= 2, `sampled ${seen.length} times`);
  for (const s of seen) {
    assert.ok(s.time >= 0.1, `sample before the window at t = ${s.time}`);
    assert.equal(s.iteration % 3, 0);
  }
  assert.equal(run.sampleCount, seen.length);
  assert.equal(run.steady, undefined, "an averaged run makes no steadiness claim");
  const times = seen.map((s) => s.time);
  const mean = times.reduce((a, b) => a + b) / times.length;
  assert.ok(Math.abs(run.averaged.t.mean - mean) < 1e-15);
  assert.ok(run.averaged.t.spread > 0);
});

test("a multi-run experiment sets each run up afresh and concludes over all of them", () => {
  const loaded = [];
  const experiment = fakeExperiment([
    { label: "a", scenario: "cavity", Re: 100, stop: { steady: 1e-12, maxTime: 0.02 }, measure: (s) => s.scenario.Re },
    { label: "b", scenario: "cavity", Re: 400, stop: { steady: 1e-12, maxTime: 0.02 }, measure: (s) => s.scenario.Re },
  ]);
  const session = new SimulationSession("jet");
  const runner = new ExperimentRunner(experiment, session);
  const original = runner.onRunStart;
  runner.onRunStart = (run) => { loaded.push(run.label); original(run); };
  drive(runner);
  assert.deepEqual(loaded, ["a", "b"]);
  assert.deepEqual(runner.results.map((r) => r.measured), [100, 400]);
  assert.deepEqual(runner.results.map((r) => r.Re), [100, 400]);
  assert.ok(runner.results[1].steps < runner.results[0].steps * 3, "the second run started from rest, not from the first");
  assert.equal(runner.conclusion.summary, "2 runs");
});

test("stop() ends a run with nothing concluded, and afterStep() then does nothing", () => {
  const experiment = fakeExperiment([
    { label: "long", scenario: "cavity", stop: { steady: 1e-12, maxTime: 100 }, measure: () => 1 },
  ]);
  const runner = new ExperimentRunner(experiment, new SimulationSession("cavity")).start();
  runner.session.advance();
  assert.equal(runner.afterStep(), "continue");
  assert.equal(runner.stop(), "stopped");
  runner.session.advance();
  assert.equal(runner.afterStep(), "stopped");
  assert.equal(runner.conclusion, null);
  assert.deepEqual(runner.results, []);
});

test("a step that goes non-finite fails the run instead of finishing it", () => {
  // The solver refuses a non-finite field by throwing from the step (M1), so
  // a broken run never reaches afterStep() looking steady. The harness catches
  // that throw and calls fail(), which this does the same way.
  const experiment = fakeExperiment([
    { label: "doomed", scenario: "cavity", stop: { steady: 1e-12, maxTime: 100 }, measure: () => 1 },
  ]);
  const runner = new ExperimentRunner(experiment, new SimulationSession("cavity")).start();
  runner.session.advance();
  runner.afterStep();
  runner.session.grid.p.fill(NaN);
  let message = null;
  try {
    runner.session.advance();
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /non-finite/, "the step must refuse, not return");
  assert.equal(runner.fail(message), "failed");
  assert.equal(runner.afterStep(), "failed", "nothing continues after a failure");
  assert.equal(runner.conclusion, null, "nothing is measured from a broken field");
  assert.deepEqual(runner.results, []);
});

test("progress() is bounded by simulated time and covers the runs in order", () => {
  const experiment = fakeExperiment([
    { label: "a", scenario: "cavity", stop: { steady: 1e-12, maxTime: 1 }, measure: () => 1 },
    { label: "b", scenario: "cavity", stop: { average: { from: 0.5, to: 1 } }, sample: () => ({ x: 1 }) },
  ]);
  const runner = new ExperimentRunner(experiment, new SimulationSession("cavity")).start();
  const first = runner.progress();
  assert.equal(first.run, 1);
  assert.equal(first.fraction, 0);
  assert.equal(first.target, 1e-12);
  runner.runIndex = 1;
  const second = runner.progress();
  assert.equal(second.fraction, 0.5, "run 2 of 2 at t = 0 is half way");
  assert.equal(second.target, null);
  assert.equal(second.sampling, false);
});

test("average() gives the mean and population spread, and counts what it used", () => {
  const out = average([{ a: 1, b: NaN }, { a: 3, b: 2 }]);
  assert.deepEqual(out.a, { mean: 2, spread: 1, count: 2 });
  assert.deepEqual(out.b, { mean: 2, spread: 0, count: 1 }, "a NaN sample is not averaged in, and the count says so");
  assert.deepEqual(average([]), {});
});

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

test("every experiment is well formed and names only scenarios that exist", () => {
  const ids = new Set();
  for (const experiment of EXPERIMENTS) {
    assert.ok(!ids.has(experiment.id), `duplicate id ${experiment.id}`);
    ids.add(experiment.id);
    assert.equal(experimentById(experiment.id), experiment);
    for (const key of ["title", "question", "method", "reference"]) assert.ok(experiment[key], `${experiment.id}.${key}`);
    for (const run of experiment.runs) {
      const session = new SimulationSession(run.scenario);
      if (run.Re !== undefined) session.setReynolds(run.Re);
      const stop = run.stop;
      if (stop.steady !== undefined) {
        assert.ok(stop.maxTime > 0, `${run.label}: a steady run needs a cap`);
        assert.equal(typeof run.measure, "function");
      } else {
        assert.ok(stop.average.to > stop.average.from, run.label);
        assert.equal(typeof run.sample, "function");
      }
    }
  }
  assert.equal(experimentById("nope"), null);
});

test("the sweep compares against the verified Ghia table the M2 test uses", () => {
  assert.equal(PRIMARY_VORTEX_CENTRE, fromValidation, "one table, re-exported - not a copy");
  assert.equal(fromCavitySupport, primaryVortexCentre, "one measurement, re-exported");
  const sweep = experimentById("sweep");
  for (const run of sweep.runs) assert.ok(PRIMARY_VORTEX_CENTRE[run.Re], `Ghia has Re ${run.Re}`);
});

// Conclusions are sentences a person reads as findings. Each one that states
// a direction must be written from the numbers - so feed each the opposite of
// what is expected and check the sentence turns round with it.
test("the cylinder summary says what the wake did, including when it did not grow", () => {
  const cylinder = experimentById("cylinder");
  const run = (Re, lengthOverD) => ({ measured: { Re, lengthOverD, separated: true, blockage: 0.18, D: 0.18 } });
  assert.match(cylinder.conclude([run(20, 0.75), run(40, 1.75)]).summary, /grew from 0\.75 to 1\.75/);
  assert.match(cylinder.conclude([run(20, 1.2), run(40, 0.9)]).summary, /did NOT grow/);
  const none = cylinder.conclude([{ measured: { Re: 20, lengthOverD: NaN, separated: false, blockage: 0.18 } }, run(40, 1)]);
  assert.match(none.summary, /No separation bubble was found at Re 20/);
  assert.equal(none.rows[0].status, "not measured");
});

test("the bend summary credits the radius only when the measurements do", () => {
  const bends = experimentById("bends");
  const avg = (pressureDrop, separations) => ({
    averaged: {
      pressureDrop: { mean: pressureDrop, spread: 0.1 },
      peakSpeed: { mean: 2, spread: 0.1 },
      separations: { mean: separations, spread: 1 },
      rotating: { mean: 0.2, spread: 0.01 },
    },
  });
  const expected = bends.conclude([avg(1.55, 6.3), avg(1.17, 0.6)]);
  assert.match(expected.summary, /25% less pressure/);
  assert.match(expected.summary, /what the radius removes/);
  const reversed = bends.conclude([avg(1.55, 0.6), avg(1.17, 6.3)]);
  assert.match(reversed.summary, /did NOT reduce separation/);
  assert.doesNotMatch(reversed.summary, /radius removes/);
  assert.match(bends.conclude([avg(1.0, 6), avg(1.2, 1)]).summary, /did NOT come out cheaper/);
});

test("the sweep summary describes the motion it measured, not Ghia's", () => {
  const sweep = experimentById("sweep");
  const run = (Re, x, y) => ({ measured: { Re, x, y, h: 1 / 64, ghia: PRIMARY_VORTEX_CENTRE[Re], distance: 0 } });
  const ghiaLike = sweep.conclude([run(100, 0.617, 0.742), run(400, 0.555, 0.61), run(1000, 0.53, 0.56)]);
  assert.match(ghiaLike.summary, /moved down and towards the middle/);
  const wandering = sweep.conclude([run(100, 0.5, 0.6), run(400, 0.7, 0.8), run(1000, 0.4, 0.5)]);
  assert.match(wandering.summary, /did not move steadily/);
  const far = sweep.conclude([run(100, 0.9, 0.2), run(400, 0.555, 0.61), run(1000, 0.53, 0.56)]);
  assert.equal(far.rows[0].status, "agrees", "distance is what the row reads - here fed as 0");
});

// ---------------------------------------------------------------------------
// physics/features.js
// ---------------------------------------------------------------------------

test("bodyExtent finds the cylinder the scenario placed, and wakeLength measures behind it", () => {
  const session = new SimulationSession("cylinder");
  const { grid } = session;
  const body = bodyExtent(grid);
  const D = session.scenario.reference.L;
  assert.ok(Math.abs(body.width - D) <= 2 * grid.h, `width ${body.width} vs D ${D}`);
  assert.ok(Math.abs(body.height - D) <= 2 * grid.h, `height ${body.height} vs D ${D}`);
  const ymid = (body.y0 + body.y1) / 2;
  assert.ok(Math.abs((body.row - 0.5) * grid.h - ymid) <= grid.h, "the row runs through the middle of the body");
  // At rest there is no reversed flow, so no bubble.
  const wake = wakeLength(grid, { row: body.row, rear: body.x1, D: body.height });
  assert.equal(wake.separated, false);
});

test("bodyExtent of an empty domain is null rather than a zero-sized body", () => {
  const session = new SimulationSession("cavity");
  assert.equal(bodyExtent(session.grid), null);
});

test("boundaryMeanPressure reads the pressure the pressure channel prescribes", () => {
  const session = new SimulationSession("pressure-channel");
  for (let n = 0; n < 50; n++) session.advance();
  const plan = boundaryPlanFor(session.grid, session.bc);
  // Both ends are "pressure" boundaries, 3.6 and 0, and the pressure falls
  // linearly between them - so the first and last cell columns, together,
  // average to the midpoint, and there is one cell per row at each end.
  const ends = boundaryMeanPressure(session.grid, plan, "pressure");
  const dp = session.bc.left.p - session.bc.right.p;
  assert.equal(ends.cells, 2 * session.grid.ny);
  assert.ok(Math.abs(ends.mean - dp / 2) < 0.02 * dp, `mean ${ends.mean} vs ${dp / 2}`);
  assert.equal(boundaryMeanPressure(session.grid, plan, "inflow").cells, 0);
  assert.ok(Number.isNaN(boundaryMeanPressure(session.grid, plan, "inflow").mean), "no cells is NaN, not 0");
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test("show() keeps four significant figures, passes text through and never hides a bad value", () => {
  assert.equal(show(1.0033), "1.003");
  assert.equal(show(1), "1.000");
  assert.equal(show(0.30100), "0.3010");
  assert.equal(show(0.0017274), "0.001727");
  assert.equal(show(123456), "1.235e+5");
  assert.equal(show(0), "0");
  assert.equal(show("(0.617, 0.742)"), "(0.617, 0.742)");
  assert.equal(show(NaN), "NaN");
  assert.equal(show(-Infinity), "-Infinity");
});
