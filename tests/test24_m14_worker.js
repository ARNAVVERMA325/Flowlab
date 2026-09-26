// M14 - the solver in a Web Worker.
//
// Moving the solver off the main thread is only acceptable if nothing about
// the simulation changes. So the demand here is byte-identity: a flow stepped
// through the worker protocol - with edits made mid-run, dye cleared mid-run,
// probes added mid-run - must be the same bytes as the same flow stepped
// directly with the same edits at the same steps. Node drives the real
// StepperCore through the real RemoteStepper, with a fake Worker that delivers
// each reply asynchronously exactly as postMessage would (a structured clone,
// on a later task). The browser checks then prove the real Worker does the same.

import test from "node:test";
import assert from "node:assert/strict";

import { SimulationSession } from "../ui/session.js";
import { StepperCore, FORWARDED } from "../ui/stepperCore.js";
import { RemoteStepper, forwardingSession } from "../ui/remoteStepper.js";
import { fluidById } from "../materials/fluids.js";
import { TOOLS } from "../geometry/editor.js";
import { SolverStabilityError } from "../solver/stability.js";
import { projectFrom } from "../io/project.js";

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (!Object.is(a[k], b[k])) return false;
  return true;
}

function assertSameFlow(a, b, what) {
  for (const field of ["u", "v", "p"]) assert.ok(sameBytes(a.grid[field], b.grid[field]), `${what}: ${field} differs`);
  assert.ok(sameBytes(a.tracer.c, b.tracer.c), `${what}: dye differs`);
  assert.equal(a.iteration, b.iteration, `${what}: step count`);
  assert.equal(a.simulatedTime, b.simulatedTime, `${what}: time`);
  assert.deepEqual(a.pathlines.captureState(), b.pathlines.captureState(), `${what}: pathlines`);
}

// A Worker stand-in: the real core, replies cloned and delivered on a later
// macrotask, as postMessage does.
function fakeWorker() {
  const core = new StepperCore();
  const worker = {
    onmessage: null,
    posted: [],
    postMessage(message) {
      const copy = structuredClone(message);
      worker.posted.push(copy.type);
      setImmediate(() => {
        const reply = core.handle(copy);
        setImmediate(() => worker.onmessage?.({ data: structuredClone(reply) }));
      });
    },
    terminate() {},
  };
  return worker;
}

// Runs the stepper until `batches` batches have landed.
function driver(session, { maxSteps = 3 } = {}) {
  const batches = [];
  let waiting = null;
  const stepper = new RemoteStepper({
    createWorker: fakeWorker,
    maxSteps,
    budgetMs: Infinity,
    onBatch: (reply) => {
      batches.push(reply);
      waiting?.();
    },
    onFault: (message) => { throw new Error(message); },
  });
  const nextBatch = () => new Promise((resolve) => { waiting = resolve; });
  return { stepper, batches, nextBatch };
}

// ---------------------------------------------------------------------------
// The handoff itself
// ---------------------------------------------------------------------------

test("a captured state installed elsewhere continues the identical flow", () => {
  const a = new SimulationSession("cylinder");
  for (let n = 0; n < 5; n++) a.advance();
  const b = new SimulationSession("cylinder");
  b.installState(a.captureState());
  for (let n = 0; n < 10; n++) {
    a.advance();
    b.advance();
  }
  assertSameFlow(a, b, "after the handoff");
  // Pathline respawns draw on the generator, so its state went across too.
  assert.equal(a.pathlines.rng.state, b.pathlines.rng.state);
});

test("step records replayed elsewhere give the same charts as the steps themselves", () => {
  const worker = new SimulationSession("cavity");
  const app = new SimulationSession("cavity");
  worker.addProbe(0.5, 0.5);
  app.addProbe(0.5, 0.5);
  app.addProbe(0.2, 0.2); // only here: no readings for it, and none invented
  worker.stepLog = [];
  for (let n = 0; n < 6; n++) worker.advance();
  app.applyStepRecords(worker.stepLog);
  assert.equal(app.residuals.length, 6);
  assert.ok(sameBytes(app.residuals.series("continuity").value, worker.residuals.series("continuity").value));
  const [here, extra] = app.probes.probes;
  assert.ok(sameBytes(here.history.series("vorticity").value, worker.probes.probes[0].history.series("vorticity").value));
  assert.ok(sameBytes(here.history.series("vorticity").time, worker.probes.probes[0].history.series("vorticity").time));
  assert.equal(extra.history.length, 0);
});

test("a state that does not fit the grid is refused", () => {
  const cavity = new SimulationSession("cavity");
  const cylinder = new SimulationSession("cylinder");
  assert.throws(() => cavity.installState(cylinder.captureState()), RangeError);
});

