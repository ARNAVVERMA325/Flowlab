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
//   sync   { epoch, project, state, probeIds, nextProbeId, brush, experiment }
//          Rebuilds the worker's session from the app's: the setup as a saved
//          project (io/project.js), the moving state as captureState(). Sent
//          at every Run, and after anything that resets the field.
//          `experiment` (an id, or null) runs an M10 experiment HERE: the
//          runner decides after every single step, as it does on the main
//          thread, and a batch ends on the step where a run ends. The app has
//          already set up run 1, so the runner starts on the synced session.
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
import { experimentById } from "../experiments/definitions.js";
import { ExperimentRunner } from "../experiments/runner.js";

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
  constructor({ now = () => performance.now(), posted = false, experiments = experimentById } = {}) {
    this.posted = posted;
    this.experiments = experiments;
    this.runner = null;
    // The runner as it stood at each of the last few replies - see #sync.
    this.checkpoints = [];
    this.session = null;
    this.epoch = null;
    this.now = now;
  }

  handle(message) {
    if (message.type === "sync") return this.#sync(message);
    if (message.type === "batch") return this.#batch(message);
    throw new Error(`unknown message type "${message.type}"`);
  }

  #sync({ epoch, project, state, probeIds, nextProbeId, brush, experiment = null, resume = false }) {
    const session = new SimulationSession(project.scenario);
    session.importProject(project);
    session.probes.adoptNumbering(probeIds, nextProbeId);
    if (brush) session.setBrushSource(brush);
    session.installState(state);
    this.session = session;
    this.epoch = epoch;
    const previous = this.runner;
    this.runner = null;
    // A paused experiment resumes with the runner that was stepping it - its
    // averaging samples live here - pointed at the resynced session, and
    // rolled back to the batch whose state the app actually kept. A pause
    // discards the batch in flight, but the runner had already counted it:
    // its samples, perhaps even the end of a run.
    const checkpoint = resume ? this.checkpoints.find((c) => c.iteration === state.iteration && c.scenario === project.scenario) : null;
    if (experiment !== null && checkpoint && previous?.experiment.id === experiment) {
      previous.session = session;
      previous.state = "running";
      previous.runIndex = checkpoint.runIndex;
      previous.samples = checkpoint.samples;
      previous.samples.length = checkpoint.sampleCount;
      previous.results.length = checkpoint.resultCount;
      previous.conclusion = null;
      this.runner = previous;
    } else if (experiment !== null && resume) {
      throw new Error("the paused experiment cannot be resumed: no record of the state it stopped at");
    } else if (experiment !== null) {
      const definition = this.experiments(experiment);
      if (definition === null) throw new Error(`unknown experiment "${experiment}"`);
      // Later runs are set up here exactly as the runner sets them up anywhere:
      // load the scenario, then the Reynolds number.
      this.runner = new ExperimentRunner(definition, session).start({ setUpFirst: false });
    }
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
    // Held here as well as on the session: a run ending mid-batch loads the
    // next scenario, and that reset clears the session's reference.
    const log = [];
    session.stepLog = log;
    const started = this.now();
    let steps = 0;
    let error = null;
    const runner = this.runner;
    const runBefore = runner?.runIndex ?? null;
    try {
      do {
        session.advance();
        steps++;
        // The runner decides after every step. A batch ends on the step a run
        // ends: the next run is a different scenario, and the app must set it
        // up before it can take that run's state.
        if (runner !== null && runner.state === "running" && runner.afterStep() !== "continue") break;
      } while (steps < maxSteps && this.now() - started < budgetMs);
    } catch (thrown) {
      // Sent as data and rebuilt as the same class on the other side, so the
      // app classifies it exactly as it would a failure on its own thread.
      error = { name: thrown.name, message: thrown.message, details: thrown.details ?? null };
      if (runner?.state === "running") runner.fail(thrown.message);
    }
    // Steps from a run that has just ended describe a flow the app is about
    // to replace with the next run's; their chart points die with it, exactly
    // as they would on the main thread.
    const records = runner !== null && runner.runIndex !== runBefore ? [] : log;
    session.stepLog = null;
    if (runner !== null) {
      this.checkpoints.push({
        iteration: session.iteration,
        scenario: session.scenarioId,
        runIndex: runner.runIndex,
        samples: runner.samples,
        sampleCount: runner.samples.length,
        resultCount: runner.results.length,
      });
      if (this.checkpoints.length > 4) this.checkpoints.shift();
    }
    return {
      type: "batch",
      epoch,
      steps,
      elapsed: this.now() - started,
      records,
      // By reference where it can be: posting the reply clones it anyway.
      state: session.captureState({ copy: !this.posted }),
      error,
      experiment: runner === null ? null : (this.posted ? runner.snapshot() : structuredClone(runner.snapshot())),
    };
  }
}
