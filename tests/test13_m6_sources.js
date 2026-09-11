// M6 steps 1-2 - the source model, the compiler, and momentum sources.
//
// The milestone splits sources in two because they enter different equations:
// a momentum source is a body force and cannot make the pressure problem
// unsolvable; a mass source makes div u = q by design and can. Steps 1-2 build
// the model for both and apply only the first. Mass sources are REFUSED by the
// solver rather than ignored, which is what these tests pin - a compiled source
// that silently did nothing is the failure this codebase keeps finding.
//
// Two bars carried over from M4 and M5:
//
//   1. Byte-identity. Nothing here may move a field that has no sources. The
//      golden fixtures are the check, not a tolerance.
//   2. A selection that catches nothing is an error, not a no-op.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { StaggeredGrid } from "../geometry/grid.js";
import { applyDocument, testRegion } from "../geometry/document.js";
import { step, computeDivergence, computeContinuityError } from "../solver/ns2d.js";
import { compileSources, sourcePlanFor, sourceLegend } from "../sources/compile.js";
import { SOURCE_KINDS, SourceSpecError, describeSource, validateSource } from "../sources/kinds.js";
import {
  computeStableTimestep, peakCellSpeed, assertTimestepIsStable,
} from "../solver/stability.js";
import { FIXTURE_CASES, measureFixtureCase } from "./support/boundaryFixtures.js";
import { buildScenario } from "../scenarios/index.js";
import { SimulationSession } from "../ui/session.js";
import { BrushController, combineSources } from "../ui/brush.js";
import { PassiveTracer, MAX_CONCENTRATION } from "../tracer/passiveScalar.js";
import { dyeSourcesFor, injectSourceDye } from "../tracer/sourceDye.js";

const GOLDEN = JSON.parse(
  readFileSync(new URL("./fixtures/golden-fields.json", import.meta.url), "utf8")
);

function captureThrow(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

const BOX = {
  left: { type: "wall" }, right: { type: "wall" },
  top: { type: "wall" }, bottom: { type: "wall" },
};

function stillBox({ n = 24, nu = 0.01 } = {}) {
  const h = 1 / n;
  const grid = new StaggeredGrid(n, n, h);
  return {
    grid, h,
    params: {
      nu, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / nu, h / 4),
      divergenceTol: 1e-7, poissonMaxIterations: 20000,
    },
  };
}

const middleBand = { kind: "rect", x0: 0.3, y0: 0.4, x1: 0.7, y1: 0.6 };

// ---------------------------------------------------------------------------
// Step 1 - the model
// ---------------------------------------------------------------------------

test("M6 - a source states every quantity it prescribes, with no defaults", () => {
  const rejected = [
    [{ kind: "momentum", where: middleBand, v: 0, relaxationTime: 0.1 }, /"u" must be a finite number/],
    [{ kind: "momentum", where: middleBand, u: 1, relaxationTime: 0.1 }, /"v" must be a finite number/],
    [{ kind: "momentum", where: middleBand, u: 1, v: 0 }, /"relaxationTime" must be a finite number/],
    [{ kind: "momentum", where: middleBand, u: 1, v: 0, relaxationTime: 0 }, /relaxationTime must be positive/],
    [{ kind: "momentum", where: middleBand, u: 1, v: 0, relaxationTime: -1 }, /relaxationTime must be positive/],
    [{ kind: "momentum", u: 1, v: 0, relaxationTime: 0.1 }, /needs a "where" region/],
    [{ kind: "mass", where: middleBand }, /"rate" must be a finite number/],
    [{ kind: "mass", where: middleBand, rate: 0 }, /does nothing/],
    [{ kind: "vortex", where: middleBand }, /unknown source kind/],
    [{ kind: "momentum", where: { kind: "blob" }, u: 1, v: 0, relaxationTime: 0.1 }, /unknown shape/],
    [null, /expected a source object/],
  ];
  for (const [source, pattern] of rejected) {
    const error = captureThrow(() => validateSource(source));
    assert.ok(error, `should have rejected ${JSON.stringify(source)}`);
    assert.match(error.message, pattern);
  }
  console.log(`[M6 model] ${rejected.length} malformed sources rejected with reasons`);
});

test("M6 - both velocity components are required even when one is zero", () => {
  // A source naming only `u` would have to decide silently whether it leaves v
  // alone or drives it to zero. Both readings are defensible, which is exactly
  // why it has to be written down.
  assert.ok(captureThrow(() => validateSource(
    { kind: "momentum", where: middleBand, u: 1, relaxationTime: 0.1 }
  )));
  assert.equal(validateSource(
    { kind: "momentum", where: middleBand, u: 1, v: 0, relaxationTime: 0.1 }
  ).v, 0);
});

test("M6 - sources are sampled where the quantity they drive actually lives", () => {
  // On a staggered grid u faces sit at (i*h, (j-0.5)*h) and v faces at
  // ((i-0.5)*h, j*h) - offset by half a cell in DIFFERENT directions. A source
  // sampled at cell centres and applied to faces would be half a cell out
  // everywhere, which looks like slightly sloppy placement rather than a bug.
  //
  // Checked against the sample positions directly rather than against a count,
  // so the assertion is the rule itself.
  const { grid } = stillBox({ n: 20 });
  const where = { kind: "disk", cx: 0.5, cy: 0.5, radius: 0.17, metric: "squared", closed: true };
  const plan = compileSources(grid, [
    { kind: "momentum", where, u: 1, v: 0, relaxationTime: 0.1 },
  ]);

  const claimedU = [];
  const claimedV = [];
  const expectedU = [];
  const expectedV = [];
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx - 1; i++) {
      const k = grid.idx(i, j);
      if (plan.momentum.u[k] >= 0) claimedU.push(`${i},${j}`);
      if (testRegion(where, i * grid.h, (j - 0.5) * grid.h)) expectedU.push(`${i},${j}`);
    }
  }
  for (let i = 1; i <= grid.nx; i++) {
    for (let j = 1; j <= grid.ny - 1; j++) {
      const k = grid.idx(i, j);
      if (plan.momentum.v[k] >= 0) claimedV.push(`${i},${j}`);
      if (testRegion(where, (i - 0.5) * grid.h, j * grid.h)) expectedV.push(`${i},${j}`);
    }
  }

  assert.ok(expectedU.length > 0 && expectedV.length > 0);
  assert.deepEqual(claimedU.sort(), expectedU.sort(), "u faces are sampled at x = i*h");
  assert.deepEqual(claimedV.sort(), expectedV.sort(), "v faces are sampled at y = j*h");

  // And the two sets are genuinely different, which is what proves one sample
  // position is not being used for both. A disk centred on a cell corner is
  // symmetric under the swap, so the index SETS coincide - the positions do
  // not, and swapping them would move every face half a cell.
  const asCellCentres = [];
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx - 1; i++) {
      if (testRegion(where, (i - 0.5) * grid.h, (j - 0.5) * grid.h)) asCellCentres.push(`${i},${j}`);
    }
  }
  assert.notDeepEqual(
    claimedU.slice().sort(), asCellCentres.sort(),
    "sampling u faces at cell centres would have given a different set - it does not here, " +
    "so this test would not catch the mistake"
  );
  console.log(
    `[M6 model] disk source: ${claimedU.length} u faces at x=i*h, ${claimedV.length} v faces ` +
    `at y=j*h, against ${asCellCentres.length} had they been sampled at cell centres`
  );
});

