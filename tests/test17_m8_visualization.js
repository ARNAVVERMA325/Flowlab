// M8 - visualization modes: vectors, streamlines, pathlines, vorticity,
// continuity.
//
// Three groups, and one absence.
//
//   1. The field as a function of position - the interpolation everything
//      here integrates, and the integrator itself.
//   2. The two curve families, which answer different questions and must be
//      shown to coincide where they are supposed to.
//   3. The two new colour maps, including a regression test for a scale that
//      painted a healthy solve as a catastrophe.
//
// The absence is DENSITY, which the roadmap lists and which does not exist:
// this solver is incompressible with uniform rho. That is asserted rather than
// left implicit, so nobody reads its absence as an oversight.

import test from "node:test";
import assert from "node:assert/strict";

import { StaggeredGrid } from "../geometry/grid.js";
import {
  isFluidAt, traceStep, velocityAt, velocityAtCell,
} from "../physics/velocityField.js";
import { Occupancy, traceStreamline, traceStreamlines } from "../physics/streamlines.js";
import { PathlineSet } from "../tracer/pathlines.js";
import { arrowStride, sampleVectors, drawVectors } from "../visualization/flowOverlay.js";
import { prepareView } from "../visualization/fieldSources.js";
import { SimulationSession } from "../ui/session.js";
import { SCENARIOS, buildScenario } from "../scenarios/index.js";

// Fills every slot, ghosts included, from the analytic field at each
// component's own staggered position.
function fill(grid, uAt, vAt) {
  const { nx, ny, h } = grid;
  for (let j = 0; j <= ny + 1; j++) {
    for (let i = 0; i <= nx + 1; i++) {
      const k = grid.idx(i, j);
      grid.u[k] = uAt(i * h, (j - 0.5) * h);
      grid.v[k] = vAt((i - 0.5) * h, j * h);
    }
  }
}

// Solid-body rotation about the domain centre: every streamline is a circle,
// so any drift in radius is integration error and nothing else.
function rotation(grid, omega) {
  const cx = (grid.nx * grid.h) / 2;
  const cy = (grid.ny * grid.h) / 2;
  fill(grid, (_x, y) => -omega * (y - cy), (x) => omega * (x - cx));
  return { cx, cy };
}

// ---------------------------------------------------------------------------
// The field as a function of position
// ---------------------------------------------------------------------------

test("M8 - interpolation is exact on a linear field, with the right offsets", () => {
  // u and v live at DIFFERENT staggered positions, so each needs its own index
  // offset. Getting one wrong shifts that component by half a cell, which
  // still looks like a flow. Exactness on a linear field is what catches it:
  // any half-cell slip becomes a constant error of a*h/2.
  const grid = new StaggeredGrid(9, 7, 0.25);
  fill(grid, (x) => 3 * x + 1, (_x, y) => -2 * y);

  let worst = 0;
  for (let n = 0; n < 500; n++) {
    const x = ((n * 37) % 100) / 100 * grid.nx * grid.h;
    const y = ((n * 53) % 100) / 100 * grid.ny * grid.h;
    const { u, v } = velocityAt(grid, x, y);
    worst = Math.max(worst, Math.abs(u - (3 * x + 1)), Math.abs(v - -2 * y));
  }
  assert.ok(worst < 1e-12, `bilinear error on a linear field: ${worst}`);

  // And the interpolated value at a cell centre is the cell-centred one, which
  // is what says the two ways of reading the field agree where they overlap.
  for (const [i, j] of [[2, 3], [5, 5], [9, 7]]) {
    const { x, y } = grid.cellCentre(i, j);
    const interpolated = velocityAt(grid, x, y);
    const centred = velocityAtCell(grid, i, j);
    assert.ok(Math.abs(interpolated.u - centred.u) < 1e-12, `u at ${i},${j}`);
    assert.ok(Math.abs(interpolated.v - centred.v) < 1e-12, `v at ${i},${j}`);
  }
  console.log(`[M8 interpolation] exact on a linear field to ${worst.toExponential(1)}`);
});

