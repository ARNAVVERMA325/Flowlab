// M6 step 5 - editing boundary conditions.
//
// The roadmap lists "full-wall inlet" under this milestone. The numerics for it
// already exist: M4 delivered inflow, flow-rate and pressure conditions on a
// whole side or a segment, and M5 attached them to drawn surfaces. What did not
// exist was any way to CHANGE one without editing a scenario file. So this step
// is a UI and a plumbing step, and these tests are about the two things that
// plumbing can get wrong.

import test from "node:test";
import assert from "node:assert/strict";

import { StaggeredGrid } from "../geometry/grid.js";
import { step, computeDivergence, boundaryPlanFor } from "../solver/ns2d.js";
import { computeStableTimestep, peakCellSpeed } from "../solver/stability.js";
import { BoundaryEditor, BoundaryEditError, fieldsFor } from "../boundaries/editor.js";
import { BOUNDARY_TYPES, SIDES } from "../boundaries/conditions.js";
import { SimulationSession } from "../ui/session.js";

const CHANNEL = {
  left: { type: "inflow", u: 1, v: 0 },
  right: { type: "outflow" },
  top: { type: "wall" },
  bottom: { type: "wall" },
};

function captureThrow(fn) {
  try { fn(); return null; } catch (error) { return error; }
}

function channel({ n = 24, nu = 0.02 } = {}) {
  const h = 1 / n;
  return {
    grid: new StaggeredGrid(n, n, h), h, nu,
    params: { nu, rho: 1, divergenceTol: 1e-7, poissonMaxIterations: 20000 },
  };
}

function march(grid, bc, params, nu, steps, previousTimestep = null) {
  let prev = previousTimestep;
  let worstDiv = 0;
  let worstCfl = 0;
  let error = null;
  let done = 0;
  try {
    for (; done < steps; done++) {
      const sel = computeStableTimestep(grid, { nu, safety: 0.4, previousTimestep: prev });
      prev = sel.dt;
      step(grid, bc, { ...params, dt: sel.dt });
      worstDiv = Math.max(worstDiv, computeDivergence(grid).max);
      worstCfl = Math.max(worstCfl, (sel.dt * peakCellSpeed(grid).peak) / grid.h);
    }
  } catch (e) { error = e; }
  return { prev, worstDiv, worstCfl, error, done };
}

// ---------------------------------------------------------------------------
// The stale-plan trap
// ---------------------------------------------------------------------------

test("M6 - a specification mutated in place returns the STALE compiled plan", () => {
  // This is why the editor hands out frozen objects, and it is not
  // hypothetical: boundaryPlanFor caches on the specification object and
  // validates the cache against grid dimensions and mask version, neither of
  // which changes when a condition's value does. An editor that mutated in
  // place would leave the solver running the previous boundary condition with
  // nothing at all to say so.
  const { grid } = channel();
  const bc = {
    left: { type: "inflow", u: 1, v: 0 }, right: { type: "outflow" },
    top: { type: "wall" }, bottom: { type: "wall" },
  };
  const before = boundaryPlanFor(grid, bc);
  const readLeft = (plan) => plan.conditions[plan.faces.left[5]].u;
  assert.equal(readLeft(before), 1);

  bc.left.u = 7;
  const after = boundaryPlanFor(grid, bc);
  assert.equal(after, before, "the cache returns the same plan object");
  assert.equal(readLeft(after), 1, "and it still carries the OLD velocity");

  // A new object compiles correctly, which is what the editor produces.
  const fresh = boundaryPlanFor(grid, { ...bc, left: { type: "inflow", u: 7, v: 0 } });
  assert.equal(readLeft(fresh), 7);
  console.log(
    `[M6 step 5] mutating a spec in place leaves the plan reading u = ${readLeft(after)} ` +
    `after being set to 7; a fresh object reads ${readLeft(fresh)}`
  );
});

