// M5 step 1 - the geometry document model.
//
// The model is built around one finding: TWO DIFFERENT CIRCLE CONVENTIONS were
// already in this codebase before M5, and unifying them moves a benchmarked
// result.
//
//   stampCircle      (x-cx)**2 + (y-cy)**2 <= r*r    squared, closed
//   the smooth bend  Math.hypot(x-cx, y-cy) <  r     euclidean, open
//
// Decomposing the difference corrected the first explanation of it. The metric
// contributes nothing at all; every differing cell comes from `<=` against
// `<`. The tests below record that decomposition rather than the initial
// reading of it, and check each primitive reproduces the predicate it replaces
// cell for cell on the exact grids the scenarios use - not on a toy grid where
// the difference cannot show up.

import test from "node:test";
import assert from "node:assert/strict";

import { StaggeredGrid, stampCircle } from "../geometry/grid.js";
import {
  applyDocument,
  sampleDocument,
  testRegion,
  validateDocument,
  GeometryDocumentError,
} from "../geometry/document.js";
import { bendDocument, cylinderDocument, emptyDocument } from "../geometry/documents.js";
import { fluidRegions } from "../geometry/regions.js";
import { step, computeDivergence, boundaryPlanFor } from "../solver/ns2d.js";
import { analyseRegions, describeRegions } from "../boundaries/regionAnalysis.js";
import { compileBoundaryConditions } from "../boundaries/compile.js";
import { measureBoundaryFlux } from "../visualization/boundaryOverlay.js";
import { PassiveTracer } from "../tracer/passiveScalar.js";
import { GeometryEditor, TOOLS } from "../geometry/editor.js";
import { SimulationSession } from "../ui/session.js";
import {
  BLOCK_DOWNSTREAM_FACE,
  BLOCK_UPSTREAM_FACE,
  CHANNEL_BC,
  WHOLE_DOMAIN,
  bendGeometry,
  channelWithBlock,
  compareAgainstPredicate,
  countMask,
  cylinderGeometry,
  fluxThroughAttachment,
  originalBendPredicate,
} from "./support/geometry.js";

// The cylinder scenario's exact grid and circle placement, copied from
// scenarios/index.js. Copied rather than imported because the point is to
// check the document reproduces THAT arithmetic; importing the scenario would
// only prove the document agrees with itself.
function firstDifference(a, b, grid) {
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      if (a[k] !== b[k]) return { i, j, ...grid.cellCentre(i, j) };
    }
  }
  return null;
}

function captureThrow(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

test("M5 - a squared/closed disk reproduces stampCircle cell for cell", () => {
  const g = cylinderGeometry();
  const stamped = new StaggeredGrid(g.nx, g.ny, g.h);
  const stampedCount = stampCircle(stamped, g.cx, g.cy, g.radius);

  const sampled = new StaggeredGrid(g.nx, g.ny, g.h);
  const document = {
    operations: [
      {
        op: "add",
        region: { kind: "disk", cx: g.cx, cy: g.cy, radius: g.radius, metric: "squared", closed: true },
      },
    ],
  };
  const sampledCount = applyDocument(sampled, document);

  const difference = firstDifference(stamped.solid, sampled.solid, stamped);
  assert.equal(difference, null, `masks differ first at ${JSON.stringify(difference)}`);
  assert.equal(sampledCount, stampedCount);
  console.log(
    `[M5 conventions] squared/closed disk reproduces stampCircle exactly: ` +
    `${sampledCount} solid cells on the ${g.nx}x${g.ny} cylinder grid`
  );
});

test("M5 - the boundary convention decides cells; the metric decides none", () => {
  // The decomposition, pinned. The first reading of this finding blamed the
  // metric, and a mutation that removed the squared branch entirely survived
  // the test suite - which is how the attribution got corrected. All four
  // variants are compared here so the numbers say which half matters.
  const g = cylinderGeometry();
  const grid = new StaggeredGrid(g.nx, g.ny, g.h);
  const mask = (metric, closed) =>
    sampleDocument(
      { operations: [{ op: "add", region: { kind: "disk", cx: g.cx, cy: g.cy, radius: g.radius, metric, closed } }] },
      grid
    );
  const differing = (a, b) => {
    let n = 0;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) n++;
    return n;
  };

  const sc = mask("squared", true);
  const so = mask("squared", false);
  const ec = mask("euclidean", true);
  const eo = mask("euclidean", false);

  assert.equal(differing(sc, ec), 0, "changing only the metric must change nothing");
  assert.equal(differing(so, eo), 0, "changing only the metric must change nothing");
  assert.equal(differing(sc, so), 3, "changing only the boundary convention costs 3 cells");
  assert.equal(differing(ec, eo), 3, "changing only the boundary convention costs 3 cells");

  console.log(
    `[M5 conventions] cylinder body, ${countMask(sc)} cells: metric alone changes ` +
    `${differing(sc, ec)} cells, boundary convention alone changes ${differing(sc, so)}`
  );
});

test("M5 - the three deciding cells sit exactly on the radius", () => {
  // Why the boundary convention is worth three cells and not zero: three cell
  // centres are at a distance that lands precisely on the radius in floating
  // point, so `<=` takes them and `<` does not.
  //
  // This doubles as a CROSS-VERSION CANARY. Math.hypot is not required to be
  // correctly rounded, so this exact equality is a property of the engine, not
  // of arithmetic. If a Node upgrade changes it, this fails and warns that the
  // golden masks and golden fields may have moved for reasons that are not a
  // code change.
  const g = cylinderGeometry();
  const grid = new StaggeredGrid(g.nx, g.ny, g.h);
  const exact = [];
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const { x, y } = grid.cellCentre(i, j);
      if (Math.hypot(x - g.cx, y - g.cy) === g.radius) exact.push({ i, j });
      }
  }
  assert.equal(exact.length, 3, "three cell centres should land exactly on the radius");
  for (const { i, j } of exact) {
    const { x, y } = grid.cellCentre(i, j);
    assert.equal((x - g.cx) ** 2 + (y - g.cy) ** 2 === g.radius * g.radius, true,
      `cell (${i}, ${j}) is on the radius by hypot but not by squared distance`);
  }
  console.log(
    `[M5 conventions] cross-version canary: cells ` +
    exact.map((c) => `(${c.i},${c.j})`).join(" ") +
    ` sit exactly on the radius under both metrics`
  );
});

test("M5 - the metrics agree everywhere this project can find", () => {
  // The honest strength of the metric parameter. It is kept because it records
  // which expression a document was built against and because Math.hypot's
  // rounding is an engine property rather than a guarantee - NOT because any
  // measured case distinguishes the two. Nothing here would fail if the
  // squared branch were deleted; that is stated rather than papered over.
  const grid = new StaggeredGrid(120, 120, 1 / 120);
  let seed = 20260827;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let disagreements = 0;
  let samples = 0;
  for (let t = 0; t < 40; t++) {
    const cx = 0.2 + 0.6 * rnd();
    const cy = 0.2 + 0.6 * rnd();
    const radius = 0.02 + 0.15 * rnd();
    for (const closed of [true, false]) {
      for (let j = 1; j <= grid.ny; j++) {
        for (let i = 1; i <= grid.nx; i++) {
          const { x, y } = grid.cellCentre(i, j);
          const a = testRegion({ kind: "disk", cx, cy, radius, metric: "squared", closed }, x, y);
          const b = testRegion({ kind: "disk", cx, cy, radius, metric: "euclidean", closed }, x, y);
          if (a !== b) disagreements++;
          samples++;
        }
      }
    }
  }
  assert.equal(disagreements, 0);
  console.log(
    `[M5 conventions] squared and euclidean agreed on all ${samples.toLocaleString()} samples ` +
    `across 40 circles - the metric parameter is about reproducing an expression, not a measured difference`
  );
});