test("M8 - a trajectory has no direction to follow at a stagnation point", () => {
  const grid = new StaggeredGrid(6, 6, 0.5);
  // Everything zero: no direction anywhere.
  assert.equal(traceStep(grid, 1.0, 1.0, 0.1), null);

  // And a non-finite cell yields null rather than a NaN position that would
  // be integrated onward as though it were somewhere.
  fill(grid, () => 1, () => 0);
  grid.u[grid.idx(3, 3)] = NaN;
  const broken = traceStep(grid, 3 * 0.5, 3 * 0.5 - 0.25, 0.1);
  assert.equal(broken, null);

  // Outside the fluid is outside, in every direction and inside a body.
  const walled = new StaggeredGrid(6, 6, 0.5);
  walled.solid[walled.idx(3, 3)] = 1;
  // Cell (3,3) spans [1.0, 1.5) in both axes, so both of these land in it.
  assert.equal(isFluidAt(walled, 1.2, 0.9), true, "cell 3,2 is fluid");
  assert.equal(isFluidAt(walled, 1.2, 1.2), false, "cell 3,3 is solid");
  assert.equal(isFluidAt(walled, 1.2, 1.4), false, "and so is its far corner");
  assert.equal(isFluidAt(walled, -0.01, 1), false);
  assert.equal(isFluidAt(walled, 1, 3.0), false, "the domain ends at 3.0");
  assert.equal(isFluidAt(walled, NaN, 1), false);
});

test("M8 - the midpoint step holds a circle that Euler spirals out of", () => {
  // The justification for RK2 over Euler, measured rather than asserted. A
  // streamline through a vortex is the case these are most used to look at,
  // and Euler's radius grows without bound there - drawing a recirculation
  // that is decaying when the simulation's is not.
  const grid = new StaggeredGrid(40, 40, 0.05);
  const { cx, cy } = rotation(grid, 2.0);
  const radius = 0.5;
  const ds = grid.h / 2;
  const steps = 900;

  const drift = (stepper) => {
    let x = cx + radius;
    let y = cy;
    let worst = 0;
    for (let n = 0; n < steps; n++) {
      const next = stepper(x, y);
      if (next === null) break;
      x = next.x;
      y = next.y;
      worst = Math.max(worst, Math.abs(Math.hypot(x - cx, y - cy) - radius));
    }
    return worst;
  };

  const euler = drift((x, y) => {
    const { u, v } = velocityAt(grid, x, y);
    const speed = Math.hypot(u, v);
    if (speed === 0) return null;
    return { x: x + (u / speed) * ds, y: y + (v / speed) * ds };
  });
  const midpoint = drift((x, y) => traceStep(grid, x, y, ds));

  assert.ok(midpoint < euler / 10, `midpoint ${midpoint}, Euler ${euler}`);
  assert.ok(midpoint < 0.02 * radius, `midpoint drifts ${(midpoint / radius * 100).toFixed(2)}%`);
  console.log(
    `[M8 integrator] radius drift over ${steps} steps: Euler ` +
    `${(euler / radius * 100).toFixed(1)}%, midpoint ${(midpoint / radius * 100).toFixed(2)}%`
  );
});

// ---------------------------------------------------------------------------
// Streamlines
// ---------------------------------------------------------------------------

test("M8 - streamlines follow a uniform field and span the domain", () => {
  const grid = new StaggeredGrid(40, 20, 0.1);
  fill(grid, () => 2, () => 0);
  const lines = traceStreamlines(grid, { spacing: grid.h * 5 });

  assert.ok(lines.length > 0);
  for (const line of lines) {
    const ys = line.points.map((p) => p.y);
    const spread = Math.max(...ys) - Math.min(...ys);
    assert.ok(spread < 1e-9, `a streamline in uniform x-flow wandered ${spread} in y`);
  }
  // Bidirectional: the curve passes THROUGH its seed, so it reaches both
  // edges rather than starting at the seed and running one way.
  const widest = lines.reduce((best, line) => {
    const xs = line.points.map((p) => p.x);
    return Math.max(best, Math.max(...xs) - Math.min(...xs));
  }, 0);
  assert.ok(widest > 0.9 * grid.nx * grid.h, `widest line spans ${widest} of ${grid.nx * grid.h}`);
});