test("M6 - the editor's specifications cannot be mutated in place at all", () => {
  // Frozen, so the mistake above is a TypeError where it is made rather than a
  // stale plan discovered later. This file is an ES module and therefore strict
  // mode, which is what makes the assignment throw instead of failing silently
  // - and every consumer in this project is a module too.
  const editor = new BoundaryEditor(CHANNEL);
  assert.throws(() => { editor.spec.left.u = 99; }, TypeError);
  assert.throws(() => { editor.spec.left = { type: "wall" }; }, TypeError);
  assert.equal(editor.spec.left.u, 1);

  // And the specification it was constructed from is not captured by reference.
  const source = { ...CHANNEL, left: { type: "inflow", u: 1, v: 0 } };
  const copied = new BoundaryEditor(source);
  source.left.u = 5;
  assert.equal(copied.spec.left.u, 1, "the editor copied rather than aliased");
});

// ---------------------------------------------------------------------------
// A boundary edit keeps the field
// ---------------------------------------------------------------------------

test("M6 - changing a boundary mid-run holds the divergence bound without a restart", () => {
  // The opposite rule to a geometry edit, and the reason is that the domain
  // still exists: the field remains a valid state of it, and the change is a
  // real physical event. Measured over four changes on a settled channel.
  const rows = [];
  for (const [label, changed] of [
    ["wall -> inlet", { ...CHANNEL, top: { type: "inflow", u: 0, v: -1 } }],
    ["inlet 1 -> 4", { ...CHANNEL, left: { type: "inflow", u: 4, v: 0 } }],
    ["inlet -> wall", { ...CHANNEL, left: { type: "wall" } }],
    ["wall -> free-slip", { ...CHANNEL, top: { type: "freeSlip" } }],
  ]) {
    const { grid, params, nu } = channel();
    const settle = march(grid, CHANNEL, params, nu, 200);
    assert.equal(settle.error, null);
    const after = march(grid, changed, params, nu, 120, settle.prev);
    assert.equal(after.error, null, `${label} should not need a restart: ${after.error?.message}`);
    assert.ok(
      after.worstDiv <= params.divergenceTol,
      `${label}: max|div u| reached ${after.worstDiv.toExponential(3)}`
    );
    rows.push(`${label} div ${after.worstDiv.toExponential(2)} CFL ${after.worstCfl.toFixed(3)}`);
  }
  console.log(`[M6 step 5] boundary changes on a running flow: ${rows.join("; ")}`);
});

test("M6 - a boundary change that makes the domain unsolvable is refused", () => {
  // Sealing the only outlet while an inlet keeps running. No new machinery:
  // this is the same detector that refuses an unsolvable scenario definition.
  const { grid, params, nu } = channel();
  march(grid, CHANNEL, params, nu, 200);
  const sealed = { ...CHANNEL, right: { type: "wall" } };
  const after = march(grid, sealed, params, nu, 10);
  assert.ok(after.error, "sealing the outlet must not run quietly");
  assert.equal(after.error.name, "SolverGeometryError");
  assert.equal(after.error.reason, "unsolvable-region");
  assert.equal(after.done, 0, "and it refuses before taking the step");
  console.log(
    `[M6 step 5] sealing the outlet under a live inlet: ${after.error.name}, ` +
    `forced ${after.error.regions[0].forcedDivergence.toExponential(3)}`
  );
});

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

test("M6 - editing a side produces a new specification and advances the revision", () => {
  const editor = new BoundaryEditor(CHANNEL);
  const first = editor.spec;
  assert.equal(editor.revision, 0);
  assert.equal(editor.canUndo, false);

  editor.setSide("top", { type: "inflow", u: 0, v: -1 });
  assert.notEqual(editor.spec, first, "an edit must produce a new object");
  assert.equal(editor.spec.top.type, "inflow");
  assert.equal(first.top.type, "wall", "the previous specification is unchanged");
  assert.equal(editor.revision, 1);
  assert.equal(editor.canUndo, true);

  editor.undo();
  assert.equal(editor.spec.top.type, "wall");
  editor.redo();
  assert.equal(editor.spec.top.type, "inflow");
  assert.equal(editor.spec.top.v, -1);
});