test("M5 - a euclidean/open disk reproduces the smooth bend's annulus", () => {
  // The other convention, on the grid that uses it. The bend's corner is an
  // annulus complement: solid where d < ri OR d > ro, tested only inside the
  // corner quadrant.
  const w = 1;
  const cpw = 12;
  const h = w / cpw;
  const legLen = 6;
  const Lx = legLen * w + w;
  const ri = 1;
  const ro = ri + w;
  const cx = Lx - ro;
  const cy = Lx - ro;
  const nx = Math.round(Lx / h);
  const grid = new StaggeredGrid(nx, nx, h);

  const annulusRegion = {
    all: [
      { kind: "halfPlane", axis: "x", comparison: ">=", at: cx },
      { kind: "halfPlane", axis: "y", comparison: ">=", at: cy },
      {
        any: [
          { kind: "disk", cx, cy, radius: ri, metric: "euclidean", closed: false },
          { not: { kind: "disk", cx, cy, radius: ro, metric: "euclidean", closed: true } },
        ],
      },
    ],
  };

  let checked = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const { x, y } = grid.cellCentre(i, j);
      // The original predicate, verbatim.
      const original = x >= cx && y >= cy ? Math.hypot(x - cx, y - cy) < ri || Math.hypot(x - cx, y - cy) > ro : false;
      assert.equal(
        testRegion(annulusRegion, x, y),
        original,
        `annulus disagrees at cell (${i}, ${j}), x=${x}, y=${y}`
      );
      checked++;
    }
  }
  console.log(`[M5 conventions] euclidean/open annulus matches the bend predicate over ${checked} cells`);
});

test("M5 - half-planes keep < and <= apart", () => {
  // The bend's legs are strict inequalities. A half-plane that normalised < to
  // <= would move the duct wall by one cell wherever an edge lands exactly on
  // a cell centre - which is common, because scenario dimensions are chosen to
  // be round numbers.
  const at = 0.5;
  const open = { kind: "halfPlane", axis: "x", comparison: "<", at };
  const closed = { kind: "halfPlane", axis: "x", comparison: "<=", at };
  assert.equal(testRegion(open, at, 0), false, "< must exclude the boundary");
  assert.equal(testRegion(closed, at, 0), true, "<= must include it");
  assert.equal(testRegion(open, at - 1e-15, 0), true);

  // And the axis actually selects a coordinate.
  assert.equal(testRegion({ kind: "halfPlane", axis: "y", comparison: "<", at }, 9, 0.4), true);
  assert.equal(testRegion({ kind: "halfPlane", axis: "y", comparison: "<", at }, 0.4, 9), false);
});

test("M5 - rectangles are half-open so they tile without seams or overlaps", () => {
  // Two rectangles meeting at x = 0.5 must cover every point exactly once. A
  // closed-closed convention double-covers the seam; open-open leaves a gap
  // that shows up as a one-cell crack in a drawn wall.
  const left = { kind: "rect", x0: 0, y0: 0, x1: 0.5, y1: 1 };
  const right = { kind: "rect", x0: 0.5, y0: 0, x1: 1, y1: 1 };
  let covered = 0;
  for (const x of [0, 0.25, 0.4999999, 0.5, 0.75, 0.9999999]) {
    const inLeft = testRegion(left, x, 0.5);
    const inRight = testRegion(right, x, 0.5);
    assert.ok(!(inLeft && inRight), `x=${x} is covered twice`);
    if (inLeft || inRight) covered++;
  }
  assert.equal(covered, 6, "every sample point should be covered exactly once");

  // Explicit comparisons override the default when a scenario needs them.
  const closedHigh = { kind: "rect", x0: 0, y0: 0, x1: 0.5, y1: 1, highComparison: "<=" };
  assert.equal(testRegion(closedHigh, 0.5, 0.5), true);
});

test("M5 - add and subtract apply in order", () => {
  const grid = new StaggeredGrid(20, 20, 0.05);
  const ring = {
    operations: [
      { op: "add", region: { kind: "disk", cx: 0.5, cy: 0.5, radius: 0.4, metric: "squared", closed: true } },
      { op: "subtract", region: { kind: "disk", cx: 0.5, cy: 0.5, radius: 0.2, metric: "squared", closed: true } },
    ],
  };
  const mask = sampleDocument(ring, grid);
  assert.equal(mask[grid.idx(10, 10)], 0, "the centre should have been carved out");
  assert.equal(mask[grid.idx(10, 4)], 1, "the ring itself should be solid");

  // Reversing the operations gives a filled disk: subtract-then-add is not the
  // same document, and the model must not quietly reorder.
  const reversed = sampleDocument({ operations: [...ring.operations].reverse() }, grid);
  assert.equal(reversed[grid.idx(10, 10)], 1);
  assert.notEqual(countMask(mask), countMask(reversed));
});

test("M5 - sampling is pure and repeatable", () => {
  // Everything downstream - the golden mask fixture in step 2, resampling at
  // another resolution in step 5 - depends on this.
  const grid = new StaggeredGrid(30, 30, 1 / 30);
  const document = {
    operations: [
      { op: "add", region: { kind: "rect", x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.4 } },
      { op: "add", region: { kind: "polygon", vertices: [{ x: 0.2, y: 0.6 }, { x: 0.8, y: 0.6 }, { x: 0.5, y: 0.95 }] } },
      { op: "subtract", region: { kind: "disk", cx: 0.5, cy: 0.25, radius: 0.08, metric: "euclidean", closed: false } },
    ],
  };
  const before = JSON.stringify(document);
  const first = sampleDocument(document, grid);
  const second = sampleDocument(document, grid);
  assert.ok(Buffer.from(first).equals(Buffer.from(second)), "two samples of one document must agree");
  assert.equal(JSON.stringify(document), before, "sampling must not mutate the document");
  assert.ok(countMask(first) > 0);
  console.log(`[M5 document] three-operation document samples to ${countMask(first)} solid cells, repeatably`);
});

test("M5 - a malformed document is rejected with a reason", () => {
  const cases = [
    [{ operations: [] }, null, "an empty document is legal - no geometry is a valid state"],
    [{ operations: [{ op: "paint", region: { kind: "rect", x0: 0, y0: 0, x1: 1, y1: 1 } }] }, /"op" must be/, "unknown operation"],
    [{ operations: [{ op: "add", region: { kind: "blob" } }] }, /unknown shape "blob"/, "unknown shape"],
    [{ operations: [{ op: "add", region: { kind: "disk", cx: 0, cy: 0, radius: 1, closed: true } }] }, /explicit metric/, "disk without a metric"],
    [{ operations: [{ op: "add", region: { kind: "disk", cx: 0, cy: 0, radius: 1, metric: "squared" } }] }, /explicit "closed"/, "disk without a boundary convention"],
    [{ operations: [{ op: "add", region: { kind: "disk", cx: 0, cy: 0, radius: -1, metric: "squared", closed: true } }] }, /radius must be positive/, "negative radius"],
    [{ operations: [{ op: "add", region: { kind: "halfPlane", axis: "z", comparison: "<", at: 0 } }] }, /axis must be/, "bad axis"],
    [{ operations: [{ op: "add", region: { kind: "halfPlane", axis: "x", comparison: "=", at: 0 } }] }, /explicit comparison/, "bad comparison"],
    [{ operations: [{ op: "add", region: { kind: "rect", x0: 1, y0: 0, x1: 0, y1: 1 } }] }, /x1 > x0/, "inverted rectangle"],
    [{ operations: [{ op: "add", region: { kind: "polygon", vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }] }, /at least 3 vertices/, "degenerate polygon"],
    [{ operations: [{ op: "add", region: { all: [] } }] }, /non-empty array/, "empty composition"],
    [{ operations: [{ op: "add", region: { kind: "rect", x0: 0, y0: 0, x1: NaN, y1: 1 } }] }, /finite number/, "NaN coordinate"],
  ];

  for (const [document, pattern, description] of cases) {
    const error = captureThrow(() => validateDocument(document));
    if (pattern === null) {
      assert.equal(error, null, description);
      continue;
    }
    assert.ok(error, `expected a rejection: ${description}`);
    assert.equal(error.name, "GeometryDocumentError", `${description}: threw ${error.name}`);
    assert.match(error.message, pattern, description);
  }
  console.log(`[M5 document] ${cases.length - 1} malformed documents rejected with reasons`);
});

test("M5 - applyDocument bumps maskVersion so cached topology rebuilds", () => {
  // The solver caches its fluid-cell topology and M4 caches the compiled
  // boundary plan, both keyed on maskVersion. Geometry that changes without
  // bumping it would leave the solver operating on a stale mask.
  const grid = new StaggeredGrid(10, 10, 0.1);
  const before = grid.maskVersion;
  applyDocument(grid, { operations: [{ op: "add", region: { kind: "rect", x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5 } }] });
  assert.ok(grid.maskVersion > before, "maskVersion must advance when geometry changes");

  // Applying a different document replaces the mask rather than accumulating.
  const solidAfterFirst = countMask(grid.solid);
  applyDocument(grid, { operations: [{ op: "add", region: { kind: "rect", x0: 0.7, y0: 0.7, x1: 0.9, y1: 0.9 } }] });
  assert.ok(countMask(grid.solid) > 0);
  assert.equal(grid.solid[grid.idx(3, 3)], 0, "the previous document's solid must be gone");
  assert.ok(solidAfterFirst > 0);
});

// ---------------------------------------------------------------------------
// Step 2 - the validated scenarios as documents
// ---------------------------------------------------------------------------
//
// GATE 1. Each document must reproduce, cell for cell, the predicate it
// replaces - on the grid that scenario actually uses, not a convenient one.
// The originals are copied verbatim into this file rather than imported,
// because importing the production code would only prove the document agrees
// with itself. These copies are the record of what the mask was.

// Verbatim from tests/support/bend.js buildBend, which scenarios/index.js
// duplicates exactly.
test("M5 gate 1 - the cylinder document reproduces its stamp exactly", () => {
  const g = cylinderGeometry();
  const grid = new StaggeredGrid(g.nx, g.ny, g.h);
  const stamped = new StaggeredGrid(g.nx, g.ny, g.h);
  stampCircle(stamped, g.cx, g.cy, g.radius);

  const { mask, solidCells } = compareAgainstPredicate(
    grid,
    cylinderDocument({ cx: g.cx, cy: g.cy, radius: g.radius }),
    // The stamp itself is the reference here, read back cell by cell.
    (x, y) => false
  );
  void mask;

  const differing = [];
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      const fromDocument = sampleDocument(
        cylinderDocument({ cx: g.cx, cy: g.cy, radius: g.radius }),
        grid
      )[k];
      if (fromDocument !== stamped.solid[k]) differing.push({ i, j });
      if (differing.length > 3) break;
    }
    if (differing.length > 3) break;
  }
  assert.deepEqual(differing, [], `cells differing from stampCircle: ${JSON.stringify(differing)}`);
  console.log(`[M5 gate 1] cylinder: ${solidCells} solid cells, 0 differing from stampCircle`);
});