test("M8 - a streamline in a vortex closes instead of redrawing itself", () => {
  const grid = new StaggeredGrid(40, 40, 0.05);
  const { cx, cy } = rotation(grid, 2.0);
  const line = traceStreamline(grid, { x: cx + 0.4, y: cy }, { ds: grid.h / 2, maxSteps: 4000 });
  assert.notEqual(line, null);
  assert.equal(line.closed, true, "a closed streamline must be detected as closed");
  // One circuit, not many: 2*pi*0.4 / (h/2) is about 100 steps a lap.
  assert.ok(line.points.length < 300, `${line.points.length} points is more than one lap`);
});

test("M8 - no streamline enters a solid, and no two share an occupancy cell", () => {
  // Two invariants of the tracer, checked on every real scenario rather than
  // on a constructed case: a curve drawn through a wall is the most obviously
  // wrong thing this could produce, and bundling is what the occupancy grid
  // exists to prevent.
  for (const scenario of SCENARIOS) {
    const session = new SimulationSession(scenario.id);
    for (let n = 0; n < 40; n++) session.advance();
    const grid = session.grid;
    const spacing = grid.h * 6;
    const lines = traceStreamlines(grid, { spacing, ds: grid.h / 2 });

    for (const line of lines) {
      for (const point of line.points) {
        assert.ok(
          isFluidAt(grid, point.x, point.y),
          `${scenario.id}: a streamline reached (${point.x}, ${point.y}), which is not fluid`
        );
      }
    }

    // Re-walk the lines through a fresh occupancy grid at the separation
    // length: EVERY point of every line must be claimable by its own line,
    // which is true only if no two lines share a cell. That is the separation
    // the algorithm exists to provide, and this is what caught the two ways it
    // was leaking - a rejected line keeping its cells, and the seed point
    // never being claimed at all.
    const occupancy = new Occupancy(grid, spacing / 2);
    let shared = 0;
    lines.forEach((line, id) => {
      for (const point of line.points) {
        if (occupancy.claim(point.x, point.y, id) < 0) shared++;
      }
    });
    assert.equal(shared, 0, `${scenario.id}: ${shared} points fall in another line's cell`);
  }
});

test("M8 - the same field traces the same streamlines twice", () => {
  // A set of lines that reshuffles between frames is unreadable even when
  // every individual line is correct, so the seeding walks a fixed order.
  const session = new SimulationSession("cavity");
  for (let n = 0; n < 30; n++) session.advance();
  const first = traceStreamlines(session.grid, { spacing: session.grid.h * 6 });
  const second = traceStreamlines(session.grid, { spacing: session.grid.h * 6 });
  assert.equal(first.length, second.length);
  for (let n = 0; n < first.length; n++) {
    assert.deepEqual(first[n].points, second[n].points, `line ${n} differs between traces`);
  }
  console.log(`[M8 streamlines] cavity: ${first.length} lines, reproducible`);
});

// ---------------------------------------------------------------------------
// Pathlines
// ---------------------------------------------------------------------------