test("M6 - a selection that catches nothing is refused, not quietly ignored", () => {
  const { grid } = stillBox({ n: 20 });
  // A solid block, so a source can be placed inside it.
  applyDocument(grid, {
    operations: [{ op: "add", region: { kind: "rect", x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 } }],
  });

  const insideTheWall = { kind: "rect", x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 };
  for (const source of [
    { kind: "momentum", where: insideTheWall, u: 1, v: 0, relaxationTime: 0.1 },
    { kind: "mass", where: insideTheWall, rate: 0.1 },
  ]) {
    const error = captureThrow(() => compileSources(grid, [source]));
    assert.ok(error, `${source.kind} inside a wall should be refused`);
    assert.equal(error.name, "SourceSpecError");
    assert.equal(error.reason, "empty-selection");
    assert.match(error.message, /selects no .* at all/);
  }

  // Off the domain entirely, on a grid with no solid at all.
  const clean = stillBox({ n: 20 }).grid;
  const outside = { kind: "rect", x0: 5, y0: 5, x1: 6, y1: 6 };
  assert.equal(
    captureThrow(() => compileSources(clean, [
      { kind: "momentum", where: outside, u: 1, v: 0, relaxationTime: 0.1 },
    ]))?.reason,
    "empty-selection"
  );
  console.log(`[M6 model] sources selecting no updatable face or cell are refused`);
});

test("M6 - a region catching one face family but not the other is refused", () => {
  // The half-applied case, and it is not hypothetical: a strip a quarter of a
  // cell wide, centred on the column of u faces at x = 0.5, catches twelve of
  // them and not one v face, because the v faces on that row sit at x = 0.475
  // and 0.525. A source like that would drive u and silently abandon v - the
  // same shape of half-applied condition this codebase keeps finding, one level
  // down. It has to name which family found nothing.
  const { grid, h } = stillBox({ n: 20 });
  const onUFacesOnly = { kind: "rect", x0: 0.5 - h / 4, y0: 0.2, x1: 0.5 + h / 4, y1: 0.8 };

  // First: the strip really does catch one family and not the other.
  let uHits = 0;
  let vHits = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx - 1; i++) {
      if (testRegion(onUFacesOnly, i * h, (j - 0.5) * h)) uHits++;
    }
  }
  for (let i = 1; i <= grid.nx; i++) {
    for (let j = 1; j <= grid.ny - 1; j++) {
      if (testRegion(onUFacesOnly, (i - 0.5) * h, j * h)) vHits++;
    }
  }
  assert.ok(uHits > 0 && vHits === 0, `expected a one-sided strip, got ${uHits} u and ${vHits} v`);

  const error = captureThrow(() => compileSources(grid, [
    { kind: "momentum", where: onUFacesOnly, u: 1, v: 0, relaxationTime: 0.1 },
  ]));
  assert.ok(error, "a strip catching only u faces should be refused");
  assert.equal(error.reason, "empty-selection");
  assert.match(error.message, /no y-velocity faces/);
  assert.match(error.message, /offset by half a cell/);
  console.log(
    `[M6 model] a quarter-cell strip on x = 0.5 catches ${uHits} u faces and ${vHits} v faces, ` +
    `and is refused rather than driving one component only`
  );
});

test("M6 - identical sources share one table row; a new field does not collide", () => {
  // The M4 lesson: the dedup key is built from every property, sorted. A
  // hand-written field list merged two different pressure boundaries into one
  // and produced a channel with the same pressure at both ends and exactly zero
  // flow, converging in four iterations with nothing that looked wrong.
  const { grid } = stillBox({ n: 20 });
  const a = { kind: "rect", x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 };
  const b = { kind: "rect", x0: 0.6, y0: 0.6, x1: 0.9, y1: 0.9 };

  const same = compileSources(grid, [
    { kind: "momentum", where: a, u: 1, v: 0, relaxationTime: 0.1 },
    { kind: "momentum", where: b, u: 1, v: 0, relaxationTime: 0.1 },
  ]);
  assert.equal(same.momentum.table.length, 1, "identical drives share a row");

  const different = compileSources(grid, [
    { kind: "momentum", where: a, u: 1, v: 0, relaxationTime: 0.1 },
    { kind: "momentum", where: b, u: 1, v: 0, relaxationTime: 0.2 },
  ]);
  assert.equal(different.momentum.table.length, 2, "a differing relaxationTime is a different drive");
});

test("M6 - a mass source's rate is a total, spread over the cells it caught", () => {
  // Same convention as M4's flowInlet, which spreads a requested flow rate over
  // the faces it covers, so the two read alike.
  const { grid, h } = stillBox({ n: 20 });
  const where = { kind: "rect", x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 };
  const plan = compileSources(grid, [{ kind: "mass", where, rate: 0.5 }]);
  const cells = plan.attachments[0].cells;
  const row = plan.mass.table[0];
  assert.ok(cells > 0);
  assert.ok(Math.abs(row.q * cells * h * h - 0.5) < 1e-15, "the integral of q is the requested rate");
  console.log(`[M6 model] rate 0.5 over ${cells} cells -> q = ${row.q.toFixed(6)} per cell`);
});

test("M6 - a compiled plan is reused, and refused on a grid it does not fit", () => {
  const { grid } = stillBox({ n: 20 });
  const spec = [{ kind: "momentum", where: middleBand, u: 1, v: 0, relaxationTime: 0.1 }];
  const first = sourcePlanFor(grid, spec);
  assert.equal(sourcePlanFor(grid, spec), first, "the same specification compiles once");

  // The selection depends on the mask, so a geometry edit must invalidate it.
  applyDocument(grid, { operations: [] });
  assert.notEqual(sourcePlanFor(grid, spec), first, "a mask change recompiles");

  const other = new StaggeredGrid(10, 10, 0.1);
  assert.ok(captureThrow(() => sourcePlanFor(other, first)), "a plan is not portable between grids");
  assert.equal(sourcePlanFor(grid, null).momentum, null, "no sources compiles to nothing");
});

test("M6 - the legend describes what was compiled, not what was asked for", () => {
  const { grid } = stillBox({ n: 20 });
  const spec = [
    { kind: "momentum", where: middleBand, u: 1, v: 0, relaxationTime: 0.1, label: "jet" },
    { kind: "mass", where: middleBand, rate: 0.2 },
  ];
  const legend = sourceLegend(compileSources(grid, spec), spec);
  assert.equal(legend.length, 2);
  assert.equal(legend[0].label, "jet");
  assert.ok(legend[0].uFaces > 0 && legend[0].vFaces > 0);
  assert.ok(legend[1].cells > 0);
  assert.match(describeSource(spec[0]), /^jet - drives to \(1, 0\)/);
  assert.match(describeSource(spec[1]), /^Mass source: injects 0\.2/);
});

// ---------------------------------------------------------------------------
// Step 2 - momentum sources in the solver
// ---------------------------------------------------------------------------