test("M5 gate 1 - both bend documents reproduce their predicates exactly", () => {
  const { w, h, Lx, Ly, n } = bendGeometry();

  const report = [];
  for (const innerRadius of [null, 1]) {
    const grid = new StaggeredGrid(n, n, h);
    const { differing, solidCells } = compareAgainstPredicate(
      grid,
      bendDocument({ Lx, Ly, w, innerRadius }),
      originalBendPredicate({ Lx, Ly, w, innerRadius })
    );
    assert.deepEqual(
      differing.slice(0, 5),
      [],
      `${innerRadius === null ? "sharp" : "smooth"} bend: ${differing.length} cells differ, ` +
      `first at ${JSON.stringify(differing[0])}`
    );
    report.push(`${innerRadius === null ? "sharp" : "smooth"} ${solidCells} cells`);
  }
  console.log(`[M5 gate 1] bend documents match their predicates over ${n * n} cells each: ${report.join(", ")}`);
});

test("M5 gate 1 - the documents survive a change of resolution", () => {
  // Not a byte-identity claim - a different grid gives a different mask by
  // definition. What must hold is that the document is still the same region:
  // refining the grid should converge the solid fraction, not wander. This is
  // what makes a document better than a baked mask, and step 5 depends on it.
  const w = 1;
  const legLen = 6;
  const Lx = legLen * w + w;
  const fractions = [];
  for (const cpw of [6, 12, 24, 48]) {
    const h = w / cpw;
    const n = Math.round(Lx / h);
    const grid = new StaggeredGrid(n, n, h);
    const mask = sampleDocument(bendDocument({ Lx, Ly: Lx, w, innerRadius: 1 }), grid);
    fractions.push({ cpw, fraction: countMask(mask) / (n * n) });
  }
  // The exact solid fraction, from the continuum areas. Each straight leg runs
  // from the wall to the arc's centre - a length of Lx - ro, not Lx - w, which
  // is where the first version of this test went wrong.
  const ri = 1;
  const ro = ri + w;
  const ductArea = 2 * (Lx - ro) * w + (Math.PI / 4) * (ro * ro - ri * ri);
  const exact = 1 - ductArea / (Lx * Lx);
  const errors = fractions.map((f) => Math.abs(f.fraction - exact));
  assert.ok(
    errors[3] < errors[0],
    `refinement should approach the exact solid fraction: ${errors.map((e) => e.toExponential(2))}`
  );
  assert.ok(errors[3] < 5e-3, `finest grid is ${errors[3].toExponential(2)} from the exact fraction`);
  console.log(
    `[M5 gate 1] solid fraction converging to ${exact.toFixed(6)}: ` +
    fractions.map((f) => `${f.cpw}cpw ${f.fraction.toFixed(6)}`).join(", ")
  );
});

test("M5 - the complement of a closed disk is strictly outside", () => {
  // `d > r` is `not(d <= r)` - the complement of a CLOSED disk.
  // `d >= r` is `not(d <  r)` - the complement of an OPEN disk.
  //
  // bendDocument relies on the first of these to express the duct's outer
  // wall. Swapping them moves the wall by exactly the cells sitting on the
  // radius, and the test below shows the bend has none - so this semantic
  // test is what justifies the choice, since no sampling of that geometry can.
  //
  // (3, 4) is at distance exactly 5 from the origin under both metrics.
  const closed = { kind: "disk", cx: 0, cy: 0, radius: 5, metric: "euclidean", closed: true };
  const open = { ...closed, closed: false };
  assert.equal(Math.hypot(3, 4), 5, "the fixture point must be exactly on the radius");

  assert.equal(testRegion({ not: closed }, 3, 4), false, "d > r must exclude a point on the radius");
  assert.equal(testRegion({ not: open }, 3, 4), true, "d >= r must include it");
  assert.equal(testRegion({ not: closed }, 3, 4.0001), true, "and both must include a point outside");
  assert.equal(testRegion({ not: open }, 3, 4.0001), true);

  // Same under the squared metric, so the derivation does not depend on which.
  const squaredClosed = { ...closed, metric: "squared" };
  assert.equal(testRegion({ not: squaredClosed }, 3, 4), false);
});

test("M5 - no cell centre lands on a bend radius, so gate 1 cannot check that convention", () => {
  // Stated rather than left as a false impression of coverage. A mutation
  // swapping `closed: true` for `false` on the bend's outer radius SURVIVES
  // both gate 1 and the M4 golden fields - not because the gates are weak, but
  // because the geometry never puts a sample point where the two disagree.
  //
  // The cylinder is the opposite case: three of its cell centres land exactly
  // on the radius, so the same mutation there is caught immediately and moves
  // peak |u| by 9%.
  //
  // If this ever becomes non-zero - a new leg length, a new radius, a new
  // resolution - the convention becomes checkable and gate 1 starts covering
  // it. Until then the derivation above is the guarantee.
  const w = 1;
  const legLen = 6;
  const Lx = legLen * w + w;
  const ri = 1;
  const ro = ri + w;
  const cx = Lx - ro;
  const cy = Lx - ro;

  let onRadius = 0;
  for (let cpw = 4; cpw <= 32; cpw++) {
    const h = w / cpw;
    const n = Math.round(Lx / h);
    const grid = new StaggeredGrid(n, n, h);
    for (let j = 1; j <= n; j++) {
      for (let i = 1; i <= n; i++) {
        const { x, y } = grid.cellCentre(i, j);
        const d = Math.hypot(x - cx, y - cy);
        if (d === ri || d === ro) onRadius++;
      }
    }
  }
  assert.equal(onRadius, 0, "if this is non-zero the bend's radius convention became checkable");
  console.log(
    "[M5 gate 1] no cell centre lands on a bend radius across cpw 4..32, so `<` and `<=` " +
    "there are indistinguishable by sampling - the complement test above is what pins it"
  );
});

