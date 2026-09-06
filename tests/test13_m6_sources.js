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
import { FIXTURE_CASES, measureFixtureCase } from "./support/boundaryFixtures.js";
import { buildScenario } from "../scenarios/index.js";
import { SimulationSession } from "../ui/session.js";

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
  const scenario = buildScenario("pressure-channel");
  const { grid } = scenario;
  const midX = (grid.nx / 2) * grid.h;
  const midY = (grid.ny / 2) * grid.h;
  scenario.sources = [{
    kind: "mass",
    where: {
      kind: "rect",
      x0: midX - 3 * grid.h, y0: midY - 3 * grid.h,
      x1: midX + 3 * grid.h, y1: midY + 3 * grid.h,
    },
    rate: 0.02,
  }];

  const session = new SimulationSession("pressure-channel");
  session.scenario = scenario;
  session.maskVersionAtReset = grid.maskVersion;
  assert.notEqual(session.sources, null, "the session must expose the scenario's sources");

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