test("M6 - the golden fields are byte-identical with the source path in place", () => {
  // The M4 refactor bar. None of these fixtures has a source, so none of them
  // may move by a single bit: the branch has to be a branch, not an extra
  // "+ 0" that happens to be harmless today.
  const changed = [];
  let compared = 0;
  for (const entry of FIXTURE_CASES) {
    if (entry.invalid) continue;
    const expected = GOLDEN.cases[entry.id];
    if (!expected) continue;
    const actual = measureFixtureCase(entry);
    compared++;
    for (const field of ["u", "v", "p"]) {
      if (actual[field] !== expected[field]) {
        changed.push(`${entry.id}.${field}: ${expected[field].slice(0, 16)} -> ${actual[field].slice(0, 16)}`);
      }
    }
  }
  assert.deepEqual(changed, [], `sources moved a field that has none:\n${changed.join("\n")}`);
  console.log(`[M6 step 2] ${compared} golden cases byte-identical with the source path compiled in`);
});

test("M6 - a momentum source drives the fluid toward its target", () => {
  const { grid, params } = stillBox();
  const sources = [{ kind: "momentum", where: middleBand, u: 1, v: 0, relaxationTime: 0.05 }];
  const withSources = { ...params, sources };

  const before = computeDivergence(grid).max;
  assert.equal(before, 0, "still water starts divergence-free");

  for (let n = 0; n < 400; n++) step(grid, BOX, withSources);

  let peak = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) peak = Math.max(peak, Math.abs(grid.u[grid.idx(i, j)]));
  }
  assert.ok(peak > 0.1, `the source should have moved the fluid, peak |u| is ${peak}`);

  // And the projection still delivers its bound: a body force adds no mass, so
  // whatever divergence it creates is removed like advection's.
  const divergence = computeDivergence(grid).max;
  assert.ok(
    divergence <= params.divergenceTol,
    `max|div u| is ${divergence.toExponential(3)} against ${params.divergenceTol}`
  );
  console.log(
    `[M6 step 2] momentum source in still water: peak |u| ${peak.toFixed(4)}, ` +
    `max|div u| ${divergence.toExponential(2)}`
  );
});

test("M6 - the source's own contribution cannot carry a face past its target", () => {
  // The whole reason the brush is a relaxation and not a raw force. The change
  // a source makes in one step is exactly alpha * (target - u) with alpha in
  // (0, 1], so it lands between the current velocity and the target - never
  // beyond it, at any timestep and any relaxation time.
  //
  // Checked including the case the clamp exists for: a relaxation time far
  // SHORTER than the timestep, where an unclamped force would overshoot wildly.
  for (const relaxationTime of [1e-6, 1e-3, 0.05, 10]) {
    const { grid, params } = stillBox();
    const target = 1;
    const sources = [{ kind: "momentum", where: middleBand, u: target, v: 0, relaxationTime }];
    let worst = 0;
    for (let n = 0; n < 200; n++) {
      step(grid, BOX, { ...params, sources });
      for (let j = 1; j <= grid.ny; j++) {
        for (let i = 1; i <= grid.nx; i++) worst = Math.max(worst, grid.u[grid.idx(i, j)]);
      }
    }
    // The projection redistributes momentum, so the peak anywhere in the domain
    // is not bounded by the target - but it must not run away, which an
    // unbounded force at tau << dt certainly would.
    assert.ok(Number.isFinite(worst), `tau = ${relaxationTime} produced a non-finite field`);
    assert.ok(
      worst < 2 * target,
      `tau = ${relaxationTime}: peak u reached ${worst}, which is not a bounded response to a target of ${target}`
    );
  }
  console.log(`[M6 step 2] relaxation stays bounded across tau from 1e-6 to 10 (dt is ~1e-3)`);
});

test("M6 - alpha clamps at 1, so a very fast source snaps rather than overshooting", () => {
  // One step, measured directly: with tau far below dt the face should land ON
  // the target, not past it.
  const { grid, params } = stillBox();
  const target = 0.5;
  const sources = [{ kind: "momentum", where: middleBand, u: target, v: 0, relaxationTime: 1e-9 }];
  step(grid, BOX, { ...params, sources });

  const plan = sourcePlanFor(grid, sources);
  let maxDriven = 0;
  let count = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx - 1; i++) {
      const k = grid.idx(i, j);
      if (plan.momentum.u[k] < 0) continue;
      count++;
      maxDriven = Math.max(maxDriven, grid.u[k]);
    }
  }
  assert.ok(count > 0);
  // The projection has since altered these faces, so this is not an equality -
  // what matters is that one step did not launch them past the target.
  assert.ok(maxDriven <= target * 1.001, `a driven face reached ${maxDriven} in one step`);
  console.log(`[M6 step 2] tau = 1e-9, one step: peak driven face ${maxDriven.toFixed(6)} against a target of ${target}`);
});

// ---------------------------------------------------------------------------
// Step 3 - mass sources
// ---------------------------------------------------------------------------
//
// Four configurations, demonstrated before any of this was designed. Two must
// run and two must be refused, and the pair that separates them is A and B:
// identical sources, differing only in whether the region has an outlet. Before
// the flux balance counted interior sources both reported a forced divergence
// of 5.000e-2 and both were rejected - the detector was right that the region
// was unbalanced, and the imbalance was the flux balance's own.

const OPEN = { ...BOX, right: { type: "outflow" } };
const leftSpot = { kind: "rect", x0: 0.1, y0: 0.4, x1: 0.25, y1: 0.6 };
const rightSpot = { kind: "rect", x0: 0.75, y0: 0.4, x1: 0.9, y1: 0.6 };
// Wide enough to catch cell centres at n = 24: they sit at 0.47917 and 0.52083.
const DIVIDER = {
  operations: [{ op: "add", region: { kind: "rect", x0: 0.46, y0: 0, x1: 0.54, y1: 1 } }],
};

function runMass({ bc, geometry = null, sources, steps = 60, n = 24 }) {
  const { grid, params } = stillBox({ n });
  if (geometry) applyDocument(grid, geometry);
  const plan = sourcePlanFor(grid, sources);
  let error = null;
  let completed = 0;
  try {
    for (; completed < steps; completed++) step(grid, bc, { ...params, sources });
  } catch (e) { error = e; }
  return { grid, params, plan, error, completed };
}

test("M6 - a mass source in a region with an outlet runs, and delivers its rate", () => {
  const rate = 0.05;
  const { grid, params, plan, error, completed } = runMass({
    bc: OPEN, sources: [{ kind: "mass", where: middleBand, rate }], steps: 200,
  });
  assert.equal(error, null, `should have run: ${error?.message}`);
  assert.equal(completed, 200);

  // Continuity holds against what was asked for.
  const continuity = computeContinuityError(grid, plan).max;
  assert.ok(continuity <= params.divergenceTol, `continuity error ${continuity.toExponential(3)}`);

  // The raw divergence is exactly what the source imposes, on purpose - taken
  // from the plan rather than compared against a constant, which would only be
  // calibrated to one region size.
  const raw = computeDivergence(grid).max;
  const q = plan.mass.table[0].q;
  assert.ok(
    Math.abs(raw - q) < 1e-6,
    `the raw divergence should be the imposed q of ${q}, got ${raw.toExponential(3)}`
  );
  // And the two numbers this milestone had to separate differ by seven orders
  // of magnitude, so which one the panel shows is not a fine distinction.
  assert.ok(raw / continuity > 1e6);

  // And the volume asked for is the volume that leaves.
  let outflow = 0;
  for (let j = 1; j <= grid.ny; j++) outflow += grid.u[grid.idx(grid.nx, j)] * grid.h;
  assert.ok(Math.abs(outflow - rate) < 1e-11, `asked ${rate}, delivered ${outflow}`);

  console.log(
    `[M6 step 3] A: source in an open box - continuity ${continuity.toExponential(2)}, ` +
    `raw max|div u| ${raw.toExponential(3)} (= imposed q), ` +
    `delivered ${outflow.toFixed(12)} against ${rate}`
  );
});