// ---------------------------------------------------------------------------
// Step 3 - connected regions, and what the solver actually depends on
// ---------------------------------------------------------------------------
//
// These tests encode a demonstration, including the part where the prediction
// was wrong. The guess was that a second fluid region would break the pressure
// solve, because the zero-mean projection removes only one constant while a
// two-region operator has two null directions. Measuring it showed otherwise:
// sealed regions run normally, symmetric or not, and the undetermined constant
// never reaches the velocity because only the pressure GRADIENT is used.
//
// The real dependency is narrower and was invisible until geometry could split
// the domain: flux must balance PER REGION, and the balance was global.

function splitChannel({ cpw = 24, length = 3 }) {
  const h = 1 / cpw;
  const grid = new StaggeredGrid(Math.round(length / h), cpw, h);
  applyDocument(grid, {
    operations: [{ op: "add", region: { kind: "rect", x0: 0, y0: 0.5 - h, x1: length, y1: 0.5 + h } }],
  });
  return {
    grid, h,
    params: {
      nu: 0.02, rho: 1,
      dt: 0.4 * Math.min((0.25 * h * h) / 0.02, h / 4),
      divergenceTol: 1e-7, poissonMaxIterations: 5000,
    },
  };
}

test("M5 - a second fluid region does not break the pressure solve", () => {
  // The prediction that was wrong, kept as a test so it stays wrong. Three
  // geometries with two regions each, none of which the solver should object
  // to. The asymmetric one matters: an earlier version of this check used a
  // centred wall, where mirror symmetry would have hidden a per-region
  // pressure drift.
  const h = 1 / 24;
  const cases = [
    { name: "centred wall", at: 0.5 },
    { name: "off-centre wall", at: 0.3 },
  ];
  const report = [];
  for (const { name, at } of cases) {
    const grid = new StaggeredGrid(24, 24, h);
    applyDocument(grid, {
      operations: [{ op: "add", region: { kind: "rect", x0: at - h, y0: 0, x1: at + h, y1: 1 } }],
    });
    const regions = fluidRegions(grid);
    assert.equal(regions.count, 2, `${name}: expected two regions`);

    const bc = {
      left: { type: "wall" }, right: { type: "wall" },
      bottom: { type: "wall" }, top: { type: "wall", u: 1 },
    };
    const params = { nu: 0.02, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / 0.02, h), divergenceTol: 1e-7 };
    for (let n = 0; n < 300; n++) step(grid, bc, params);

    // Per-region mean pressure must not have wandered off along the null
    // direction the global projection does not remove.
    const means = [0, 0].map((_, r) => {
      let sum = 0, count = 0;
      for (let k = 0; k < regions.label.length; k++) {
        if (regions.label[k] !== r) continue;
        sum += grid.p[k];
        count++;
      }
      return sum / count;
    });
    const divergence = computeDivergence(grid);
    assert.ok(divergence.max < params.divergenceTol, `${name}: max|div| ${divergence.max}`);
    for (const mean of means) {
      assert.ok(Math.abs(mean) < 1e-9, `${name}: per-region mean pressure drifted to ${mean}`);
    }
    report.push(`${name} div ${divergence.max.toExponential(1)} means ${means.map((m) => m.toExponential(1)).join(", ")}`);
  }
  console.log(`[M5 regions] two sealed chambers run normally over 300 steps: ${report.join("; ")}`);
});

test("M5 - a sealed pocket inside an obstacle is legal and inert", () => {
  const { grid, params } = splitChannel({ cpw: 24, length: 3 });
  grid.solid.fill(0);
  applyDocument(grid, {
    operations: [
      { op: "add", region: { kind: "rect", x0: 1.0, y0: 0.2, x1: 1.8, y1: 0.8 } },
      { op: "subtract", region: { kind: "rect", x0: 1.2, y0: 0.35, x1: 1.6, y1: 0.65 } },
    ],
  });
  const regions = fluidRegions(grid);
  assert.equal(regions.count, 2, "the void inside the block is its own region");

  const bc = {
    left: { type: "inflow", u: 1, v: 0 }, right: { type: "outflow" },
    top: { type: "wall" }, bottom: { type: "wall" },
  };
  for (let n = 0; n < 120; n++) step(grid, bc, params);

  // The pocket should be exactly still: no face of it carries flow.
  const pocket = regions.cellCounts[0] < regions.cellCounts[1] ? 0 : 1;
  let peak = 0;
  for (let k = 0; k < regions.label.length; k++) {
    if (regions.label[k] !== pocket) continue;
    peak = Math.max(peak, Math.abs(grid.u[k]), Math.abs(grid.v[k]));
  }
  assert.equal(peak, 0, `the sealed pocket carries velocity ${peak}`);
  assert.ok(computeDivergence(grid).max < 1e-7);

  const analysis = analyseRegions(grid, boundaryPlanFor(grid, bc));
  assert.equal(analysis.filter((r) => r.sealed).length, 1, "one region should be reported sealed");
  assert.match(describeRegions(analysis), /sealed/);
  console.log(`[M5 regions] ${describeRegions(analysis)}`);
});

test("M5 - flux balances per region, not merely globally", () => {
  // The failure the global balance could not see. Both halves have an inlet
  // AND an outlet, so nothing about the drawing looks wrong; they are fed at
  // different rates, so one uniform outflow correction cannot satisfy both.
  // Before per-region balancing this threw at step 1 with the pressure at
  // 9.7e16.
  const { grid, params } = splitChannel({});
  const bc = {
    left: [
      { from: 0, to: 0.5, type: "inflow", u: 2, v: 0 },
      { from: 0.5, to: 1, type: "inflow", u: 1, v: 0 },
    ],
    right: { type: "outflow" },
    top: { type: "wall" },
    bottom: { type: "wall" },
  };
  assert.equal(fluidRegions(grid).count, 2);
  for (let n = 0; n < 120; n++) step(grid, bc, params);

  const divergence = computeDivergence(grid);
  assert.ok(divergence.max < params.divergenceTol, `max|div| ${divergence.max.toExponential(3)}`);

  // Each half must carry its own inlet's flux out of its own outlet.
  const mid = Math.round(grid.nx / 2);
  const half = (from, to) => {
    let q = 0;
    for (let j = from; j <= to; j++) q += grid.u[grid.idx(mid, j)] * grid.h;
    return q;
  };
  const lower = half(1, Math.floor(grid.ny / 2) - 1);
  const upper = half(Math.floor(grid.ny / 2) + 2, grid.ny);
  assert.ok(lower > 1.5 * upper, `the faster half should carry more: ${lower} vs ${upper}`);
  console.log(
    `[M5 regions] per-region balance: lower half carries ${lower.toFixed(4)}, ` +
    `upper ${upper.toFixed(4)}, max|div| ${divergence.max.toExponential(2)}`
  );
});

test("M5 - a region with an inlet and no outlet is rejected by name", () => {
  // The case per-region balancing cannot fix: there is no outflow face to
  // rescale. The old behaviour was a SolverDivergenceError complaining about
  // the pressure solve, which is true and useless. The new one names the
  // region and the likely cause.
  const { grid, params } = splitChannel({});
  const bc = {
    left: [
      { from: 0, to: 0.5, type: "wall" },
      { from: 0.5, to: 1, type: "inflow", u: 1, v: 0 },
    ],
    right: [
      { from: 0, to: 0.5, type: "outflow" },
      { from: 0.5, to: 1, type: "wall" },
    ],
    top: { type: "wall" },
    bottom: { type: "wall" },
  };
  const error = captureThrow(() => {
    for (let n = 0; n < 5; n++) step(grid, bc, params);
  });
  assert.ok(error, "expected a rejection");
  assert.equal(error.name, "SolverGeometryError", `threw ${error.name} instead`);
  assert.equal(error.reason, "unsolvable-region");
  assert.match(error.message, /nothing in it can absorb/);
  assert.match(error.message, /geometry and boundary-condition problem/);
  assert.equal(error.regions.length, 1, "exactly one region should be unsatisfiable");
  assert.ok(error.regions[0].forcedDivergence > params.divergenceTol);
  console.log(
    `[M5 regions] sealed-off inlet rejected: region ${error.regions[0].region} ` +
    `(${error.regions[0].cellCount} cells), forced divergence ` +
    `${error.regions[0].forcedDivergence.toExponential(2)}`
  );
});

