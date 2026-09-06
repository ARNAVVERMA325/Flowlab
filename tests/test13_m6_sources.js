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
import { step, computeDivergence } from "../solver/ns2d.js";
import { compileSources, sourcePlanFor, sourceLegend } from "../sources/compile.js";
import { SOURCE_KINDS, SourceSpecError, describeSource, validateSource } from "../sources/kinds.js";
import { FIXTURE_CASES, measureFixtureCase } from "./support/boundaryFixtures.js";

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

test("M6 - mass sources are refused by the solver, not silently skipped", () => {
  const { grid, params } = stillBox();
  const error = captureThrow(() => step(grid, BOX, {
    ...params,
    sources: [{ kind: "mass", where: middleBand, rate: 0.1 }],
  }));
  assert.ok(error, "a mass source must not be quietly ignored");
  assert.equal(error.name, "SourceSpecError");
  assert.equal(error.reason, "mass-sources-not-implemented");
  assert.match(error.message, /does not apply them yet/);

  // The field is untouched: it refused before doing any work.
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      assert.equal(grid.u[grid.idx(i, j)], 0);
      assert.equal(grid.v[grid.idx(i, j)], 0);
    }
  }
  console.log(`[M6 step 2] mass sources compile and are refused by step() until demonstrated`);
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