test("M6 - a mass source in a sealed region is refused, naming the region", () => {
  const { error } = runMass({ bc: BOX, sources: [{ kind: "mass", where: middleBand, rate: 0.05 }] });
  assert.ok(error, "a sealed region cannot absorb a source and must be refused");
  assert.equal(error.name, "SolverGeometryError");
  assert.equal(error.reason, "unsolvable-region");
  assert.equal(error.regions.length, 1);

  // The detector's number is exactly the source rate per unit area of the
  // region, which is what makes it readable rather than a magic threshold.
  const forced = error.regions[0].forcedDivergence;
  assert.ok(Math.abs(forced - 0.05 / 1) < 1e-9, `forcedDivergence ${forced} against rate/area 0.05`);
  console.log(
    `[M6 step 3] B: source in a sealed box refused - forcedDivergence ` +
    `${forced.toExponential(4)} = rate/area`
  );
});

test("M6 - a source and an equal sink in one sealed region run", () => {
  const { grid, params, plan, error } = runMass({
    bc: BOX,
    sources: [
      { kind: "mass", where: leftSpot, rate: 0.05 },
      { kind: "mass", where: rightSpot, rate: -0.05 },
    ],
  });
  assert.equal(error, null, `the books balance, so this must run: ${error?.message}`);
  const continuity = computeContinuityError(grid, plan).max;
  assert.ok(continuity <= params.divergenceTol, `continuity error ${continuity.toExponential(3)}`);
  console.log(
    `[M6 step 3] C: +0.05 and -0.05 in one sealed box - continuity ` +
    `${continuity.toExponential(2)}, raw max|div u| ${computeDivergence(grid).max.toExponential(3)}`
  );
});

test("M6 - a source and sink in DIFFERENT sealed regions are refused", () => {
  // Globally the books balance and locally they do not, which is the whole
  // reason the balance is per region rather than over the domain.
  const { error } = runMass({
    bc: BOX, geometry: DIVIDER,
    sources: [
      { kind: "mass", where: leftSpot, rate: 0.05 },
      { kind: "mass", where: rightSpot, rate: -0.05 },
    ],
  });
  assert.ok(error, "a globally-zero pair in two sealed chambers must still be refused");
  assert.equal(error.name, "SolverGeometryError");
  assert.equal(error.reason, "unsolvable-region");
  assert.equal(error.regions.length, 2, "both chambers are unbalanceable, not just one");
  console.log(
    `[M6 step 3] D: source and sink either side of a wall refused - ` +
    `${error.regions.map((r) => `region ${r.region} forces ${r.forcedDivergence.toExponential(3)}`).join(", ")}`
  );
});

test("M6 - an unsolvable mass source is refused at every meaningful bound", () => {
  // M5's sealed regions were benign - they ran perfectly well and were reported
  // rather than refused. An unsolvable mass source is not: measured with every
  // guard removed, the split-chamber case reaches max|div u| = 1.5e+6 and the
  // field is destroyed within one step.
  //
  // The detector's threshold IS divergenceTol, so "meaningful" has a precise
  // meaning here: a bound tighter than the divergence the configuration forces
  // (1.091e-1 per chamber). Below that it is refused, either by the solvability
  // check or, once that passes, by the divergence bound behind it.
  const { grid, params } = stillBox();
  const sources = [
    { kind: "mass", where: leftSpot, rate: 0.05 },
    { kind: "mass", where: rightSpot, rate: -0.05 },
  ];
  const seen = [];
  for (const divergenceTol of [1e-7, 1e-2, 1]) {
    const fresh = new StaggeredGrid(grid.nx, grid.ny, grid.h);
    applyDocument(fresh, DIVIDER);
    let threw = null;
    try {
      for (let n = 0; n < 5; n++) step(fresh, BOX, { ...params, sources, divergenceTol });
    } catch (e) { threw = e; }
    assert.ok(threw, `divergenceTol ${divergenceTol} let an unsolvable source run`);
    seen.push(`${divergenceTol.toExponential(0)} -> ${threw.name}`);
  }
  console.log(`[M6 step 3] split-chamber case refused at every meaningful bound: ${seen.join(", ")}`);
});

test("M6 - at an absurd bound the CONTINUITY ERROR is the only honest readout", () => {
  // Set divergenceTol above the divergence the configuration forces and both
  // guards pass, because the caller has said that much error is acceptable.
  // What the solver then produces is not a blow-up - it is worse-looking-fine:
  // the Poisson solve meets the loose bound at p = 0, so nothing moves at all
  // and the source delivers nothing.
  //
  // Every readout that existed before this milestone says the field is
  // perfect. Peak speed 0, raw max|div u| 0, finite everywhere. The continuity
  // error is the one number that reports the source is being ignored, because
  // it is measured against what was ASKED for rather than against zero.
  //
  // This is the case that decides the contract, so it is asserted rather than
  // argued.
  const { grid, params } = stillBox();
  applyDocument(grid, DIVIDER);
  const sources = [
    { kind: "mass", where: leftSpot, rate: 0.05 },
    { kind: "mass", where: rightSpot, rate: -0.05 },
  ];
  const plan = sourcePlanFor(grid, sources);
  for (let n = 0; n < 100; n++) {
    step(grid, BOX, { ...params, sources, divergenceTol: 100 });
  }

  let peak = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      peak = Math.max(peak, Math.abs(grid.u[k]), Math.abs(grid.v[k]));
    }
  }
  const raw = computeDivergence(grid).max;
  const continuity = computeContinuityError(grid, plan).max;
  const q = Math.max(...plan.mass.table.map((r) => Math.abs(r.q)));

  // Everything that looked at the field alone says it is fine.
  assert.equal(peak, 0, "nothing moved");
  assert.equal(raw, 0, "the raw divergence is a flawless zero");

  // And the continuity error says the source delivered nothing: it is exactly
  // the divergence that was asked for and not supplied.
  assert.ok(
    Math.abs(continuity - q) < 1e-9,
    `continuity error should be the whole unmet demand ${q}, got ${continuity}`
  );
  console.log(
    `[M6 step 3] divergenceTol 100: peak |u| ${peak}, raw max|div u| ${raw}, ` +
    `continuity error ${continuity.toFixed(3)} = the entire unmet source demand`
  );
});