test("the core steps a synced session to the same bytes as stepping it directly", () => {
  const app = new SimulationSession("jet");
  app.applyEdit(TOOLS.circle(2, 0.5, 0.15));
  app.addProbe(1, 0.5);
  app.removeProbe(1);
  app.addProbe(3, 0.4); // id 2: numbering must follow the app, not restart
  app.setMaterial(fluidById("air"));
  for (let n = 0; n < 4; n++) app.advance();

  const core = new StepperCore({ now: () => 0 });
  core.handle({
    type: "sync", epoch: 1, project: projectFrom(app), state: app.captureState(),
    probeIds: app.probes.probes.map((p) => p.id), nextProbeId: app.probes.nextId, brush: null,
  });
  const reply = core.handle({ type: "batch", epoch: 1, maxSteps: 7, budgetMs: Infinity });
  assert.equal(reply.steps, 7);
  assert.equal(reply.records.length, 7);
  assert.deepEqual(reply.records[0].readings.map(([id]) => id), [2], "readings carry the app's probe id");

  const mirror = new SimulationSession("jet");
  mirror.applyEdit(TOOLS.circle(2, 0.5, 0.15));
  mirror.setMaterial(fluidById("air"));
  mirror.installState(reply.state);
  for (let n = 0; n < 7; n++) app.advance();
  assertSameFlow(app, mirror, "core vs direct");
});

test("a batch for an old epoch, or before any sync, is answered stale", () => {
  const core = new StepperCore();
  assert.equal(core.handle({ type: "batch", epoch: 1 }).type, "stale");
  const app = new SimulationSession("cavity");
  core.handle({
    type: "sync", epoch: 2, project: projectFrom(app), state: app.captureState(),
    probeIds: [], nextProbeId: 1, brush: null,
  });
  assert.equal(core.handle({ type: "batch", epoch: 1, maxSteps: 1 }).type, "stale");
  assert.throws(() => core.handle({ type: "batch", epoch: 2, calls: [["reset", []]], maxSteps: 1 }), /not forwarded/);
  assert.throws(() => core.handle({ type: "launch" }), /unknown message/);
});

// ---------------------------------------------------------------------------
// Through the RemoteStepper, asynchronously, with edits mid-run
// ---------------------------------------------------------------------------

test("stepping through the worker protocol, with edits mid-run, matches stepping directly", async () => {
  const app = new SimulationSession("cavity");
  const { stepper, batches, nextBatch } = driver(app, { maxSteps: 3 });
  const view = forwardingSession(app, stepper);
  view.addProbe(0.5, 0.5);

  // The direct twin applies each edit at the step where the worker will.
  const twin = new SimulationSession("cavity");
  twin.addProbe(0.5, 0.5);
  const twinSteps = (n) => { for (let k = 0; k < n; k++) twin.advance(); };

  let landed = nextBatch();
  stepper.start(view);
  // Made while batch 1 is in flight: applied here now, in the worker before batch 2.
  view.setBoundary("top", { type: "wall", u: -1 });
  view.addProbe(0.25, 0.75);
  view.setBrushSource({ kind: "momentum", where: { kind: "rect", x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }, u: 0, v: 1, relaxationTime: 0.05 });
  await landed;
  twinSteps(3);
  twin.setBoundary("top", { type: "wall", u: -1 });
  twin.addProbe(0.25, 0.75);
  twin.setBrushSource({ kind: "momentum", where: { kind: "rect", x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }, u: 0, v: 1, relaxationTime: 0.05 });

  landed = nextBatch();
  await landed; // batch 2: the edits applied, then 3 steps
  twinSteps(3);
  // Dye cleared while batch 3 is in flight: batch 3's dye must not overwrite it,
  // and batch 4 carries it to the worker.
  landed = nextBatch();
  app.tracer.clear();
  stepper.markTracerDirty();
  await landed;
  assert.ok(app.tracer.c.every((c) => c === 0), "the in-flight batch did not paint dye back over the clear");
  twinSteps(3);
  twin.tracer.clear();
  landed = nextBatch();
  await landed;
  twinSteps(3);
  stepper.stop();

  assert.equal(batches.length, 4);
  assertSameFlow(app, twin, "worker protocol vs direct");
  // One chart point per step, as if the steps had run here.
  assert.equal(app.residuals.length, 12);
  const [p1, p2] = app.probes.probes;
  assert.equal(p1.history.length, 12);
  assert.equal(p2.history.length, 9, "the probe added mid-run samples from the next batch on");
  assert.ok(sameBytes(p2.history.series("speed").value, twin.probes.probes[1].history.series("speed").value));
});

test("a brush already held when Run is pressed reaches the worker", async () => {
  const brush = { kind: "momentum", where: { kind: "rect", x0: 0.3, y0: 0.3, x1: 0.5, y1: 0.5 }, u: 1, v: 0, relaxationTime: 0.05 };
  const app = new SimulationSession("cavity");
  app.setBrushSource(brush);
  const twin = new SimulationSession("cavity");
  twin.setBrushSource(brush);
  const { stepper, nextBatch } = driver(app, { maxSteps: 4 });
  const landed = nextBatch();
  stepper.start(app);
  await landed;
  stepper.stop();
  for (let n = 0; n < 4; n++) twin.advance();
  assertSameFlow(app, twin, "brush held from the start");
});