test("M8 - in a steady flow a pathline traces the streamline through it", () => {
  // The claim that makes having both worth it. A streamline is tangent to the
  // field at one instant; a pathline is a parcel's history. Where the field
  // does not change, the two are the same curve - and where it does, they are
  // not, which is why a snapshot cannot produce the second.
  const grid = new StaggeredGrid(40, 40, 0.05);
  const { cx, cy } = rotation(grid, 2.0);

  const start = { x: cx + 0.4, y: cy };
  const streamline = traceStreamline(grid, start, { ds: grid.h / 4, maxSteps: 4000 });

  // A parcel released at the same point, advanced in time through the same
  // unchanging field.
  const set = new PathlineSet(grid, { count: 0, trail: 100000 });
  set.spawnable = [[1, 1]];
  const parcel = { x: start.x, y: start.y, trail: [{ ...start, speed: 0 }], age: 0 };
  set.particles.push(parcel);
  for (let n = 0; n < 400; n++) set.advance(grid, 0.002);

  // Both should lie on the same circle. Compared by radius rather than
  // point-by-point, because the two are parameterised differently by
  // construction - one by arc length, one by time.
  const radiusOf = (points) => {
    let worst = 0;
    for (const p of points) {
      worst = Math.max(worst, Math.abs(Math.hypot(p.x - cx, p.y - cy) - 0.4));
    }
    return worst;
  };
  const streamlineDrift = radiusOf(streamline.points);
  const pathlineDrift = radiusOf(parcel.trail);
  assert.ok(streamlineDrift < 0.004, `streamline drifts ${streamlineDrift}`);
  assert.ok(pathlineDrift < 0.004, `pathline drifts ${pathlineDrift}`);
  console.log(
    `[M8 steady flow] the same circle either way: streamline off by ` +
    `${streamlineDrift.toExponential(2)}, pathline by ${pathlineDrift.toExponential(2)} ` +
    `on a radius of 0.4`
  );
});

test("M8 - parcels stay in the fluid, and are respawned rather than clamped", () => {
  for (const id of ["cylinder", "jet"]) {
    const session = new SimulationSession(id);
    for (let n = 0; n < 120; n++) session.advance();
    const grid = session.grid;
    for (const particle of session.pathlines.particles) {
      assert.ok(
        isFluidAt(grid, particle.x, particle.y),
        `${id}: a parcel is at (${particle.x}, ${particle.y}), which is not fluid`
      );
      for (const point of particle.trail) {
        assert.ok(isFluidAt(grid, point.x, point.y), `${id}: a trail point left the fluid`);
      }
      assert.ok(particle.trail.length <= session.pathlines.trail, "trails are bounded");
    }
    // Something must actually have left - otherwise this proves nothing about
    // respawning, only about a flow that happens to recirculate.
    const young = session.pathlines.particles.filter((p) => p.age < 120).length;
    assert.ok(young > 0, `${id}: no parcel left the domain in 120 steps`);
    console.log(`[M8 pathlines] ${id}: ${young} of ${session.pathlines.count} parcels respawned`);
  }
});

test("M8 - pathlines are deterministic and write nothing to the field", () => {
  const session = new SimulationSession("cavity");
  for (let n = 0; n < 20; n++) session.advance();
  const before = {
    u: Float64Array.from(session.grid.u),
    v: Float64Array.from(session.grid.v),
    p: Float64Array.from(session.grid.p),
  };
  const a = new PathlineSet(session.grid, { count: 40 });
  const b = new PathlineSet(session.grid, { count: 40 });
  assert.deepEqual(
    a.particles.map((p) => [p.x, p.y]),
    b.particles.map((p) => [p.x, p.y]),
    "the same scenario must seed the same parcels"
  );
  for (let n = 0; n < 50; n++) { a.advance(session.grid, 1e-3); b.advance(session.grid, 1e-3); }
  assert.deepEqual(a.particles.map((p) => [p.x, p.y]), b.particles.map((p) => [p.x, p.y]));

  assert.deepEqual(Float64Array.from(session.grid.u), before.u, "a parcel must not write to u");
  assert.deepEqual(Float64Array.from(session.grid.v), before.v);
  assert.deepEqual(Float64Array.from(session.grid.p), before.p);

  // A non-advancing step is not a step: a zero or broken dt must move nothing.
  const held = a.particles.map((p) => [p.x, p.y]);
  a.advance(session.grid, 0);
  a.advance(session.grid, NaN);
  assert.deepEqual(a.particles.map((p) => [p.x, p.y]), held);
});

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