test("M6 - forcedDivergence is the source rate per unit area of its region", () => {
  // Measured across rates and across region sizes, because "equals the rate"
  // is only true on a unit-area domain and stating it that way would be a
  // coincidence of this grid rather than the relationship.
  const rows = [];
  for (const rate of [0.01, 0.05, 0.2]) {
    const { error } = runMass({ bc: BOX, sources: [{ kind: "mass", where: middleBand, rate }], steps: 1 });
    const forced = error.regions[0].forcedDivergence;
    rows.push(`rate ${rate} -> ${forced.toExponential(4)}`);
    assert.ok(Math.abs(forced / rate - 1) < 1e-9, `rate ${rate} gave ${forced}`);
  }
  // And on a split domain, where each chamber is 264 of 576 cells.
  const { error } = runMass({
    bc: BOX, geometry: DIVIDER, steps: 1,
    sources: [
      { kind: "mass", where: leftSpot, rate: 0.05 },
      { kind: "mass", where: rightSpot, rate: -0.05 },
    ],
  });
  const area = 264 / 576;
  const forced = error.regions[0].forcedDivergence;
  assert.ok(
    Math.abs(forced - 0.05 / area) < 1e-6,
    `a ${area.toFixed(4)}-area chamber with rate 0.05 should force ${(0.05 / area).toExponential(4)}, got ${forced.toExponential(4)}`
  );
  console.log(`[M6 step 3] forcedDivergence = |rate| / region area: ${rows.join(", ")}; ` +
    `and ${forced.toExponential(4)} over an area of ${area.toFixed(4)}`);
});

test("M6 - a momentum source imposes no divergence at all", () => {
  // The contract question is entirely about mass sources. A body force adds no
  // volume, so every number keeps the meaning it had - which is why the two
  // kinds are separate types rather than one with a flag.
  const { grid, params } = stillBox();
  const sources = [{ kind: "momentum", where: middleBand, u: 1, v: 0, relaxationTime: 0.05 }];
  const plan = sourcePlanFor(grid, sources);
  assert.equal(plan.mass, null);
  for (let n = 0; n < 100; n++) step(grid, BOX, { ...params, sources });
  assert.deepEqual(computeContinuityError(grid, plan), computeDivergence(grid));
  assert.ok(computeDivergence(grid).max <= params.divergenceTol);
});

test("M6 - a source's dye is invisible to the solver", () => {
  // scenarios/ is sealed against tracer/ and test9 asserts that deleting
  // tracer/ leaves the solver untouched. A source may carry dye; the compiled
  // plan must not contain it, and the flow must not depend on it.
  const spec = (dye) => [{
    kind: "momentum", where: middleBand, u: 1, v: 0, relaxationTime: 0.05,
    ...(dye === undefined ? {} : { dye }),
  }];

  const run = (dye) => {
    const { grid, params } = stillBox();
    for (let n = 0; n < 60; n++) step(grid, BOX, { ...params, sources: spec(dye) });
    return Array.from(grid.u).concat(Array.from(grid.v));
  };

  assert.deepEqual(run(undefined), run(1), "dye changed the flow");
  assert.deepEqual(run(undefined), run(0.75), "dye changed the flow");

  const { grid } = stillBox();
  const plan = compileSources(grid, spec(1));
  assert.equal(
    JSON.stringify(plan.momentum.table).includes("dye"), false,
    "the compiled plan must not carry dye - the solver never sees it"
  );
  console.log(`[M6 step 2] a source's dye leaves the flow bit-identical and never reaches the plan`);
});

test("M6 - every kind declares where it is sampled and what speed it targets", () => {
  for (const [name, kind] of Object.entries(SOURCE_KINDS)) {
    assert.ok(["faces", "cells"].includes(kind.samples), `${name} must say where it samples`);
    assert.equal(typeof kind.targetSpeed, "function", `${name} must declare its target speed`);
  }
  // Only momentum imposes a speed the timestep will have to be sized against.
  assert.equal(SOURCE_KINDS.momentum.targetSpeed({ u: 3, v: 4 }), 5);
  assert.equal(SOURCE_KINDS.mass.targetSpeed({ rate: 100 }), 0);
});

test("M6 - the session hands the solver the sources the panel is drawing", () => {
  // Found by the browser check, not by any node test: step() takes sources
  // through `params`, the scenario carries them at `scenario.sources`, and the
  // session was passing `{ ...params, dt }` - so the harness compiled a plan to
  // draw with while the solver received none.
  //
  // The signature is a source that is displayed and not applied: the field
  // stays divergence-free while the continuity error reads the entire unmet
  // demand. Measured at the time: continuity 3.20e-1 against a raw divergence
  // of 7.8e-8, exactly inverted from what a working source produces.
  //
  // Asserted against the FIELD rather than against the call, because "did the
  // argument get passed" is a proxy and "did the fluid move" is the property.
  const session = new SimulationSession("pressure-channel");
  const { grid } = session;
  const midX = (grid.nx / 2) * grid.h;
  const midY = (grid.ny / 2) * grid.h;
  session.addSource({
    kind: "mass",
    where: {
      kind: "rect",
      x0: midX - 3 * grid.h, y0: midY - 3 * grid.h,
      x1: midX + 3 * grid.h, y1: midY + 3 * grid.h,
    },
    rate: 0.02,
  });
  assert.notEqual(session.sources, null, "the session must expose its sources");

  for (let n = 0; n < 40; n++) session.advance();

  const plan = sourcePlanFor(grid, session.sources);
  const raw = computeDivergence(grid).max;
  const continuity = computeContinuityError(grid, plan).max;
  const q = plan.mass.table[0].q;

  // A source that reached the solver: the divergence IS the imposed q, and the
  // continuity error is small. A source that did not: exactly the reverse.
  assert.ok(
    Math.abs(raw - q) < 1e-6,
    `the field should carry the imposed divergence ${q}; raw max|div u| is ${raw.toExponential(3)}, ` +
    `which means the source never reached step()`
  );
  assert.ok(
    continuity < 1e-6,
    `continuity error ${continuity.toExponential(3)} - the source is being displayed, not applied`
  );
  console.log(
    `[M6 step 3] session -> solver: raw max|div u| ${raw.toExponential(3)} = imposed q, ` +
    `continuity ${continuity.toExponential(2)}`
  );
});

// ---------------------------------------------------------------------------
// Step 4 - the timestep knows what the brush is about to do
// ---------------------------------------------------------------------------

