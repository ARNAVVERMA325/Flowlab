// Regression test for non-finite propagation through the reporting path.
//
// This is not a physics test. It exists because the same bug class has now
// appeared twice, in two different places, both times producing a reassuring
// number from a field that had already blown up:
//
//   1. solver/ns2d.js computeDivergence used `if (a > max) max = a`. That
//      comparison is FALSE for NaN, so NaN was skipped and an entirely NaN
//      field reported a maximum divergence of exactly zero - and the Poisson
//      residual, written the same way, reported "converged".
//   2. The first fix replaced it with `if (!(a <= max)) max = a`, which looks
//      like it propagates NaN and does - but only when the NaN happens to be
//      the LAST value scanned. Any finite cell after it overwrites the NaN and
//      restores a healthy-looking maximum. Poisoning one interior face gave
//      max divergence 0 while rms was NaN.
//
// So the cases below deliberately poison cells EARLY in scan order, with many
// finite cells following, which is the ordering that defeated fix #2. A test
// that only poisons the last cell would pass against the broken version.
//
// The rule being locked down: a non-finite value must never be silently
// skipped, never be clamped to the end of a range, and never be replaced by a
// placeholder. It must survive all the way to what the panel prints.

import test from "node:test";
import assert from "node:assert/strict";

import { StaggeredGrid } from "../geometry/grid.js";
import { step, computeDivergence } from "../solver/ns2d.js";
import { inspectField } from "../physics/fieldStats.js";
import { sampleRamp, NON_FINITE_COLOUR } from "../visualization/colormap.js";
import { assessField, isUnprojectedInitialCondition } from "../ui/fieldHealth.js";
import { buildScenario } from "../scenarios/index.js";
import { exponential, fixed, integer, isBad } from "../ui/format.js";

const CLOSED_BOX = {
  left: { type: "wall" },
  right: { type: "wall" },
  top: { type: "wall" },
  bottom: { type: "wall" },
};

function movingField(n = 16) {
  const grid = new StaggeredGrid(n, n, 1 / n);
  for (let k = 0; k < grid.u.length; k++) {
    grid.u[k] = 0.4;
    grid.v[k] = 0.2;
  }
  return grid;
}

// The first fluid u-face in scan order, so everything after it is finite.
function poisonEarliestFace(grid, value) {
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i < grid.nx; i++) {
      if (!grid.solid[grid.idx(i, j)] && !grid.solid[grid.idx(i + 1, j)]) {
        grid.u[grid.idx(i, j)] = value;
        return { i, j };
      }
    }
  }
  throw new Error("no fluid face found");
}

test("regression - a healthy field still reports as healthy", () => {
  const grid = movingField();
  const inspection = inspectField(grid);
  const health = assessField(inspection);
  const divergence = computeDivergence(grid);

  assert.equal(inspection.finite, true);
  assert.equal(inspection.nonFiniteCells, 0);
  assert.equal(health.ok, true);
  assert.equal(health.halt, false);
  assert.ok(Number.isFinite(divergence.max), `expected finite divergence, got ${divergence.max}`);
  assert.ok(Number.isFinite(health.reportedPeakSpeed));
  console.log(
    `[healthy] finite=${inspection.finite} peak=${exponential(health.reportedPeakSpeed, 3)} ` +
    `divmax=${exponential(divergence.max, 2)} summary="${health.fieldSummary}"`
  );
});