test("M6 - the editor refuses what the compiler would refuse, leaving history intact", () => {
  const { grid } = channel();
  const editor = new BoundaryEditor(CHANNEL, (spec) => {
    boundaryPlanFor(new StaggeredGrid(grid.nx, grid.ny, grid.h), spec);
  });
  editor.setSide("top", { type: "inflow", u: 0, v: -1 });
  const good = editor.spec;

  // An inlet with no prescribed normal component is what M4 rejects.
  const error = captureThrow(() => editor.setSide("left", { type: "inflow" }));
  assert.ok(error, "an incomplete inlet must be refused");
  assert.equal(editor.spec, good, "and the editor is left exactly as it was");
  assert.equal(editor.revision, 1, "a refused edit does not advance the revision");

  assert.ok(captureThrow(() => editor.setSide("sideways", { type: "wall" })));
  assert.ok(captureThrow(() => editor.setSide("left", { type: "teleport" })));
  assert.equal(editor.revision, 1);
});

test("M6 - the form's fields come from the type table, not a hand-written list", () => {
  // The M4 dedup key's lesson applied to a form: a list of parameters written
  // out by hand is a list that will be out of date the first time a type gains
  // one. Every type must describe its own.
  for (const [type, spec] of Object.entries(BOUNDARY_TYPES)) {
    for (const side of SIDES) {
      const fields = fieldsFor(type, side);
      assert.equal(fields.label, spec.label);
      assert.ok(Array.isArray(fields.required) && Array.isArray(fields.optional));
      assert.ok(typeof fields.summary === "string" && fields.summary.length > 0);
    }
  }
  // Spot-checks that the side actually matters - the normal component differs.
  assert.deepEqual(fieldsFor("inflow", "left").required, ["u"]);
  assert.deepEqual(fieldsFor("inflow", "top").required, ["v"]);
  assert.deepEqual(fieldsFor("pressure", "left").required, ["p"]);
  assert.deepEqual(fieldsFor("flowInlet", "left").required, ["flowRate"]);
  assert.ok(captureThrow(() => fieldsFor("nonsense", "left")) instanceof BoundaryEditError);
});

// ---------------------------------------------------------------------------
// Through the session, which is the path the app takes
// ---------------------------------------------------------------------------

test("M6 - a boundary edit through the session does not restart the run", () => {
  const session = new SimulationSession("cylinder");
  for (let n = 0; n < 20; n++) session.advance();
  const iteration = session.iteration;
  const time = session.simulatedTime;
  const before = Array.from(session.grid.u);

  session.setBoundary("top", { type: "wall" });

  assert.equal(session.iteration, iteration, "the run must not reset");
  assert.equal(session.simulatedTime, time);
  assert.deepEqual(Array.from(session.grid.u), before, "and the field must be untouched");
  assert.equal(session.fieldIsStale, false, "a boundary edit does not stale the field");

  // The next step uses the new condition.
  assert.equal(session.bc.top.type, "wall");
  session.advance();
  assert.equal(session.iteration, iteration + 1);
});

test("M6 - the session's bc is the editor's, so the solver and the panel agree", () => {
  // The failure this guards is the one M6 step 3 already produced once: the
  // panel compiling from one source while the solver ran from another.
  const session = new SimulationSession("cylinder");
  session.setBoundary("top", { type: "inflow", u: 0, v: -0.2 });
  assert.equal(session.bc, session.boundaries.spec);
  assert.equal(session.bc.top.type, "inflow");
  assert.notEqual(
    session.scenario.bc.top.type, "inflow",
    "the scenario's own definition is not edited in place"
  );

  // What the solver is handed and what a plan is compiled from are one object.
  const plan = boundaryPlanFor(session.grid, session.bc);
  const topFace = plan.conditions[plan.faces.top[5]];
  assert.equal(topFace.type, "inflow");
  assert.equal(topFace.v, -0.2);
});

test("M6 - boundary edits survive a geometry edit, which rebuilds everything else", () => {
  const session = new SimulationSession("cylinder");
  session.setBoundary("top", { type: "freeSlip" });
  const revision = session.boundaries.revision;

  // A geometry edit resets the field and rebuilds the scenario.
  session.applyEdit({
    op: "add", region: { kind: "rect", x0: 6, y0: 2, x1: 7, y1: 4 },
  });
  assert.equal(session.iteration, 0, "the geometry edit did reset the run");
  assert.equal(session.bc.top.type, "freeSlip", "but the boundary edit survived it");
  assert.equal(session.boundaries.revision, revision);

  // Switching scenario does discard them, because they describe another domain.
  session.load("cavity");
  assert.equal(session.boundaries.revision, 0);
  assert.equal(session.bc.top.type, "wall");
});