test("M6 - a brush switched on in still water blows the CFL without the coupling", () => {
  // The M3 limitation, reproduced deliberately. dt is chosen from the field
  // before the step; still water has no convective limit at all, so the viscous
  // limit sets dt - and then the source accelerates the fluid inside that same
  // step. The violation is invisible to assertTimestepIsStable, which checks
  // the field at ENTRY, and only exists in the field the step produces.
  //
  // This is the "before" measurement. It is asserted rather than described so
  // that the fix below is measured against something real.
  const n = 32;
  const h = 1 / n;
  const nu = 0.01;
  const where = { kind: "rect", x0: 0.3, y0: 0.4, x1: 0.7, y1: 0.6 };

  const worstCfl = (target, coupled) => {
    const grid = new StaggeredGrid(n, n, h);
    const sources = [{ kind: "momentum", where, u: target, v: target, relaxationTime: 0.02 }];
    const incomingSpeed = coupled ? sourcePlanFor(grid, sources).maxTargetCflSpeed : 0;
    let previousTimestep = null;
    let worst = 0;
    for (let k = 0; k < 40; k++) {
      const sel = computeStableTimestep(grid, { nu, safety: 0.4, previousTimestep, incomingSpeed });
      previousTimestep = sel.dt;
      step(grid, BOX, {
        nu, rho: 1, dt: sel.dt, divergenceTol: 1e-7, poissonMaxIterations: 20000, sources,
      });
      worst = Math.max(worst, (sel.dt * peakCellSpeed(grid).peak) / h);
    }
    return worst;
  };

  // Uncoupled, a fast brush runs the first step past the hard limit of 1.
  const uncoupled = worstCfl(5, false);
  assert.ok(uncoupled > 1, `expected a CFL violation without the coupling, got ${uncoupled}`);

  // Coupled, it does not - and the worst case stops being the switch-on step.
  const coupled = worstCfl(5, true);
  assert.ok(coupled < 0.5, `the coupling should hold the CFL well under 1, got ${coupled}`);

  console.log(
    `[M6 step 4] brush target 5 from rest: worst CFL ${uncoupled.toFixed(3)} uncoupled -> ` +
    `${coupled.toFixed(3)} coupled`
  );
});

test("M6 - the coupling uses the CFL's own norm, not the physical speed", () => {
  // The convective limit is stated on |u| + |v|, because a flow running
  // diagonally through a cell is constrained by both components at once.
  // hypot(1,1) is 1.414 and |1|+|1| is 2, so sizing a diagonal brush by its
  // physical speed would leave it 41% over the limit.
  const diagonal = { u: 1, v: 1 };
  assert.equal(SOURCE_KINDS.momentum.targetSpeed(diagonal), Math.SQRT2);
  assert.equal(SOURCE_KINDS.momentum.cflSpeed(diagonal), 2);

  const { grid } = stillBox({ n: 20 });
  const plan = sourcePlanFor(grid, [
    { kind: "momentum", where: middleBand, u: 1, v: 1, relaxationTime: 0.1 },
  ]);
  assert.equal(plan.maxTargetCflSpeed, 2, "the plan carries the CFL norm");
  assert.equal(plan.maxTargetSpeed, Math.SQRT2, "and the physical speed, separately");

  // The two produce different timesteps, which is the whole point.
  const byCfl = computeStableTimestep(grid, { nu: 0.01, incomingSpeed: 2 }).dt;
  const bySpeed = computeStableTimestep(grid, { nu: 0.01, incomingSpeed: Math.SQRT2 }).dt;
  assert.ok(bySpeed > byCfl, "the physical speed gives a larger, under-constrained timestep");
  console.log(
    `[M6 step 4] diagonal brush: dt ${byCfl.toExponential(3)} by |u|+|v| against ` +
    `${bySpeed.toExponential(3)} by hypot - ${((bySpeed / byCfl - 1) * 100).toFixed(0)}% too large`
  );
});

test("M6 - the coupling changes the choice and rejects nothing", () => {
  // It belongs in computeStableTimestep, not in assertTimestepIsStable. The
  // advection this step evaluates uses the velocity the field has NOW, so the
  // current field's CFL is the right criterion for this step; refusing it would
  // refuse a step that works. What the coupling buys is that the NEXT step's
  // field is already inside the dt that was chosen.
  const { grid } = stillBox({ n: 20 });
  const sources = [{ kind: "momentum", where: middleBand, u: 5, v: 0, relaxationTime: 0.02 }];
  const plan = sourcePlanFor(grid, sources);

  const plain = computeStableTimestep(grid, { nu: 0.01, safety: 0.4 });
  const coupled = computeStableTimestep(grid, {
    nu: 0.01, safety: 0.4, incomingSpeed: plan.maxTargetCflSpeed,
  });
  assert.ok(coupled.dt < plain.dt, "a fast source should shrink the chosen timestep");
  assert.equal(plain.limitingSpeed, 0, "still water on its own has no convective limit");
  assert.equal(coupled.limitingSpeed, 5);
  assert.equal(coupled.incomingSpeed, 5);
  assert.equal(coupled.limitedBy, "convective");

  // And the larger, uncoupled dt is still accepted by the entry check, because
  // for the field as it stands it is genuinely stable.
  assert.doesNotThrow(() => assertTimestepIsStable(grid, 0.01, plain.dt));
});

test("M6 - with no source the timestep choice is exactly what it always was", () => {
  const { grid } = stillBox({ n: 20 });
  grid.u[grid.idx(5, 5)] = 0.4;
  const options = { nu: 0.01, safety: 0.4, previousTimestep: 1e-3 };
  const before = computeStableTimestep(grid, options);
  const withZero = computeStableTimestep(grid, { ...options, incomingSpeed: 0 });
  const withEmptyPlan = computeStableTimestep(grid, {
    ...options, incomingSpeed: sourcePlanFor(grid, []).maxTargetCflSpeed,
  });
  assert.equal(withZero.dt, before.dt);
  assert.equal(withEmptyPlan.dt, before.dt);
  assert.equal(before.limitingSpeed, before.peakSpeed);
});

test("M6 - the session sizes its timestep against the sources it is running", () => {
  // Asserted through the session rather than the solver, because this is the
  // path the app actually takes - and the last integration gap in this
  // milestone was exactly a value the session failed to thread through.
  const session = new SimulationSession("cavity");
  const { grid } = session;
  session.addSource({
    kind: "momentum",
    where: { kind: "rect", x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 },
    u: 8, v: 0, relaxationTime: 0.02,
  });

  session.advance();
  const withSource = session.lastSelection;
  assert.equal(withSource.incomingSpeed, 8, "the session must pass the source's CFL speed");
  assert.ok(withSource.dt <= (0.4 * grid.h) / 8 + 1e-15, `dt ${withSource.dt} is not sized against the target`);

  const plain = new SimulationSession("cavity");
  plain.advance();
  assert.equal(plain.lastSelection.incomingSpeed, 0);
  console.log(
    `[M6 step 4] session with a target-8 brush chose dt ${withSource.dt.toExponential(3)} ` +
    `against ${plain.lastSelection.dt.toExponential(3)} without it`
  );
});

// ---------------------------------------------------------------------------
// Step 6 - the brush, and dye released by a source
// ---------------------------------------------------------------------------

function brushFor(grid, options = {}) {
  const scale = 6;
  const margin = 9;
  const layout = {
    rect: { left: 0, top: 0, width: grid.nx * scale + 2 * margin, height: grid.ny * scale + 2 * margin },
    canvasWidth: grid.nx * scale + 2 * margin,
    canvasHeight: grid.ny * scale + 2 * margin,
    margin, scale, h: grid.h, nx: grid.nx, ny: grid.ny,
  };
  const seen = [];
  const brush = new BrushController({
    getLayout: () => layout,
    onChange: (source) => seen.push(source),
    ...options,
  });
  const at = (x, y) => [
    margin + (x / grid.h) * scale,
    margin + (grid.ny - y / grid.h) * scale,
  ];
  return { brush, seen, at, layout };
}