test("M5 - a sealed region carrying no flux is never rejected", () => {
  // The inverse guard. Sealed regions have zero net flux and no outflow faces,
  // which is exactly the shape of the rejection condition - so the rejection
  // has to test the flux, not the absence of an outlet.
  const h = 1 / 16;
  const grid = new StaggeredGrid(16, 16, h);
  applyDocument(grid, {
    operations: [{ op: "add", region: { kind: "rect", x0: 0.5 - h, y0: 0, x1: 0.5 + h, y1: 1 } }],
  });
  const bc = {
    left: { type: "wall" }, right: { type: "wall" },
    bottom: { type: "wall" }, top: { type: "wall", u: 1 },
  };
  const params = { nu: 0.02, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / 0.02, h), divergenceTol: 1e-7 };
  assert.equal(fluidRegions(grid).count, 2);
  for (let n = 0; n < 50; n++) step(grid, bc, params);
  assert.ok(computeDivergence(grid).max < params.divergenceTol);
});

test("M5 - connectivity is by shared face, not by corner contact", () => {
  const grid = new StaggeredGrid(4, 4, 0.25);
  applyDocument(grid, {
    operations: [
      { op: "add", region: { kind: "rect", x0: 0, y0: 0, x1: 0.5, y1: 0.5 } },
      { op: "add", region: { kind: "rect", x0: 0.5, y0: 0.5, x1: 1, y1: 1 } },
    ],
  });
  // The two fluid quadrants meet only at a corner. No face is shared, so no
  // flux can cross, so they are separate regions - and the pressure stencil
  // agrees, since it couples only face neighbours.
  const regions = fluidRegions(grid);
  assert.equal(regions.count, 2);
  assert.deepEqual(Array.from(regions.cellCounts), [4, 4]);
});

test("M5 - region labels are cached against the mask version", () => {
  const grid = new StaggeredGrid(12, 12, 1 / 12);
  const first = fluidRegions(grid);
  assert.equal(fluidRegions(grid), first, "an unchanged mask should reuse the labelling");
  applyDocument(grid, { operations: [{ op: "add", region: { kind: "rect", x0: 0, y0: 0, x1: 1, y1: 0.5 } }] });
  const second = fluidRegions(grid);
  assert.notEqual(second, first, "a changed mask must relabel");
  assert.equal(second.count, 1);
});

test("M5 - opposed outlets are rescaled along their own outward normals", () => {
  // The bug the region work uncovered, which is not about regions at all.
  //
  // The flux rescale added a FLAT delta to every outflow face. Influx through
  // a face is sign*value*h, so a flat delta changes the net by delta*h*sum(sign)
  // - zero when outlets face opposite ways. The rescale then did nothing, the
  // domain stayed unbalanced, and the reported divergence looked healthy
  // because the inconsistency lives in the null-space component of the
  // residual, which the zero-mean projection strips out every iteration.
  //
  // Measured on the pre-M5 solver with this exact configuration: divergence
  // reported as 8.115e-8 against an actual max|div u| of 2.950e-1.
  const n = 16;
  const h = 1 / n;
  const grid = new StaggeredGrid(n, n, h);
  for (let j = 0; j <= n + 1; j++) {
    for (let i = 0; i <= n + 1; i++) {
      const { x, y } = grid.cellCentre(i, j);
      grid.u[grid.idx(i, j)] = Math.sin(3 * y) + 0.25 * Math.cos(2 * x);
      grid.v[grid.idx(i, j)] = 0.4 * Math.sin(2 * x) - 0.1 * Math.cos(3 * y);
    }
  }
  const bc = {
    left: { type: "inflow", u: 1, v: 0 },
    right: { type: "outflow" },
    top: { type: "wall" },
    bottom: { type: "outflow" },
  };
  const nu = 0.01;
  const params = { nu, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / nu, h / 2), divergenceTol: 1e-7 };
  for (let k = 0; k < 30; k++) step(grid, bc, params);

  // The measured divergence, not the reported one. These were five to seven
  // orders of magnitude apart before the fix, which is the whole point.
  const measured = computeDivergence(grid).max;
  assert.ok(measured < params.divergenceTol, `max|div u| is ${measured.toExponential(3)}`);

  let net = 0;
  for (let j = 1; j <= n; j++) net += grid.u[grid.idx(0, j)] * h - grid.u[grid.idx(n, j)] * h;
  for (let i = 1; i <= n; i++) net += grid.v[grid.idx(i, 0)] * h - grid.v[grid.idx(i, n)] * h;
  assert.ok(Math.abs(net) < 1e-12, `net flux into the domain is ${net.toExponential(3)}`);
  console.log(
    `[M5 regions] opposed outlets: max|div u| ${measured.toExponential(2)}, ` +
    `net flux ${net.toExponential(2)} (was 2.950e-1 reported as 8.115e-8)`
  );
});

test("M5 - an all-zeroGradient domain is rejected rather than reported healthy", () => {
  // Every side copies its interior velocity and none participates in the flux
  // balance, so nothing can absorb the net flux the domain carries. The
  // pre-M5 solver reported 9.889e-8 as converged for a field whose actual
  // max|div u| was 1.206e-2.
  const n = 16;
  const h = 1 / n;
  const grid = new StaggeredGrid(n, n, h);
  for (let j = 0; j <= n + 1; j++) {
    for (let i = 0; i <= n + 1; i++) {
      const { x, y } = grid.cellCentre(i, j);
      grid.u[grid.idx(i, j)] = Math.sin(3 * y) + 0.25 * Math.cos(2 * x);
      grid.v[grid.idx(i, j)] = 0.4 * Math.sin(2 * x) - 0.1 * Math.cos(3 * y);
    }
  }
  const ZG = { type: "zeroGradient" };
  const nu = 0.01;
  const params = { nu, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / nu, h / 2), divergenceTol: 1e-7 };
  const error = captureThrow(() => {
    for (let k = 0; k < 30; k++) step(grid, { left: ZG, right: ZG, top: ZG, bottom: ZG }, params);
  });
  assert.ok(error, "expected a rejection rather than a healthy-looking divergence");
  assert.equal(error.name, "SolverGeometryError");
  assert.equal(error.reason, "unsolvable-region");
  console.log(
    `[M5 regions] all-zeroGradient domain rejected: forced divergence ` +
    `${error.regions[0].forcedDivergence.toExponential(2)} (was reported as 9.889e-8 converged)`
  );
});

// ---------------------------------------------------------------------------
// Step 4 - conditions attached to drawn surfaces
// ---------------------------------------------------------------------------

test("M5 - a surface attachment selects the faces its region covers", () => {
  const { grid } = channelWithBlock();
  const plan = boundaryPlanFor(grid, {
    ...CHANNEL_BC,
    surfaces: [{ where: BLOCK_UPSTREAM_FACE, type: "inflow", u: -0.5 }],
  });
  const attachment = plan.surfaces.attachments[0];
  assert.equal(attachment.faceCount, 8, "the block's upstream face is 8 cells tall");
  assert.equal(attachment.axisAligned, true);
  assert.equal(attachment.normal, "+x", "fluid on the left means the outward normal is +x");

  // Faces the attachment did not claim keep the default, which is -1.
  let claimed = 0;
  for (let k = 0; k < plan.surfaces.u.length; k++) if (plan.surfaces.u[k] >= 0) claimed++;
  for (let k = 0; k < plan.surfaces.v.length; k++) if (plan.surfaces.v[k] >= 0) claimed++;
  assert.equal(claimed, 8, "only the selected faces are claimed");
  console.log(
    `[M5 surfaces] block upstream face: ${attachment.faceCount} faces, normal ${attachment.normal}`
  );
});