// The ordering case. NaN goes in first; hundreds of finite cells follow.
for (const [label, poison] of [["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]]) {
  test(`regression - ${label} early in scan order is not overwritten by later finite cells`, () => {
    const grid = movingField();
    const where = poisonEarliestFace(grid, poison);
    const inspection = inspectField(grid);
    const divergence = computeDivergence(grid);

    console.log(
      `[${label} at (${where.i},${where.j})] divmax=${exponential(divergence.max, 2)} ` +
      `divrms=${exponential(divergence.rms, 2)} nonFinite=${inspection.nonFiniteCells}/${inspection.fluidCells}`
    );

    // The exact failure both previous versions produced: a finite, healthy
    // looking maximum computed over the cells that happened to survive.
    assert.ok(
      !Number.isFinite(divergence.max),
      `max divergence must not be reported as finite when the field is not, got ${divergence.max}`
    );
    assert.ok(
      !Number.isFinite(divergence.rms),
      `rms divergence must not be reported as finite, got ${divergence.rms}`
    );
    assert.notEqual(divergence.max, 0, "a broken field must never report zero divergence");
    assert.ok(divergence.nonFiniteCells > 0, "non-finite cells must be counted");

    assert.equal(inspection.finite, false);
    assert.ok(inspection.nonFiniteCells > 0);
  });
}

test("regression - the run halts and names the first bad cell", () => {
  const grid = movingField();
  const where = poisonEarliestFace(grid, NaN);
  const inspection = inspectField(grid);
  const health = assessField(inspection);

  console.log(`[halt] status=${health.status} message="${health.message}"`);

  assert.equal(health.ok, false);
  assert.equal(health.halt, true, "a non-finite field must halt the run, not warn");
  assert.equal(health.status, "failed");

  // The first bad cell must be identified, and it must be the first one in
  // scan order rather than whichever happened to be seen last.
  assert.notEqual(health.firstBadCell, null, "the first bad cell must be reported");
  assert.equal(health.firstBadCell.i, where.i);
  assert.equal(health.firstBadCell.j, where.j);
  assert.match(health.message, /not finite/);
  assert.match(
    health.message,
    new RegExp(`\\(${where.i}, ${where.j}\\)`),
    `the message must name the first bad cell, got "${health.message}"`
  );
});

test("regression - derived numbers are not quoted from the surviving cells", () => {
  const grid = movingField();
  poisonEarliestFace(grid, NaN);
  const inspection = inspectField(grid);
  const health = assessField(inspection);

  // inspectField still computes a range over the finite cells - the colour
  // scale needs one to draw anything at all - and that range is perfectly
  // finite. The point is that it must not reach the panel.
  assert.ok(
    Number.isFinite(inspection.maxSpeed),
    "inspectField should still expose a range over the surviving cells"
  );
  assert.ok(
    !Number.isFinite(health.reportedPeakSpeed),
    `the reported peak must not be the surviving cells' maximum (${inspection.maxSpeed})`
  );
  console.log(
    `[survivors] inspection.maxSpeed=${inspection.maxSpeed} but reported peak=${exponential(health.reportedPeakSpeed, 3)}`
  );
});

test("regression - non-finite speeds are not clamped onto the colour ramp", () => {
  const low = sampleRamp(0);
  const high = sampleRamp(1);

  for (const bad of [NaN, Infinity, -Infinity]) {
    const colour = sampleRamp(bad);
    assert.deepEqual(
      colour,
      NON_FINITE_COLOUR,
      `sampleRamp(${bad}) must return the non-finite colour, got ${JSON.stringify(colour)}`
    );
    // Clamping is how a broken cell acquires a legitimate-looking colour.
    assert.notDeepEqual(colour, low, `sampleRamp(${bad}) must not clamp to the bottom of the ramp`);
    assert.notDeepEqual(colour, high, `sampleRamp(${bad}) must not clamp to the top of the ramp`);
  }

  // Out-of-range but finite values SHOULD clamp - that is ordinary behaviour.
  assert.deepEqual(sampleRamp(-0.5), low);
  assert.deepEqual(sampleRamp(1.5), high);
  console.log(`[ramp] non-finite -> ${JSON.stringify(NON_FINITE_COLOUR)}, finite out-of-range clamps normally`);
});

test("regression - formatters never substitute a placeholder for a bad value", () => {
  for (const [value, expected] of [
    [NaN, "NaN"],
    [Infinity, "+Infinity"],
    [-Infinity, "-Infinity"],
  ]) {
    for (const [name, rendered] of [
      ["exponential", exponential(value, 2)],
      ["fixed", fixed(value, 3)],
      ["integer", integer(value)],
    ]) {
      assert.equal(rendered, expected, `${name}(${value}) should render "${expected}"`);
      // Must not be parseable as an ordinary number, and must not be a dash,
      // an empty string or a zero - all of which read as "fine" at a glance.
      assert.ok(Number.isNaN(Number(rendered)) || !Number.isFinite(Number(rendered)));
      assert.notEqual(rendered, "-");
      assert.notEqual(rendered, "");
      assert.notEqual(rendered, "0");
    }
    assert.equal(isBad(value), true, `isBad(${value}) must be true so the panel can flag it`);
  }
  assert.equal(isBad(0), false);
  assert.equal(isBad(1e-9), false);
  console.log(`[format] NaN -> "${exponential(NaN, 2)}", Infinity -> "${exponential(Infinity, 2)}"`);
});

test("regression - the pressure solve reports failure on a non-finite field", () => {
  const grid = movingField();
  poisonEarliestFace(grid, NaN);
  const result = step(grid, CLOSED_BOX, { nu: 1e-3, rho: 1, dt: 1e-3, divergenceTol: 1e-8 });

  console.log(
    `[poisson] converged=${result.poissonConverged} residual=${exponential(result.poissonResidual, 2)} ` +
    `iterations=${result.poissonIterations}`
  );

  assert.equal(
    result.poissonConverged,
    false,
    "the pressure solve must not report convergence on a non-finite field"
  );
  assert.ok(
    !Number.isFinite(result.poissonResidual),
    `the residual must not be reported as finite, got ${result.poissonResidual}`
  );
  // And it must give up rather than grinding to the iteration cap.
  assert.ok(result.poissonIterations < 100, `expected an early bail, took ${result.poissonIterations}`);
});

// ---------------------------------------------------------------------------
// "Not yet projected" must never excuse a real divergence failure
// ---------------------------------------------------------------------------
//
// The cylinder scenario seeds a uniform stream in every fluid cell, which is
// discontinuous across the obstacle: max|div u| reads 1.20e+1 at iteration 0.
// The panel labels that rather than showing it like a running measurement.
//
// The dangerous direction is the false positive. A label saying "this is just
// the initial condition" attached to a field that has actually been stepped
// would explain away exactly the failure the divergence readout exists to
// catch, so the rule is keyed on iteration 0 and not on the number looking
// large - a diverging run satisfies "looks large" too.

test("regression - an un-projected initial condition is distinguished from a failure", () => {
  const bound = 1e-7;

  // The real case: the cylinder's seeded stream, before any step.
  assert.equal(isUnprojectedInitialCondition(0, 12.0, bound), true);

  // The same number one step later is a divergence failure, not an excuse.
  assert.equal(isUnprojectedInitialCondition(1, 12.0, bound), false);
  assert.equal(isUnprojectedInitialCondition(500, 12.0, bound), false);

  // Scenarios whose seed IS divergence-free say nothing at all.
  assert.equal(isUnprojectedInitialCondition(0, 0, bound), false);
  assert.equal(isUnprojectedInitialCondition(0, bound, bound), false, "at the bound is not above it");

  // A non-finite field is a hard stop and belongs to assessField, which halts
  // the run. It must not be dressed up as an initial condition.
  assert.equal(isUnprojectedInitialCondition(0, NaN, bound), false);
  assert.equal(isUnprojectedInitialCondition(0, Infinity, bound), false);
});

test("regression - the cylinder is the case this rule was written for", () => {
  // Measured rather than asserted from memory, and measured through the same
  // builder the harness uses, so the rule cannot quietly stop applying to the
  // scenario that motivated it.
  const cylinder = buildScenario("cylinder");
  const divergence = computeDivergence(cylinder.grid);
  const bound = cylinder.params.divergenceTol;

  assert.ok(
    isUnprojectedInitialCondition(0, divergence.max, bound),
    `the cylinder's seeded field reads ${divergence.max.toExponential(3)}, which should be labelled`
  );

  // And it is genuinely fixed by stepping, which is what the note promises.
  for (let n = 0; n < 30; n++) {
    step(cylinder.grid, cylinder.bc, { ...cylinder.params, dt: 2e-3 });
  }
  const after = computeDivergence(cylinder.grid).max;
  assert.ok(after <= bound, `after 30 steps max|div u| is ${after.toExponential(3)}`);
  assert.equal(isUnprojectedInitialCondition(30, after, bound), false);
  console.log(
    `[polish] cylinder max|div u|: ${divergence.max.toExponential(3)} seeded -> ` +
    `${after.toExponential(3)} after 30 steps, against a bound of ${bound.toExponential(0)}`
  );
});