test("M6 - a press with no movement drives nothing, because it has no direction", () => {
  // "No movement means stop the fluid" would turn press-and-hold into a brake -
  // a different tool wearing this one's clothes. There is no direction yet, so
  // there is no source yet.
  const { grid } = stillBox({ n: 24 });
  const { brush, at } = brushFor(grid);
  assert.equal(brush.down(...at(0.5, 0.5)), true);
  assert.equal(brush.source, null, "a press alone must not invent a direction");

  // A movement below the threshold is still not a direction.
  brush.move(...at(0.5 + grid.h / 8, 0.5));
  assert.equal(brush.source, null);

  // Past it, there is one.
  brush.move(...at(0.7, 0.5));
  const source = brush.source;
  assert.notEqual(source, null);
  assert.equal(source.kind, "momentum");
  assert.ok(source.u > 0 && Math.abs(source.v) < 1e-9, "dragged +x, so it pushes +x");
  assert.ok(
    Math.abs(Math.hypot(source.u, source.v) - brush.settings.speed) < 1e-9,
    "the magnitude comes from the control, not from how fast the pointer moved"
  );
});

test("M6 - the brush's speed is the control's, whatever the gesture", () => {
  // Direction from the drag, which the canvas mapping gives exactly; magnitude
  // from a control, because pointer time is wall-clock and fluid time is not.
  const { grid } = stillBox({ n: 24 });
  const { brush, at } = brushFor(grid);
  brush.setSetting("speed", 3);
  brush.down(...at(0.2, 0.2));
  brush.move(...at(0.9, 0.9));
  const fast = brush.source;
  brush.up();

  brush.down(...at(0.2, 0.2));
  brush.move(...at(0.25, 0.25));   // a much shorter drag, same direction
  const slow = brush.source;

  assert.ok(Math.abs(Math.hypot(fast.u, fast.v) - 3) < 1e-9);
  assert.ok(Math.abs(Math.hypot(slow.u, slow.v) - 3) < 1e-9);
  assert.ok(Math.abs(fast.u - slow.u) < 1e-9, "same direction gives the same target");

  // And a rejected setting leaves the previous one in place.
  assert.equal(brush.setSetting("speed", -1), false);
  assert.equal(brush.setSetting("speed", NaN), false);
  assert.equal(brush.settings.speed, 3);
});

test("M6 - releasing the brush leaves nothing behind", () => {
  const { grid } = stillBox({ n: 24 });
  const { brush, at } = brushFor(grid);
  brush.down(...at(0.5, 0.5));
  brush.move(...at(0.8, 0.5));
  assert.notEqual(brush.source, null);
  assert.equal(brush.up(), true);
  assert.equal(brush.source, null);
  assert.equal(brush.stroking, false);
});

test("M6 - combineSources returns a new array only when the brush is live", () => {
  // The plan cache keys on the array, so the array must change when the sources
  // change and NOT change when they do not - a fresh array on every read would
  // miss the cache eight times a frame.
  const placed = [{ kind: "momentum", where: middleBand, u: 1, v: 0, relaxationTime: 0.1 }];
  assert.equal(combineSources(placed, null), placed, "no brush: the same array back");
  assert.equal(combineSources([], null), null, "nothing at all compiles to nothing");

  const brushSource = { kind: "momentum", where: middleBand, u: 2, v: 0, relaxationTime: 0.05 };
  const combined = combineSources(placed, brushSource);
  assert.notEqual(combined, placed);
  assert.equal(combined.length, 2);
  assert.equal(combined[0], placed[0], "placed entries are shared, only the array is new");
});

test("M6 - the session rebuilds its source array on change and not on read", () => {
  const session = new SimulationSession("cavity");
  const first = session.sources;
  assert.equal(session.sources, first, "reading twice must give the same array");

  session.addSource({
    kind: "momentum", where: { kind: "rect", x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 },
    u: 1, v: 0, relaxationTime: 0.05,
  });
  const withPlaced = session.sources;
  assert.notEqual(withPlaced, first);
  assert.equal(session.sources, withPlaced);

  session.setBrushSource({
    kind: "momentum", where: { kind: "rect", x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 },
    u: 2, v: 0, relaxationTime: 0.05,
  });
  assert.equal(session.sources.length, 2);
  session.setBrushSource(null);
  assert.equal(session.sources.length, 1);
  session.removeSource(0);
  assert.equal(session.sources, null);
});

test("M6 - a brush stroke actually moves the fluid through the session", () => {
  const session = new SimulationSession("cavity");
  const { grid } = session;
  const before = Array.from(grid.u);

  session.setBrushSource({
    kind: "momentum",
    where: { kind: "disk", cx: 0.5, cy: 0.5, radius: 0.12, metric: "squared", closed: true },
    u: 1, v: 0, relaxationTime: 0.05,
  });
  for (let n = 0; n < 30; n++) session.advance();

  assert.notDeepEqual(Array.from(grid.u), before, "the stroke must reach the solver");
  const continuity = computeContinuityError(grid, sourcePlanFor(grid, session.sources)).max;
  assert.ok(continuity <= session.params.divergenceTol, `continuity ${continuity.toExponential(3)}`);

  // And letting go stops it driving.
  session.setBrushSource(null);
  assert.equal(session.sources, null);
  console.log(`[M6 step 6] a brush stroke through the session: continuity ${continuity.toExponential(2)}`);
});

// ---------------------------------------------------------------------------
// Dye on sources - and the seal
// ---------------------------------------------------------------------------

test("M6 - a source's dye reaches the tracer and nothing else", () => {
  const session = new SimulationSession("cavity");
  const where = { kind: "disk", cx: 0.5, cy: 0.5, radius: 0.1, metric: "squared", closed: true };
  session.tracer.clear();
  session.addSource({ kind: "momentum", where, u: 1, v: 0, relaxationTime: 0.05, dye: 4 });

  const before = session.tracer.total(session.grid).total;
  for (let n = 0; n < 20; n++) session.advance();
  const after = session.tracer.total(session.grid).total;

  assert.ok(after > before, `dye should have been released: ${before} -> ${after}`);
  assert.ok(session.lastTracer.injected.cells > 0);
  console.log(
    `[M6 step 6] source dye: total ${before.toFixed(4)} -> ${after.toFixed(4)} over ` +
    `${session.lastTracer.injected.cells} cells`
  );
});

test("M6 - dye on a source leaves the flow bit-identical", () => {
  // The M3 guarantee, extended to the new place dye can come from. If this ever
  // fails, a display feature has started changing the physics.
  const run = (dye) => {
    const session = new SimulationSession("cavity");
    session.addSource({
      kind: "momentum",
      where: { kind: "disk", cx: 0.5, cy: 0.5, radius: 0.1, metric: "squared", closed: true },
      u: 1, v: 0, relaxationTime: 0.05,
      ...(dye === null ? {} : { dye }),
    });
    for (let n = 0; n < 25; n++) session.advance();
    const { grid } = session;
    return [Array.from(grid.u), Array.from(grid.v), Array.from(grid.p)];
  };
  const plain = run(null);
  assert.deepEqual(run(0.5), plain, "dye changed the flow");
  assert.deepEqual(run(50), plain, "a large dye release changed the flow");
});