test("M5 - a staircase surface refuses anything that prescribes flux", () => {
  // A circle's surface is a staircase whose faces point four different ways.
  // Prescribing "velocity 1 through this surface" on such a set gives a flow
  // at 45 degrees to the surface rather than through it, so it is refused
  // rather than approximated.
  const grid = new StaggeredGrid(20, 20, 0.05);
  applyDocument(grid, {
    operations: [{ op: "add", region: { kind: "disk", cx: 0.5, cy: 0.5, radius: 0.2, metric: "squared", closed: true } }],
  });
  const box = { left: { type: "wall" }, right: { type: "wall" }, top: { type: "wall" }, bottom: { type: "wall" } };

  for (const condition of [
    { type: "inflow", u: 1 },
    { type: "flowInlet", flowRate: 0.1 },
    { type: "outflow" },
    { type: "pressure", p: 1 },
  ]) {
    const error = captureThrow(() =>
      compileBoundaryConditions(grid, { ...box, surfaces: [{ where: WHOLE_DOMAIN, ...condition }] })
    );
    assert.ok(error, `"${condition.type}" on a staircase should be refused`);
    assert.equal(error.name, "BoundarySpecError");
    assert.match(error.message, /different outward normals/);
    assert.match(error.message, /cut-cell or immersed-boundary/);
  }

  // The orientation-free conditions are allowed on the same surface: a no-slip
  // wall sets the normal component to zero whichever way it points, and free
  // slip copies the tangential component.
  for (const condition of [{ type: "wall" }, { type: "freeSlip" }]) {
    const plan = compileBoundaryConditions(grid, { ...box, surfaces: [{ where: WHOLE_DOMAIN, ...condition }] });
    const attachment = plan.surfaces.attachments[0];
    assert.equal(attachment.axisAligned, false);
    assert.equal(attachment.normals.size, 4, "a circle's staircase faces four ways");
    assert.ok(attachment.faceCount > 0);
  }
  console.log("[M5 surfaces] circle staircase: 4 normals - flux conditions refused, wall and freeSlip allowed");
});

test("M5 - a selector that matches no surface is refused", () => {
  // Silently doing nothing is harder to notice than being told.
  const { grid } = channelWithBlock();
  const error = captureThrow(() =>
    compileBoundaryConditions(grid, {
      ...CHANNEL_BC,
      surfaces: [{ where: { kind: "rect", x0: 2.5, y0: 0.1, x1: 2.6, y1: 0.2 }, type: "wall" }],
    })
  );
  assert.ok(error);
  assert.match(error.message, /selects no faces at all/);
});

test("M5 - a flow-rate inlet on a surface delivers its rate AND stays divergence-free", () => {
  // Both halves matter, and the second is a regression guard. When the flux
  // balance counted surface OUTflow but not surface INflow, this delivered
  // exactly its 0.15 while producing a field whose divergence was 5.3e-2
  // against a bound of 1e-7 - and nothing threw, because the region did have
  // an outlet and the residual could not see the inconsistency.
  const { grid, params } = channelWithBlock();
  const Q = 0.15;
  const bc = {
    ...CHANNEL_BC,
    surfaces: [{ where: BLOCK_UPSTREAM_FACE, type: "flowInlet", flowRate: -Q }],
  };
  const plan = boundaryPlanFor(grid, bc);
  for (let n = 0; n < 300; n++) step(grid, bc, params);

  const divergence = computeDivergence(grid).max;
  assert.ok(divergence < params.divergenceTol, `max|div u| is ${divergence.toExponential(3)}`);

  const delivered = fluxThroughAttachment(grid, plan);
  assert.ok(Math.abs(delivered - Q) < 1e-12, `delivered ${delivered}, asked for ${Q}`);
  console.log(
    `[M5 surfaces] blowing face delivered ${delivered.toFixed(12)} against ${Q}, ` +
    `max|div u| ${divergence.toExponential(2)}`
  );
});

test("M5 - a parabolic profile is refused on a surface", () => {
  // The faces an attachment covers are a set, not a line: there is no
  // unambiguous ordering across them to shape a profile along.
  const { grid } = channelWithBlock();
  const error = captureThrow(() =>
    compileBoundaryConditions(grid, {
      ...CHANNEL_BC,
      surfaces: [{ where: BLOCK_UPSTREAM_FACE, type: "flowInlet", flowRate: 0.1, profile: "parabolic" }],
    })
  );
  assert.ok(error);
  assert.match(error.message, /only the "uniform" profile/);
  assert.match(error.message, /a set, not a line/);
});

test("M5 - pressure on a drawn surface drives flow and stays divergence-free", () => {
  // A closed box with a block whose upstream and downstream faces carry
  // different pressures. Nothing prescribes a velocity anywhere; the
  // projection determines the flow entirely from the two surface pressures.
  const { grid, params } = channelWithBlock();
  const bc = {
    left: { type: "wall" }, right: { type: "wall" },
    top: { type: "wall" }, bottom: { type: "wall" },
    surfaces: [
      { where: BLOCK_UPSTREAM_FACE, type: "pressure", p: 1 },
      { where: BLOCK_DOWNSTREAM_FACE, type: "pressure", p: 0 },
    ],
  };
  const plan = boundaryPlanFor(grid, bc);
  assert.equal(plan.surfaces.hasSurfacePressure, true);
  assert.equal(plan.surfaces.attachments.length, 2);

  for (let n = 0; n < 400; n++) step(grid, bc, params);
  const divergence = computeDivergence(grid).max;
  assert.ok(divergence < params.divergenceTol, `max|div u| is ${divergence.toExponential(3)}`);

  let peak = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      if (!grid.solid[k]) peak = Math.max(peak, Math.hypot(grid.u[k], grid.v[k]));
    }
  }
  assert.ok(peak > 0.1, `the pressure difference should drive a flow, peak speed ${peak}`);
  console.log(
    `[M5 surfaces] surface pressure 1 -> 0 drove a peak speed of ${peak.toFixed(4)}, ` +
    `max|div u| ${divergence.toExponential(2)}`
  );
});

test("M5 - free slip on a surface exerts no drag where a wall does", () => {
  // The tangential treatment, which is what separates the two. A no-slip
  // surface reflects the tangential component about the wall value; free slip
  // copies it out, so the fluid slides past.
  const run = (type) => {
    const { grid, params } = channelWithBlock();
    const bc = { ...CHANNEL_BC, surfaces: [{ where: WHOLE_DOMAIN, type }] };
    for (let n = 0; n < 250; n++) step(grid, bc, params);
    // Speed in the cell column just above the block, where the difference
    // between sliding and sticking shows.
    const j = Math.round(0.75 / grid.h);
    let total = 0;
    let count = 0;
    for (let i = Math.round(1.0 / grid.h); i < Math.round(1.4 / grid.h); i++) {
      total += grid.u[grid.idx(i, j)];
      count++;
    }
    return total / count;
  };
  const noSlip = run("wall");
  const slip = run("freeSlip");
  assert.ok(slip > noSlip, `free slip should be faster over the block: ${slip} vs ${noSlip}`);
  console.log(
    `[M5 surfaces] mean speed over the block: wall ${noSlip.toFixed(4)}, ` +
    `freeSlip ${slip.toFixed(4)} (${((slip / noSlip - 1) * 100).toFixed(1)}% faster)`
  );
});

test("M5 - a moving surface drags the fluid along with it", () => {
  // The tangential ghost inside the body reflects about the surface's own
  // speed rather than about zero. Looked up from the perpendicular face's
  // attachment, which is unambiguous because anything prescribing a value has
  // to be axis-aligned.
  const run = (speed) => {
    const { grid, params } = channelWithBlock();
    const topFace = { kind: "rect", x0: 1.01, y0: 0.69, x1: 1.39, y1: 0.71 };
    const bc = {
      left: { type: "wall" }, right: { type: "wall" },
      top: { type: "wall" }, bottom: { type: "wall" },
      surfaces: [{ where: topFace, type: "wall", u: speed }],
    };
    for (let n = 0; n < 250; n++) step(grid, bc, params);
    const j = Math.round(0.75 / grid.h);
    let total = 0;
    let count = 0;
    for (let i = Math.round(1.05 / grid.h); i < Math.round(1.35 / grid.h); i++) {
      total += grid.u[grid.idx(i, j)];
      count++;
    }
    return total / count;
  };
  const still = run(0);
  const moving = run(1);
  assert.ok(Math.abs(still) < 1e-6, `a stationary surface should drive nothing, got ${still}`);
  assert.ok(moving > 0.05, `a moving surface should drag the fluid, got ${moving}`);
  console.log(
    `[M5 surfaces] surface moving at u = 1 dragged the fluid above it to ${moving.toFixed(4)} ` +
    `(stationary: ${still.toExponential(1)})`
  );
});

