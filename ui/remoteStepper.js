// The app's half of running the solver in a Web Worker (M14). See
// stepperCore.js for why and for the protocol.
//
// The app's own SimulationSession stays the authority for everything a person
// sees and edits. The worker holds a copy that only steps; after every batch
// its moving state is installed back here, and the harness draws whatever was
// last installed, every frame, whether or not a batch has arrived. The main
// thread therefore never waits on the solver: a 168 ms cylinder step costs it
// nothing but a 0.6 MB copy when the step lands.
//
// Edits made here while a batch is in flight are applied here at once (so the
// picture answers immediately) and queued; the next batch carries them to the
// worker before it steps again. The one exception is dye, whose seed is a
// function: a batch computed before the dye changed must not overwrite it, so
// its dye is skipped and the app's dye is sent with the next batch instead.

import { projectFrom } from "../io/project.js";
import { FORWARDED } from "./stepperCore.js";

export class RemoteStepper {
  // `maxSteps` caps a batch by count as well as by time - for tests, which
  // need batch boundaries they can reproduce.
  constructor({ createWorker, onBatch, onFault, budgetMs = 16, maxSteps = Infinity }) {
    this.maxSteps = maxSteps;
    this.createWorker = createWorker;
    this.onBatch = onBatch;
    this.onFault = onFault;
    this.budgetMs = budgetMs;
    this.worker = null;
    this.epoch = 0;
    this.active = false;
    this.inFlight = false;
    this.calls = [];
    this.tracerDirty = false;
    this.session = null;
    // Counters for the performance readout and the tests.
    this.batches = 0;
    this.stepsReceived = 0;
    this.discarded = 0;
    // Time the worker spent stepping, against the wall-clock round trip of
    // each batch - their difference is what the handoff costs.
    this.workerBusy = 0;
    this.roundTrip = 0;
    this.sentAt = 0;
  }

  #ensureWorker() {
    if (this.worker !== null) return;
    this.worker = this.createWorker();
    this.worker.onmessage = (event) => this.#receive(event.data);
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      this.#fault(`the solver worker failed: ${event.message ?? "unknown error"}`);
    };
  }

  // Starts (or restarts) stepping `session` in the worker, from its current
  // state. Every earlier reply becomes stale.
  start(session) {
    this.#ensureWorker();
    this.session = session;
    this.epoch++;
    this.active = true;
    this.calls = [];
    this.tracerDirty = false;
    this.worker.postMessage({
      type: "sync",
      epoch: this.epoch,
      project: projectFrom(session),
      state: session.captureState(),
      probeIds: session.probes.probes.map((probe) => probe.id),
      nextProbeId: session.probes.nextId,
      brush: session.brushSource,
    });
    this.#dispatch();
  }

  // Stops asking for batches. A batch already in flight is discarded when it
  // lands: after a pause the picture must be the state the pause froze.
  stop() {
    if (!this.active) return;
    this.active = false;
    this.epoch++;
  }

  // Something reset the field here. Whatever the worker is doing describes a
  // flow that no longer exists.
  invalidate() {
    this.stop();
  }

  forward(method, args) {
    if (!FORWARDED.includes(method)) throw new Error(`"${method}" is not a forwarded call`);
    if (this.active) this.calls.push([method, structuredClone(args)]);
  }

  markTracerDirty() {
    if (this.active) this.tracerDirty = true;
  }

  terminate() {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }

  #dispatch() {
    const tracer = this.tracerDirty
      ? { c: this.session.tracer.c.slice(), steps: this.session.tracer.steps }
      : null;
    this.tracerDirty = false;
    this.inFlight = true;
    this.sentAt = performance.now();
    this.worker.postMessage({
      type: "batch",
      epoch: this.epoch,
      calls: this.calls.splice(0),
      tracer,
      budgetMs: this.budgetMs,
      maxSteps: this.maxSteps,
    });
  }

  #receive(reply) {
    if (reply.type === "synced") return;
    if (reply.type === "fault") {
      if (reply.epoch === this.epoch) this.#fault(reply.message);
      return;
    }
    if (reply.type === "stale") return;
    this.inFlight = false;
    if (reply.epoch !== this.epoch || !this.active) {
      this.discarded++;
      return;
    }
    this.batches++;
    this.stepsReceived += reply.steps;
    this.workerBusy += reply.elapsed;
    this.roundTrip += performance.now() - this.sentAt;
    // Dye edited here since this batch was sent: keep the edit.
    const keepDye = this.tracerDirty;
    // The reply arrived through postMessage, so it is already this thread's own.
    this.session.installState(reply.state, { tracer: !keepDye, owned: true });
    this.session.applyStepRecords(reply.records);
    this.onBatch(reply);
    if (reply.error !== null) {
      this.active = false;
      return;
    }
    if (this.active) this.#dispatch();
  }

  #fault(message) {
    this.active = false;
    this.onFault(message);
  }
}

// Wraps the app's session so the calls in FORWARDED also reach the worker, and
// the calls that reset the field make any batch in flight stale. Every other
// property passes straight through. Methods are bound to the real session,
// whose private fields a proxy receiver could not reach.
const RESETTING = new Set([
  "load", "reset", "applyEdit", "replaceEdit", "removeEdit", "clearGeometry", "undo", "redo",
  "setMaterial", "setReynolds", "importProject",
]);
// Boundary history is local to each editor, so an undo or redo is sent as the
// specification it produced rather than replayed against the worker's history.
const AS_SPEC = new Set(["setBoundary", "undoBoundary", "redoBoundary", "setBoundarySpec"]);

export function forwardingSession(session, stepper) {
  return new Proxy(session, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const name = String(property);
      if (RESETTING.has(name)) {
        return (...args) => {
          const result = value.apply(target, args);
          stepper.invalidate();
          return result;
        };
      }
      if (AS_SPEC.has(name)) {
        return (...args) => {
          const result = value.apply(target, args);
          stepper.forward("setBoundarySpec", [target.bc]);
          return result;
        };
      }
      if (FORWARDED.includes(name)) {
        return (...args) => {
          const result = value.apply(target, args);
          stepper.forward(name, args);
          return result;
        };
      }
      return value.bind(target);
    },
  });
}