test("M8 - arrows are spaced by display pixels and never drawn in a wall", () => {
  const session = new SimulationSession("cylinder");
  for (let n = 0; n < 30; n++) session.advance();
  const grid = session.grid;

  // Tighter zoom, tighter stride - the whole point of deriving it from the
  // scale rather than fixing a cell count.
  assert.ok(arrowStride(2) > arrowStride(9), "a zoomed-in view needs a smaller stride");
  assert.equal(arrowStride(0), 1);
  assert.equal(arrowStride(NaN), 1);

  const sampled = sampleVectors(grid, { stride: arrowStride(5) });
  assert.ok(sampled.arrows.length > 0);
  for (const arrow of sampled.arrows) {
    const i = Math.floor(arrow.x / grid.h) + 1;
    const j = Math.floor(arrow.y / grid.h) + 1;
    assert.equal(grid.solid[grid.idx(i, j)], 0, "an arrow was placed inside a body");
    assert.ok(Math.abs(Math.hypot(arrow.dx, arrow.dy) - 1) < 1e-12, "direction must be a unit vector");
    assert.ok(arrow.length > 0 && arrow.length <= sampled.stride, "length is bounded by the stride");
  }

  // The reference speed must not depend on how coarsely the field is sampled,
  // or the arrow colours shift with the zoom while the picture beneath them
  // does not. It did, at 1.396 against 1.489 for the same field.
  const coarse = sampleVectors(grid, { stride: 6 });
  const fine = sampleVectors(grid, { stride: 2 });
  assert.equal(coarse.reference, fine.reference);

  // And the cap holds however small a stride is asked for.
  const capped = sampleVectors(grid, { stride: 1, maxArrows: 500 });
  assert.ok(capped.arrows.length <= 500, `${capped.arrows.length} arrows past a cap of 500`);
  assert.ok(capped.stride > 1, "the cap must widen the stride rather than truncate the list");
});

test("M8 - an arrow pointing up the domain is drawn pointing up the canvas", () => {
  // Canvas y runs down and physical y runs up. A missing flip mirrors the
  // whole field and produces a picture that is entirely plausible and wrong,
  // so the sign is asserted through the drawing code rather than trusted.
  const grid = new StaggeredGrid(8, 8, 0.5);
  fill(grid, () => 0, () => 1);   // straight up
  const sampled = sampleVectors(grid, { stride: 4 });
  assert.ok(sampled.arrows.length > 0);

  const moves = [];
  const context = {
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, closePath() {},
    moveTo(x, y) { moves.push(["moveTo", x, y]); },
    lineTo(x, y) { moves.push(["lineTo", x, y]); },
  };
  drawVectors(context, sampled, {
    originX: 0, originY: 0, scale: 10, h: grid.h, ny: grid.ny,
  }, {});

  // The first shaft: moveTo tail then lineTo tip. Up the canvas is a SMALLER y.
  const tail = moves.find((m) => m[0] === "moveTo");
  const tip = moves.find((m) => m[0] === "lineTo");
  assert.ok(tip[2] < tail[2], `tip y ${tip[2]} should be above tail y ${tail[2]}`);
  assert.ok(Math.abs(tip[1] - tail[1]) < 1e-9, "a purely vertical arrow must not lean");
});

// ---------------------------------------------------------------------------
// The two new colour maps
// ---------------------------------------------------------------------------

test("M8 - the vorticity scale is centred on zero, not on the field's mean", () => {
  // Pressure's datum is arbitrary so its picture must be relative to the mean.
  // Vorticity has a physical zero, and shifting it would paint irrotational
  // fluid as rotating.
  const grid = new StaggeredGrid(30, 30, 0.1);
  rotation(grid, 1.5);   // vorticity is 2*1.5 = 3 everywhere, mean 3

  const view = prepareView("vorticity", { grid });
  assert.equal(view.scale.centre, 0);
  assert.equal(view.scale.diverging, true);
  // Every cell reads 3, so a mean-centred scale would paint the whole field at
  // the centre stop. A zero-centred one puts it firmly on one arm.
  const painted = view.normalise(view.valueAt(15, 15));
  assert.ok(painted > 0.9, `uniform rotation should not paint as still fluid (${painted})`);
});