// ---------------------------------------------------------------------------
// The deliberate hunt: reductions that count one kind of contribution
// ---------------------------------------------------------------------------
//
// After three bugs of the same shape - unbalanced flux hiding in the
// null-space component of the residual, reported as healthy - the codebase was
// searched for the pattern rather than waiting to trip over a fourth. The
// pattern: a sum, integral or conservation check whose filter drops
// contributions that belong in it.
//
// Three more were found, all exposed by step 4 giving drawn surfaces the
// ability to carry flux. Each is pinned below.

test("M5 hunt - the boundary flux readout counts drawn surfaces", () => {
  // Found: measureBoundaryFlux summed the four domain sides only. With a 0.3
  // surface inlet it reported a net of -0.300 for a field whose divergence was
  // 7e-8 - perfectly balanced, displayed as leaking.
  const { grid, params } = channelWithBlock();
  const bc = {
    ...CHANNEL_BC,
    surfaces: [{ where: BLOCK_UPSTREAM_FACE, type: "flowInlet", flowRate: -0.3 }],
  };
  const plan = boundaryPlanFor(grid, bc);
  for (let n = 0; n < 300; n++) step(grid, bc, params);

  const flux = measureBoundaryFlux(grid, plan);
  assert.ok(
    Math.abs(flux.surfaces.flux - 0.3) < 1e-9,
    `the surface inlet should show 0.3 into the domain, got ${flux.surfaces.flux}`
  );
  // The net is the claim that matters: a divergence-free field must balance.
  assert.ok(Math.abs(flux.net) < 1e-8, `net flux is ${flux.net.toExponential(3)}`);
  assert.ok(computeDivergence(grid).max < params.divergenceTol);
  console.log(
    `[M5 hunt] boundary flux: sides ${(flux.net - flux.surfaces.flux).toExponential(2)}, ` +
    `surfaces ${flux.surfaces.flux.toFixed(6)}, net ${flux.net.toExponential(2)}`
  );
});

test("M5 hunt - region analysis counts conditions on drawn surfaces", () => {
  // Found: analyseRegions visited domain-edge faces only, so a cavity whose
  // only opening is a pressure boundary on an interior surface was reported
  // "sealed - nothing enters or leaves".
  const h = 1 / 20;
  const grid = new StaggeredGrid(40, 20, h);
  applyDocument(grid, {
    operations: [
      { op: "add", region: { kind: "rect", x0: 0.4, y0: 0.15, x1: 1.6, y1: 0.85 } },
      { op: "subtract", region: { kind: "rect", x0: 0.6, y0: 0.3, x1: 1.4, y1: 0.7 } },
    ],
  });
  const bc = {
    left: { type: "wall" }, right: { type: "wall" },
    top: { type: "wall" }, bottom: { type: "wall" },
    surfaces: [{ where: { kind: "rect", x0: 0.59, y0: 0.29, x1: 0.61, y1: 0.71 }, type: "pressure", p: 1 }],
  };
  const plan = boundaryPlanFor(grid, bc);
  const regions = analyseRegions(grid, plan);
  assert.equal(regions.length, 2, "the frame's interior is its own region");

  const withPressure = regions.filter((r) => r.hasPressure);
  assert.equal(withPressure.length, 1, "exactly one region has the pressure boundary");
  assert.equal(withPressure[0].sealed, false, "a region with a pressure boundary is not sealed");
  assert.equal(regions.filter((r) => r.sealed).length, 1, "the outer region is the sealed one");
  console.log(`[M5 hunt] region analysis: ${describeRegions(regions)}`);
});

test("M5 hunt - dye can leave through a drawn outlet", () => {
  // Found: the tracer skipped any face adjacent to solid, which since step 4
  // can carry real flux. In a channel whose only outlet was a drawn surface,
  // fluid left and dye did not - it accumulated 70.4% over 400 steps.
  const { grid, params } = channelWithBlock();
  const bc = {
    left: { type: "inflow", u: 1, v: 0 },
    right: { type: "wall" },
    top: { type: "wall" },
    bottom: { type: "wall" },
    surfaces: [{ where: BLOCK_DOWNSTREAM_FACE, type: "outflow" }],
  };
  const tracer = new PassiveTracer(grid);
  tracer.seed(grid, () => 1);
  const before = tracer.total(grid).total;
  for (let n = 0; n < 400; n++) {
    step(grid, bc, params);
    tracer.advect(grid, bc, params.dt, { inject: { left: () => 1 } });
  }
  const after = tracer.total(grid).total;

  // Dye enters at the inlet and leaves through the drawn outlet, so the total
  // should sit near its starting value rather than climbing without bound.
  const growth = after / before - 1;
  assert.ok(Math.abs(growth) < 0.05, `dye total moved by ${(growth * 100).toFixed(1)}%`);

  // And it must still be bounded and out of the solid.
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      if (grid.solid[k]) assert.equal(tracer.c[k], 0, `dye inside solid at (${i}, ${j})`);
      else assert.ok(tracer.c[k] <= 1 + 1e-6 && tracer.c[k] >= -1e-6, `dye out of range: ${tracer.c[k]}`);
    }
  }
  console.log(
    `[M5 hunt] dye through a drawn outlet: total ${before.toFixed(1)} -> ${after.toFixed(1)} ` +
    `(${(growth * 100).toFixed(1)}%, was +70.4% before the fix)`
  );
});

test("M5 hunt - an unsolvable region is detected from the RHS, not from face bookkeeping", () => {
  // The general detector. Every row of the pure-Neumann operator sums to zero,
  // so sum(residual) === sum(rhs) at every iteration: the inconsistency sits in
  // the right-hand side whatever caused it, and the zero-mean projection is
  // exactly what hides it from the reported residual.
  //
  // This is what makes the check independent of having enumerated boundary
  // faces correctly - which is the dependency that failed three times.
  const { grid, params } = splitChannel({});
  const bc = {
    left: [
      { from: 0, to: 0.5, type: "wall" },
      { from: 0.5, to: 1, type: "inflow", u: 1, v: 0 },
    ],
    right: [
      { from: 0, to: 0.5, type: "outflow" },
      { from: 0.5, to: 1, type: "wall" },
    ],
    top: { type: "wall" },
    bottom: { type: "wall" },
  };
  const error = captureThrow(() => step(grid, bc, params));
  assert.ok(error, "expected the first step to be refused");
  assert.equal(error.name, "SolverGeometryError");
  assert.equal(error.reason, "unsolvable-region");

  // The figure reported is the divergence the inconsistency would force, which
  // is what makes it comparable against the caller's own bound.
  const forced = error.regions[0].forcedDivergence;
  assert.ok(forced > params.divergenceTol);
  assert.ok(forced > 0.1, `forced divergence ${forced.toExponential(2)} should be large here`);
  console.log(
    `[M5 hunt] RHS-derived detector: region ${error.regions[0].region} forces ` +
    `${forced.toExponential(2)} against a bound of ${params.divergenceTol.toExponential(0)}`
  );
});

// ---------------------------------------------------------------------------
// Step 5 - the editing lifecycle
// ---------------------------------------------------------------------------

function maskOf(grid) {
  return Buffer.from(grid.solid.buffer, grid.solid.byteOffset, grid.solid.byteLength).toString("hex");
}

test("M5 - undo and redo return the document and the mask exactly", () => {
  const grid = new StaggeredGrid(24, 24, 1 / 24);
  const editor = new GeometryEditor();
  const snapshots = [];

  const record = () => {
    applyDocument(grid, editor.document);
    snapshots.push(maskOf(grid));
  };
  record();
  editor.append(TOOLS.rectangle(0.2, 0.2, 0.5, 0.5));
  record();
  editor.append(TOOLS.circle(0.7, 0.5, 0.15));
  record();
  editor.append(TOOLS.eraseRectangle(0.3, 0.3, 0.4, 0.4));
  record();

  // Walking back must reproduce each earlier mask byte for byte, not merely a
  // mask with the same shapes in it.
  for (let n = snapshots.length - 2; n >= 0; n--) {
    assert.ok(editor.undo(), "undo should have something to undo");
    applyDocument(grid, editor.document);
    assert.equal(maskOf(grid), snapshots[n], `undo to step ${n} produced a different mask`);
  }
  assert.equal(editor.canUndo, false);

  for (let n = 1; n < snapshots.length; n++) {
    assert.ok(editor.redo());
    applyDocument(grid, editor.document);
    assert.equal(maskOf(grid), snapshots[n], `redo to step ${n} produced a different mask`);
  }
  assert.equal(editor.canRedo, false);
  console.log(`[M5 editing] undo/redo reproduced all ${snapshots.length} masks byte for byte`);
});

