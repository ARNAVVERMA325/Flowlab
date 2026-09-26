// Drives a session through an experiment's runs, one solver step at a time.
//
// The runner never steps the solver itself. Whoever owns the loop - the
// harness in the app, a plain while-loop in a test - calls session.advance()
// and then afterStep(), and the runner decides whether the current run has
// finished, measures it if so, and says what happens next. That keeps one
// loop in charge of the solver, and it is what lets node run a whole
// experiment without a browser.

export class ExperimentRunner {
  constructor(experiment, session, { onRunStart = null } = {}) {
    this.experiment = experiment;
    this.session = session;
    // How a run is set up. The harness supplies its own so the display is
    // rebuilt with the scenario; the default is enough for a headless run.
    this.onRunStart = onRunStart ?? ((run) => {
      session.load(run.scenario);
      if (run.Re !== undefined) session.setReynolds(run.Re);
    });
    this.state = "idle";   // idle | running | finished | stopped | failed
    this.runIndex = -1;
    this.results = [];
    this.conclusion = null;
    this.failure = null;
    this.samples = [];
  }

  get run() {
    return this.experiment.runs[this.runIndex] ?? null;
  }

  start() {
    this.state = "running";
    this.results = [];
    this.conclusion = null;
    this.failure = null;
    this.#begin(0);
    return this;
  }

  #begin(index) {
    this.runIndex = index;
    this.samples = [];
    this.onRunStart(this.run);
  }

  // Called after every solver step. Returns what happened, so the caller can
  // redraw or rebuild: "continue", "next" (a new run has been set up) or
  // "finished".
  afterStep() {
    if (this.state !== "running") return this.state;
    const { session, run } = this;
    const reference = session.scenario.reference;
    const scale = (reference.U * reference.U) / reference.L;
    const time = session.simulatedTime;

    // A non-finite field is a failed run, not a finished one. Nothing is
    // measured from it.
    if (!Number.isFinite(session.changeRate) && session.iteration > 1) {
      return this.fail(`the field stopped being finite during "${run.label}"`);
    }

    let finished = false;
    if (run.stop.steady !== undefined) {
      if (session.changeRate < run.stop.steady * scale) finished = true;
      else if (time >= run.stop.maxTime) finished = true;
    } else if (run.stop.average !== undefined) {
      const { from, to, every = 10 } = run.stop.average;
      if (time >= from && session.iteration % every === 0) this.samples.push(run.sample(session));
      if (time >= to) finished = true;
    }
    if (!finished) return "continue";

    this.results.push(this.#record(run, scale));
    if (this.runIndex + 1 < this.experiment.runs.length) {
      this.#begin(this.runIndex + 1);
      return "next";
    }
    this.conclusion = this.experiment.conclude(this.results);
    this.state = "finished";
    return "finished";
  }

  #record(run, scale) {
    const { session } = this;
    const entry = {
      label: run.label,
      scenario: run.scenario,
      Re: session.scenario.Re,
      steps: session.iteration,
      time: session.simulatedTime,
      changeRate: session.changeRate / scale,
    };
    if (run.stop.steady !== undefined) {
      // Said in the record, not only in the panel: a run that hit its cap is
      // NOT steady, and its numbers are a snapshot of a flow still changing.
      entry.steady = session.changeRate < run.stop.steady * scale;
      entry.measured = run.measure(session);
    } else {
      entry.averaged = average(this.samples);
      entry.sampleCount = this.samples.length;
    }
    return entry;
  }

  // The fraction done, for a progress bar - by simulated time, since that is
  // what every stop condition is bounded by. A steady run may finish early;
  // the bar then jumps, which is the truth.
  progress() {
    const run = this.run;
    if (run === null) return null;
    const time = this.session.simulatedTime;
    const limit = run.stop.steady !== undefined ? run.stop.maxTime : run.stop.average.to;
    const reference = this.session.scenario.reference;
    const scale = (reference.U * reference.U) / reference.L;
    return {
      run: this.runIndex + 1,
      of: this.experiment.runs.length,
      label: run.label,
      time,
      limit,
      fraction: Math.min(1, (this.runIndex + Math.min(1, time / limit)) / this.experiment.runs.length),
      changeRate: this.session.changeRate / scale,
      target: run.stop.steady ?? null,
      sampling: run.stop.average !== undefined && time >= run.stop.average.from,
      samples: this.samples.length,
    };
  }

  stop() {
    if (this.state === "running") this.state = "stopped";
    return this.state;
  }

  fail(message) {
    this.state = "failed";
    this.failure = message;
    return "failed";
  }
}

// Mean and standard deviation of every numeric field across the samples.
export function average(samples) {
  const out = {};
  if (samples.length === 0) return out;
  for (const key of Object.keys(samples[0])) {
    const values = samples.map((sample) => sample[key]).filter(Number.isFinite);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    out[key] = { mean, spread: Math.sqrt(variance), count: values.length };
  }
  return out;
}
