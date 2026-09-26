// The solver's half of running in a Web Worker (M14).
//
// WHY A WORKER. Measured in the browser: one cylinder step takes 92 ms at the
// median and 168 ms at worst (310 CG iterations on 12,264 cells), against a
// 24 ms frame budget - so while the cylinder ran, the page could not repaint or
// answer a click for a tenth of a second at a time. Drawing a frame takes at
// most 9.4 ms. The solver is the thing that has to leave the main thread.
//
// HOW. This file holds everything that happens on the worker side, as a pure
// message handler, so node can drive it in-process and prove what matters: a
// flow stepped here is BYTE-IDENTICAL to the same flow stepped on the main
// thread. The worker file itself is four lines around this.
//
// The protocol is lockstep - one batch in flight at a time:
//
//   sync   { epoch, project, state, probeIds, nextProbeId, brush }
//          Rebuilds the worker's session from the app's: the setup as a saved
//          project (io/project.js), the moving state as captureState(). Sent
//          at every Run, and after anything that resets the field.
//
//   batch  { epoch, calls, tracer, budgetMs, maxSteps }
//          Applies the mid-run edits made in the app since the last batch, in
//          order, then steps until the time budget is spent (at least once).
//          Replies with the new state and one record per step.
//
// A reply carries the epoch it was computed in. The app bumps the epoch when
// it resets anything, so a reply from before a reset is recognised and thrown
// away rather than painted over the new flow.

import { SimulationSession } from "./session.js";

// The session calls the app may make while a run continues. Everything else
// either resets the field - and is followed by a fresh sync - or does not
// change the simulation at all.
export const FORWARDED = [
  "setBrushSource",
  "setBoundarySpec",
  "addSource",
  "removeSource",
  "clearSources",
  "addProbe",
  "removeProbe",
  "clearProbes",
];

export class StepperCore {
  // `posted`: replies leave through postMessage, which copies them, so the
  // state need not be copied first. In-process callers get independent copies.
  constructor({ now = () => performance.now(), posted = false } = {}) {
    this.posted = posted;
    this.session = null;
    this.epoch = null;
    this.now = now;
  }

  handle(message) {
    if (message.type === "sync") return this.#sync(message);
    if (message.type === "batch") return this.#batch(message);
    throw new Error(`unknown message type "${message.type}"`);
  }

  #sync({ epoch, project, state, probeIds, nextProbeId, brush }) {
    const session = new SimulationSession(project.scenario);
    session.importProject(project);
    session.probes.adoptNumbering(probeIds, nextProbeId);
    if (brush) session.setBrushSource(brush);
    session.installState(state);
    this.session = session;
    this.epoch = epoch;
    return { type: "synced", epoch };
  }

  #batch({ epoch, calls = [], tracer = null, budgetMs = 16, maxSteps = Infinity }) {
    if (this.session === null || epoch !== this.epoch) return { type: "stale", epoch };
    const session = this.session;
    for (const [method, args] of calls) {
      if (!FORWARDED.includes(method)) throw new Error(`"${method}" is not forwarded to the worker`);
      session[method](...args);
    }
    // Dye changed in the app since the last batch (reseeded or cleared):
    // taken from there, because a seed is a function and cannot be sent.
    if (tracer !== null) {
      session.tracer.c.set(tracer.c);
      session.tracer.steps = tracer.steps;
    }
    session.stepLog = [];
    const started = this.now();
    let steps = 0;
    let error = null;
    try {
      do {
        session.advance();
        steps++;
      } while (steps < maxSteps && this.now() - started < budgetMs);
    } catch (thrown) {
      // Sent as data and rebuilt as the same class on the other side, so the
      // app classifies it exactly as it would a failure on its own thread.
      error = { name: thrown.name, message: thrown.message, details: thrown.details ?? null };
    }
    const records = session.stepLog;
    session.stepLog = null;
    return {
      type: "batch",
      epoch,
      steps,
      elapsed: this.now() - started,
      records,
      // By reference where it can be: posting the reply clones it anyway.
      state: session.captureState({ copy: !this.posted }),
      error,
    };
  }
}