test("M5 - a new edit discards the redo branch, and an invalid edit changes nothing", () => {
  const editor = new GeometryEditor();
  editor.append(TOOLS.rectangle(0, 0, 0.5, 0.5)).append(TOOLS.circle(0.8, 0.8, 0.1));
  editor.undo();
  assert.equal(editor.canRedo, true);
  editor.append(TOOLS.circle(0.2, 0.8, 0.1));
  assert.equal(editor.canRedo, false, "a new edit must discard what redo would have replayed");

  // A rejected edit must leave the document and the history untouched, not
  // half-applied.
  const before = JSON.stringify(editor.document);
  const revision = editor.revision;
  const error = captureThrow(() => editor.append({ op: "add", region: { kind: "disk", cx: 0, cy: 0, radius: 1 } }));
  assert.ok(error, "a disk without an explicit metric is invalid");
  assert.equal(JSON.stringify(editor.document), before, "the document changed despite the edit failing");
  assert.equal(editor.revision, revision, "the revision advanced despite the edit failing");
});

test("M5 - a geometry edit restarts the run rather than patching the field", () => {
  const session = new SimulationSession("cylinder");
  for (let n = 0; n < 60; n++) session.advance();
  assert.equal(session.iteration, 60);
  assert.ok(session.simulatedTime > 0);

  session.applyEdit(TOOLS.circle(7.0, 3.0, 0.4));
  assert.equal(session.iteration, 0, "the run must restart");
  assert.equal(session.simulatedTime, 0);
  assert.equal(session.fieldIsStale, false, "the field must be consistent with the new mask");

  // The field must be the scenario's own initial condition, not a patched
  // version of the old one. Compared against a freshly built session carrying
  // the same document.
  const fresh = new SimulationSession("cylinder");
  fresh.applyEdit(TOOLS.circle(7.0, 3.0, 0.4));
  for (const field of ["u", "v", "p"]) {
    assert.ok(
      Buffer.from(session.grid[field].buffer).equals(Buffer.from(fresh.grid[field].buffer)),
      `${field} after an edit differs from a fresh build with the same geometry`
    );
  }

  // And it must be able to run on from there.
  const result = session.advance();
  assert.ok(result.poissonConverged);
  assert.ok(computeDivergence(session.grid).max < session.params.divergenceTol);
  console.log(
    `[M5 editing] edit after 60 steps: restarted at iteration 0, field identical to a fresh ` +
    `build, next step converged at div ${computeDivergence(session.grid).max.toExponential(2)}`
  );
});

test("M5 - newly fluid cells carry the scenario's initial condition, not stale flow", () => {
  // The specific hazard the restart avoids. Carving away part of an obstacle
  // exposes cells that were solid: they have no history, and whatever numbers
  // their slots happened to hold are meaningless.
  const session = new SimulationSession("cylinder");
  for (let n = 0; n < 80; n++) session.advance();

  const wasSolid = [];
  for (let j = 1; j <= session.grid.ny; j++) {
    for (let i = 1; i <= session.grid.nx; i++) {
      if (session.grid.solid[session.grid.idx(i, j)]) wasSolid.push(session.grid.idx(i, j));
    }
  }
  assert.ok(wasSolid.length > 0);

  // Remove the cylinder entirely.
  session.clearGeometry();
  let exposed = 0;
  for (const k of wasSolid) {
    if (session.grid.solid[k]) continue;
    exposed++;
    // The cylinder scenario seeds a uniform stream, so that is what an exposed
    // cell must hold - not zero, and not a leftover from the wake.
    assert.equal(session.grid.u[k], 1, `exposed cell holds ${session.grid.u[k]}, not the seeded stream`);
    assert.equal(session.grid.v[k], 0);
    assert.equal(session.grid.p[k], 0);
  }
  assert.ok(exposed > 100, `expected the cylinder's cells to be exposed, got ${exposed}`);
  console.log(`[M5 editing] ${exposed} cells exposed by erasing the cylinder, all at the seeded initial state`);
});

test("M5 - stepping a field whose mask has moved is refused, however it moved", () => {
  // The guard keys on whether the field is consistent with the mask, which is
  // the property that matters - not on whether the editing API was used. A
  // mask changed by any route counts.
  const session = new SimulationSession("cavity");
  session.advance();

  applyDocument(session.grid, { operations: [{ op: "add", region: { kind: "rect", x0: 0.4, y0: 0, x1: 0.6, y1: 1 } }] });
  assert.equal(session.fieldIsStale, true);

  const error = captureThrow(() => session.advance());
  assert.ok(error, "expected the step to be refused");
  assert.equal(error.name, "StaleFieldError");
  assert.match(error.message, /moving-boundary problem/);

  session.reset();
  assert.equal(session.fieldIsStale, false);
  session.advance();
  console.log("[M5 editing] a mask changed outside the session still trips the guard");
});

test("M5 - the tracer restarts with the field", () => {
  const session = new SimulationSession("cavity");
  const seeded = session.tracer.total(session.grid).total;
  for (let n = 0; n < 40; n++) session.advance();
  session.applyEdit(TOOLS.rectangle(0.45, 0, 0.55, 0.6));
  const after = session.tracer.total(session.grid).total;
  assert.ok(after > 0, "the tracer should be re-seeded, not left empty");
  assert.ok(after < seeded, "and re-seeded against the new mask, which has more solid in it");
  for (let j = 1; j <= session.grid.ny; j++) {
    for (let i = 1; i <= session.grid.nx; i++) {
      const k = session.grid.idx(i, j);
      if (session.grid.solid[k]) assert.equal(session.tracer.c[k], 0, "dye left inside new solid");
    }
  }
});

test("M5 - switching scenario discards a document drawn against the old one", () => {
  // A rectangle drawn at (6, 6) in a 7x7 bend means nothing in a 1x1 cavity.
  const session = new SimulationSession("bend-sharp");
  session.applyEdit(TOOLS.circle(6.5, 6.5, 0.2));
  assert.equal(session.document.operations.length, 2);

  session.load("cavity");
  assert.equal(session.document.operations.length, 0, "the cavity has no geometry of its own");
  assert.equal(session.canUndo, false, "and no history from the previous scenario");
  assert.equal(session.iteration, 0);
});

test("M5 - replaceEdit swaps a shape in place and rebuilds the field", () => {
  // The operation behind moving or resizing a drawn shape. Reached through the
  // session, because that is where the rule about what happens to the field
  // lives - working agreement item 9.
  const session = new SimulationSession("cylinder");
  const pristine = countMask(session.grid.solid);

  session.applyEdit(TOOLS.rectangle(6, 2, 7, 4));
  const withRect = countMask(session.grid.solid);
  assert.ok(withRect > pristine);
  for (let n = 0; n < 5; n++) session.advance();
  assert.ok(session.iteration > 0);

  // Replacing it with a bigger rectangle changes the mask and restarts the run,
  // exactly as adding one does - the domain moved either way.
  session.replaceEdit(1, TOOLS.rectangle(6, 2, 8, 4.5));
  assert.equal(session.iteration, 0, "a replaced shape is still a geometry edit");
  assert.equal(session.editor.size, 2, "and it replaces rather than appends");
  assert.ok(countMask(session.grid.solid) > withRect);
  assert.equal(session.fieldIsStale, false);

  // Out of range is refused rather than silently appending.
  assert.throws(() => session.replaceEdit(9, TOOLS.rectangle(1, 1, 2, 2)), RangeError);
  assert.equal(session.editor.size, 2);
  assert.doesNotThrow(() => session.advance());
});
