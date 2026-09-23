// The convergence history: how well each solver step kept its promise.
//
// One reading per SOLVER STEP, recorded by the session inside advance() - the
// same rule the probe histories follow, for the same reason: the harness runs
// several steps per repaint, and sampling on repaint would keep one in four.
//
// What is recorded is the CONTINUITY ERROR, max |div u - q| after the
// projection, which is the one number step() promises to hold under its
// tolerance. The reference's residual plot shows three lines - continuity and
// two momentum residuals - and this shows one, deliberately. A projection
// method has no momentum residual to report: the momentum equation is
// advanced explicitly, not iterated to convergence, so there is nothing
// converging to plot. Drawing a line for it would mean inventing one.
//
// The Poisson iteration count is kept alongside, as a number rather than a
// second line: it is a different quantity with different units, and two
// scales on one axis is the chart mistake that makes both unreadable.

export const RESIDUAL_CAPACITY = 4000;

export class ResidualHistory {
  constructor(capacity = RESIDUAL_CAPACITY) {
    this.capacity = capacity;
    this.iteration = new Float64Array(capacity);
    this.continuity = new Float64Array(capacity);
    this.poisson = new Float64Array(capacity);
    this.writes = 0;
  }

  get length() {
    return Math.min(this.writes, this.capacity);
  }

  record(iteration, step) {
    const at = this.writes % this.capacity;
    this.iteration[at] = iteration;
    this.continuity[at] = step?.continuityError ?? NaN;
    this.poisson[at] = step?.poissonIterations ?? NaN;
    this.writes++;
  }

  // Oldest first, as plain arrays - the shape visualization/timeseries.js
  // takes, with the iteration number as the x-axis.
  series(which = "continuity") {
    const source = which === "poisson" ? this.poisson : this.continuity;
    const n = this.length;
    const from = this.writes <= this.capacity ? 0 : this.writes % this.capacity;
    const time = new Float64Array(n);
    const value = new Float64Array(n);
    for (let m = 0; m < n; m++) {
      const at = (from + m) % this.capacity;
      time[m] = this.iteration[at];
      value[m] = source[at];
    }
    return { time, value };
  }

  latest() {
    if (this.writes === 0) return null;
    const at = (this.writes - 1) % this.capacity;
    return {
      iteration: this.iteration[at],
      continuity: this.continuity[at],
      poisson: this.poisson[at],
    };
  }

  clear() {
    this.writes = 0;
  }
}