test("M6 - source dye is released per unit time, not per substep", () => {
  // The tracer subdivides its own step when its CFL bound is tighter than the
  // one it was handed - eleven substeps on an impulsive start. Releasing dye*dt
  // inside that loop would multiply the release by the substep count, so how
  // much dye appeared would depend on how fast the fluid happened to be moving.
  const grid = new StaggeredGrid(20, 20, 0.05);
  const where = { kind: "rect", x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 };
  const sources = [{ kind: "mass", where, rate: 1, dye: 2 }];

  // Agreement to roundoff, not bit-identity: summing dye*dt/n n times is a
  // different sequence of additions from one dye*dt, and the last bit differs.
  // Measured worst difference across substep counts, against a release of 0.2:
  //   2 -> 0.000e+0, 10 -> 2.776e-17, 11 -> 2.776e-17, 100 -> 1.388e-16.
  // The bound below is two orders above the largest of those, which is far
  // tighter than the bug it exists to catch - releasing dye*dt per substep
  // would multiply the total by the substep count.
  const worstOver = (substeps) => {
    const single = new PassiveTracer(grid);
    const many = new PassiveTracer(grid);
    injectSourceDye(single, grid, sources, 0.1, 1);
    for (let n = 0; n < substeps; n++) injectSourceDye(many, grid, sources, 0.1 / substeps, 1);
    let worst = 0;
    for (let k = 0; k < single.c.length; k++) {
      worst = Math.max(worst, Math.abs(single.c[k] - many.c[k]));
    }
    return worst;
  };
  for (const substeps of [2, 10, 11, 100]) {
    const worst = worstOver(substeps);
    assert.ok(
      worst < 1e-14,
      `${substeps} substeps differ from one release by ${worst.toExponential(3)}`
    );
  }
  console.log(
    `[M6 step 6] dye release is substep-invariant: worst difference over 2, 10, 11 and ` +
    `100 substeps is ${worstOver(100).toExponential(2)} against a release of 0.2`
  );
});

test("M6 - dye accumulation is clamped rather than flattening the colour scale", () => {
  const grid = new StaggeredGrid(20, 20, 0.05);
  const sources = [{
    kind: "momentum", where: { kind: "rect", x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 },
    u: 1, v: 0, relaxationTime: 0.05, dye: 1000,
  }];
  const tracer = new PassiveTracer(grid);
  for (let n = 0; n < 50; n++) injectSourceDye(tracer, grid, sources, 0.01, MAX_CONCENTRATION);
  let peak = 0;
  for (const value of tracer.c) peak = Math.max(peak, value);
  assert.equal(peak, MAX_CONCENTRATION, `dye ran to ${peak}, past the scale's ceiling`);
});

test("M6 - the dye selection is cached and follows the geometry", () => {
  const grid = new StaggeredGrid(20, 20, 0.05);
  const sources = [{
    kind: "momentum", where: { kind: "rect", x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 },
    u: 1, v: 0, relaxationTime: 0.05, dye: 1,
  }];
  const first = dyeSourcesFor(grid, sources);
  assert.equal(dyeSourcesFor(grid, sources), first, "the same array is not rescanned");

  // A wall through the middle removes cells from the selection.
  applyDocument(grid, {
    operations: [{ op: "add", region: { kind: "rect", x0: 0.4, y0: 0, x1: 0.6, y1: 1 } }],
  });
  const second = dyeSourcesFor(grid, sources);
  assert.notEqual(second, first, "a mask change must rescan");
  assert.ok(second.entries[0].cells.length < first.entries[0].cells.length);

  // A source with no dye is not in the selection at all.
  assert.equal(dyeSourcesFor(grid, [{ ...sources[0], dye: 0 }]), null);
  assert.equal(dyeSourcesFor(grid, []), null);
});

test("M6 - a source that cannot compile is refused where it is added", () => {
  // Found by the browser check, and it is a placement bug rather than a
  // validation one: validateSource says whether an object is well formed, and
  // whether it selects any face the solver would update is a question about the
  // GRID. Checking only the shape let a source placed inside the cylinder pass
  // and then throw from inside draw(), as an uncaught page error - a throw from
  // somewhere no caller was guarding.
  const session = new SimulationSession("cylinder");
  const inTheBody = {
    kind: "momentum",
    where: { kind: "disk", cx: 3.5, cy: 73 / 24, radius: 0.1, metric: "squared", closed: true },
    u: 1, v: 0, relaxationTime: 0.05,
  };
  const error = captureThrow(() => session.addSource(inTheBody));
  assert.ok(error, "a source inside a solid must be refused when it is added");
  assert.equal(error.name, "SourceSpecError");
  assert.equal(error.reason, "empty-selection");
  assert.equal(session.placedSources.length, 0, "and must not be recorded");

  // The session is still usable afterwards - the rejection left nothing behind.
  assert.doesNotThrow(() => session.advance());
});

test("M6 - a brush dragged over a wall holds no source rather than throwing", () => {
  // The same situation, arrived at transiently. Here it is not an error to
  // report: a brush over a wall pushing nothing is what should happen, and the
  // panel distinguishes "armed" from "pushing" so it is visible rather than
  // silent.
  const session = new SimulationSession("cylinder");
  const overFluid = {
    kind: "momentum",
    where: { kind: "disk", cx: 8, cy: 3, radius: 0.25, metric: "squared", closed: true },
    u: 1, v: 0, relaxationTime: 0.05,
  };
  const overTheBody = {
    kind: "momentum",
    where: { kind: "disk", cx: 3.5, cy: 73 / 24, radius: 0.1, metric: "squared", closed: true },
    u: 1, v: 0, relaxationTime: 0.05,
  };

  session.setBrushSource(overFluid);
  assert.notEqual(session.brushSource, null);
  assert.equal(session.sources.length, 1);

  assert.doesNotThrow(() => session.setBrushSource(overTheBody));
  assert.equal(session.brushSource, null, "over a wall the brush drives nothing");
  assert.equal(session.sources, null);

  // And it picks back up when the stroke returns to fluid.
  session.setBrushSource(overFluid);
  assert.notEqual(session.brushSource, null);
  assert.doesNotThrow(() => session.advance());
});

test("M6 - clearSources removes every placed source and leaves the brush alone", () => {
  const session = new SimulationSession("cavity");
  const where = { kind: "rect", x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.7 };
  assert.equal(session.clearSources(), false, "nothing to clear on a fresh session");

  session.addSource({ kind: "momentum", where, u: 1, v: 0, relaxationTime: 0.05 });
  session.addSource({ kind: "momentum", where, u: 0, v: 1, relaxationTime: 0.05 });
  assert.equal(session.sources.length, 2);

  // A live brush is not a placed source and must survive the clear - it belongs
  // to a gesture in progress, not to the document.
  session.setBrushSource({ kind: "momentum", where, u: 2, v: 0, relaxationTime: 0.05 });
  assert.equal(session.sources.length, 3);

  assert.equal(session.clearSources(), true);
  assert.equal(session.placedSources.length, 0);
  assert.notEqual(session.brushSource, null, "the brush is mid-stroke and is not a placed source");
  assert.equal(session.sources.length, 1);

  session.setBrushSource(null);
  assert.equal(session.sources, null);
  assert.doesNotThrow(() => session.advance());
});