test("a reset while a batch is in flight discards that batch", async () => {
  const app = new SimulationSession("cavity");
  const { stepper, nextBatch } = driver(app, { maxSteps: 2 });
  const view = forwardingSession(app, stepper);
  const landed = nextBatch();
  stepper.start(view);
  await landed; // one good batch
  // The next one is in flight now. A geometry edit resets the field.
  view.applyEdit(TOOLS.rectangle(0.4, 0.1, 0.6, 0.2));
  assert.equal(stepper.active, false, "a resetting call stops the stepper");
  // Wait for the in-flight batch to land - on its arrival, not on a clock.
  const deadline = Date.now() + 5000;
  while (stepper.inFlight && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stepper.inFlight, false);
  assert.equal(stepper.discarded, 1);
  assert.equal(app.iteration, 0, "the reset field was not overwritten by the old flow");
});

test("a failure in the worker comes back as the same error, with the field that failed", async () => {
  const app = new SimulationSession("cavity");
  for (let n = 0; n < 3; n++) app.advance();
  app.grid.p.fill(NaN);
  let failure = null;
  const stepper = new RemoteStepper({
    createWorker: fakeWorker,
    maxSteps: 5,
    budgetMs: Infinity,
    onBatch: (reply) => { failure = reply.error; },
    onFault: () => {},
  });
  stepper.start(app);
  const deadline = Date.now() + 5000;
  while (failure === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(failure.name, "SolverStabilityError");
  assert.match(failure.message, /non-finite/);
  assert.equal(stepper.active, false, "nothing is stepped after a failure");
  assert.equal(new SolverStabilityError("x").name, failure.name, "the name the harness maps back to the class");
});

// ---------------------------------------------------------------------------
// The forwarding proxy
// ---------------------------------------------------------------------------

test("the proxy forwards mid-run edits, invalidates on resets, and reaches private fields", () => {
  const calls = [];
  let invalidated = 0;
  const stepper = {
    forward: (method, args) => calls.push([method, args]),
    invalidate: () => invalidated++,
  };
  const app = new SimulationSession("cavity");
  const view = forwardingSession(app, stepper);
  view.advance(); // uses private fields: must be bound to the real session
  assert.equal(app.iteration, 1);
  view.addProbe(0.5, 0.5);
  view.setBoundary("top", { type: "freeSlip" });
  view.undoBoundary();
  assert.deepEqual(calls.map(([m]) => m), ["addProbe", "setBoundarySpec", "setBoundarySpec"]);
  assert.equal(calls[2][1][0], app.bc, "an undo is sent as the specification it produced");
  view.setReynolds(100);
  view.applyEdit(TOOLS.circle(0.5, 0.5, 0.1));
  view.reset();
  assert.equal(invalidated, 3);
  assert.equal(view.scenarioId, "cavity", "plain properties pass through");
  assert.ok(view instanceof SimulationSession);
  for (const name of FORWARDED) assert.equal(typeof app[name], "function", `${name} exists on the session`);
});

test("whole-spec replacement keeps drawn surfaces and records one edit", () => {
  const session = new SimulationSession("cavity");
  const spec = { ...session.bc, top: { type: "wall", u: 2 } };
  session.setBoundarySpec(spec);
  assert.equal(session.bc.top.u, 2);
  assert.equal(session.canUndoBoundary, true);
  session.undoBoundary();
  assert.equal(session.bc.top.u, 1);
});

// ---------------------------------------------------------------------------
// Adaptive display resolution
// ---------------------------------------------------------------------------

import { MIN_PIXEL_BUDGET, PIXEL_BUDGET, RENDER_TARGET_MS, adaptBudget, subsampleFor } from "../visualization/fieldRenderer.js";

test("the render budget halves when frames run long and recovers, within fixed bounds", () => {
  assert.equal(adaptBudget(PIXEL_BUDGET, RENDER_TARGET_MS + 1), PIXEL_BUDGET / 2);
  assert.equal(adaptBudget(PIXEL_BUDGET, RENDER_TARGET_MS - 1), PIXEL_BUDGET, "inside the target: unchanged");
  assert.equal(adaptBudget(PIXEL_BUDGET / 2, 1), PIXEL_BUDGET, "fast again: doubled back");
  assert.equal(adaptBudget(PIXEL_BUDGET, 1), PIXEL_BUDGET, "never past the measured default");
  let budget = PIXEL_BUDGET;
  for (let n = 0; n < 20; n++) budget = adaptBudget(budget, 100);
  assert.equal(budget, MIN_PIXEL_BUDGET, "never below the floor, however slow");
  // What the budget buys: fewer display pixels per cell, never fewer cells.
  assert.equal(subsampleFor(64, 64, 14), 5);
  assert.equal(subsampleFor(64, 64, 14, MIN_PIXEL_BUDGET), 2, "the floor keeps two pixels a cell");
  assert.equal(subsampleFor(64, 64, 14, PIXEL_BUDGET), subsampleFor(64, 64, 14), "the default is the old fixed budget");
});