test("M8 - a healthy solve does not paint as a broken one", () => {
  // The regression test for a scale that did exactly that.
  //
  // The continuity view is fixed rather than fitted, which was the right call
  // and was not enough: the first version anchored it at the solver's
  // divergence tolerance, and a converged solve stops AT its tolerance rather
  // than far below it. Measured max|div u| across these scenarios is 7.7e-8 to
  // 9.8e-8 against a bound of 1e-7 - so every cell landed at half to all of
  // the ramp, and a perfectly healthy cylinder run rendered as a full-contrast
  // noise field. It looked like a catastrophic failure. Anchoring a decade
  // past the bound instead puts the same field inside the innermost tenth.
  for (const scenario of SCENARIOS) {
    const session = new SimulationSession(scenario.id);
    for (let n = 0; n < 60; n++) session.advance();
    const grid = session.grid;
    const view = prepareView("continuity", {
      grid, sources: session.sources === null ? null : null,
      divergenceTol: session.params.divergenceTol,
    });

    let worst = 0;
    for (let j = 1; j <= grid.ny; j++) {
      for (let i = 1; i <= grid.nx; i++) {
        if (grid.solid[grid.idx(i, j)]) continue;
        worst = Math.max(worst, Math.abs(view.normalise(view.valueAt(i, j)) - 0.5));
      }
    }
    assert.ok(
      worst < 0.2,
      `${scenario.id}: a healthy field reaches ${(worst * 2 * 100).toFixed(0)}% of the ` +
      `ramp - that is a picture of a broken simulation`
    );
    assert.equal(view.scale.breached.cells, 0, `${scenario.id} breached its own bound`);
    // The scale is a decade past the promise, and the promise is what gets
    // counted against.
    assert.ok(Math.abs(view.scale.hi / view.scale.bound - 10) < 1e-9);
    assert.equal(view.scale.fixed, true);
  }
});

test("M8 - the continuity scale does not move when the field does", () => {
  // Fixed means fixed. A scale that quietly re-fitted itself would make two
  // frames incomparable, which is the one thing this view is for.
  const session = new SimulationSession("cavity");
  const scaleOf = () => prepareView("continuity", {
    grid: session.grid, sources: null, divergenceTol: session.params.divergenceTol,
  }).scale;
  const first = scaleOf();
  for (let n = 0; n < 50; n++) session.advance();
  const later = scaleOf();
  assert.equal(first.lo, later.lo);
  assert.equal(first.hi, later.hi);

  // A breach is counted against the solver's bound, not against the scale.
  session.grid.u[session.grid.idx(10, 10)] += 1;
  const broken = scaleOf();
  assert.ok(broken.breached.cells > 0, "a deliberately unbalanced cell must be reported");
  assert.ok(broken.breached.worst > broken.bound);
  assert.equal(broken.hi, first.hi, "and must not move the scale");
});

test("M8 - a broken field withholds the vorticity scale", () => {
  // Same rule every other view follows: a scale drawn from the survivors of a
  // partly non-finite field is not a scale anyone should read a value off.
  const session = new SimulationSession("cavity");
  session.advance();
  session.grid.u[session.grid.idx(5, 5)] = NaN;
  const view = prepareView("vorticity", { grid: session.grid });
  assert.ok(Number.isNaN(view.scale.lo) && Number.isNaN(view.scale.hi));
  assert.ok(Number.isNaN(view.normalise(view.valueAt(20, 20))));
});

// ---------------------------------------------------------------------------
// The absence
// ---------------------------------------------------------------------------

test("M8 - there is no density field, and that is a property of the solver", () => {
  // The roadmap lists "density" among M8's views. It does not exist and cannot
  // be drawn: this is an incompressible solver with a single uniform rho, so a
  // density picture would be one flat colour in every scenario at every
  // instant. Asserted rather than left as an omission, so the next reader can
  // see it was decided rather than forgotten. A genuine density field needs a
  // compressible or variable-density formulation, which is V2 at the earliest.
  for (const scenario of SCENARIOS) {
    const built = buildScenario(scenario.id);
    assert.equal(typeof built.params.rho, "number",
      `${scenario.id}: rho is a scalar parameter, not a field`);
    assert.ok(built.params.rho > 0);
    assert.equal(built.grid.rho, undefined, `${scenario.id}: the grid carries no density array`);
  }
  console.log(
    `[M8 density] all ${SCENARIOS.length} scenarios carry rho as a single constant - ` +
    `there is no field to draw`
  );
});
