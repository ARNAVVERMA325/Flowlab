// Pinned probes and their history.
//
// A probe is a point someone chose to watch. It holds no physics - every value
// it reports comes from physics/probe.js reading the grid - and it writes
// nothing back. What it owns is the part a display needs and the solver must
// never see: where the points are, and what they have read over time.
//
// ---------------------------------------------------------------------------
// SAMPLED PER STEP, NOT PER FRAME
// ---------------------------------------------------------------------------
//
// The harness runs up to four solver steps per animation frame, so a sample
// taken in draw() would keep one step in four and silently drop the rest. For
// a smooth signal that is invisible; for anything varying near the step rate -
// the shedding this project is eventually meant to show - it is aliasing, and
// an aliased plot is worse than no plot because it looks like data.
//
// So the session samples inside its own step, which also means the x-axis is
// SIMULATED time taken from the same accumulator the panel displays, rather
// than wall-clock time that has nothing to do with the flow.
//
// ---------------------------------------------------------------------------
// WHAT CLEARS THE HISTORY
// ---------------------------------------------------------------------------
//
// Any rebuild of the field. A geometry edit or a Reset discards the flow and
// starts a new one from the scenario's initial condition, and a curve that
// runs continuously across that join is two different simulations drawn as
// one. The probe stays pinned - the point is still a point - but its history
// does not survive, for the same reason the session refuses to step a field
// whose mask has moved underneath it.
//
// A scenario change discards the probes themselves, exactly as it discards the
// geometry document and the sources: a place in one domain is not a place in
// another of a different size and shape.

import { probeAt } from "../physics/probe.js";

// The quantities kept per sample. All of them, every time, rather than only
// the one currently plotted: storing just the selected quantity would blank
// the chart whenever someone changed the selector, which is the moment they
// most want to compare. Six doubles per sample is nothing.
export const PROBE_QUANTITIES = {
  speed: { label: "|u|", description: "speed" },
  u: { label: "u", description: "x velocity" },
  v: { label: "v", description: "y velocity" },
  pressure: { label: "p", description: "pressure" },
  vorticity: { label: "omega", description: "vorticity" },
  // Never "local Re". See physics/probe.js - this is |u|h/nu, a property of
  // the cell and the discretisation, and it is not the scenario's Reynolds
  // number.
  cellRe: { label: "cell Re", description: "cell Reynolds number |u|h/nu" },
};

const TRACKED = Object.keys(PROBE_QUANTITIES);

// About twelve seconds of wall clock at four steps a frame. Long enough to
// watch something settle, short enough that the memory is not worth thinking
// about: eight arrays of this length per probe is 192 KB.
export const PROBE_CAPACITY = 3000;

// Marker colours. A probe's colour is an IDENTITY, so this is a categorical
// palette and is held to the categorical checks rather than picked by eye: the
// dark-mode slots of the validated default palette, in its fixed order, run
// through the palette validator against this UI's panel surface (#0e1522).
// All eight pass on adjacent pairs (worst CVD delta-E 8.4, normal-vision
// 19.3, every slot at least 3:1); the first three also pass all-pairs, which
// is the test that applies to markers scattered over a field. Past three, a
// probe's P-label is always drawn beside its marker - the secondary encoding
// the palette's rules require - so identity is never carried by colour alone.
//
// Assigned in order and never cycled back to a colour already on screen while
// fewer than eight are pinned.
export const PROBE_COLOURS = [
  "#3987e5", "#d95926", "#199e70", "#c98500",
  "#d55181", "#008300", "#9085e9", "#e66767",
];

// A fixed-length history. Writes wrap; reads come back oldest first.
class SampleRing {
  constructor(capacity) {
    this.capacity = capacity;
    this.time = new Float64Array(capacity);
    this.values = {};
    for (const quantity of TRACKED) this.values[quantity] = new Float64Array(capacity);
    // Total pushes ever, not the number retained - the difference is what says
    // where the oldest surviving sample is.
    this.writes = 0;
  }

  get length() {
    return Math.min(this.writes, this.capacity);
  }

  // The newest sample as the plain object push() takes - so a sample taken in
  // a worker can be pushed, unchanged, into the main thread's ring (M14).
  latest() {
    if (this.writes === 0) return null;
    const at = (this.writes - 1) % this.capacity;
    const sample = {};
    for (const quantity of TRACKED) sample[quantity] = this.values[quantity][at];
    return { time: this.time[at], sample };
  }

  push(time, sample) {
    const at = this.writes % this.capacity;
    this.time[at] = time;
    for (const quantity of TRACKED) this.values[quantity][at] = sample[quantity];
    this.writes++;
  }

  // One quantity as a pair of plain arrays, oldest first.
  series(quantity) {
    if (!(quantity in this.values)) {
      throw new Error(`no such probe quantity: ${quantity}`);
    }
    const n = this.length;
    const from = this.writes <= this.capacity ? 0 : this.writes % this.capacity;
    const time = new Float64Array(n);
    const value = new Float64Array(n);
    const source = this.values[quantity];
    for (let m = 0; m < n; m++) {
      const at = (from + m) % this.capacity;
      time[m] = this.time[at];
      value[m] = source[at];
    }
    return { time, value };
  }

  clear() {
    this.writes = 0;
  }
}

export class ProbeSet {
  constructor({ capacity = PROBE_CAPACITY } = {}) {
    this.capacity = capacity;
    this._probes = [];
    // Monotonic, never reused. Labels come from it, so removing P2 leaves P1
    // and P3 rather than renaming the series someone is watching.
    this.nextId = 1;
  }

  get probes() { return this._probes; }
  get count() { return this._probes.length; }

  // Takes another set's numbering - ids, labels, colours and the next id -
  // for probes created in the same order. A worker's copy of the setup must
  // number its probes as the app does, or readings sent back would land on
  // the wrong probe (M14).
  adoptNumbering(ids, nextId) {
    if (ids.length !== this._probes.length) {
      throw new RangeError(`${ids.length} ids for ${this._probes.length} probes`);
    }
    this._probes.forEach((probe, n) => {
      probe.id = ids[n];
      probe.label = `P${ids[n]}`;
      probe.colour = PROBE_COLOURS[(ids[n] - 1) % PROBE_COLOURS.length];
    });
    this.nextId = nextId;
  }

  probeById(id) {
    return this._probes.find((probe) => probe.id === id) ?? null;
  }

  // Pins a probe at a physical point. The caller is responsible for the point
  // being in the domain - the session does that, because it has the grid.
  add(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError(`a probe needs finite coordinates, got (${x}, ${y})`);
    }
    const id = this.nextId++;
    const probe = {
      id,
      label: `P${id}`,
      x, y,
      colour: PROBE_COLOURS[(id - 1) % PROBE_COLOURS.length],
      history: new SampleRing(this.capacity),
      // The most recent reading, kept so the list can show live values without
      // re-reading the grid once per probe per repaint.
      last: null,
    };
    this._probes.push(probe);
    return probe;
  }

  remove(id) {
    const before = this._probes.length;
    this._probes = this._probes.filter((probe) => probe.id !== id);
    return this._probes.length !== before;
  }

  clear() {
    if (this._probes.length === 0) return false;
    this._probes = [];
    return true;
  }

  // Keeps the probes, drops what they have read. Called whenever the field is
  // rebuilt; see the note at the top.
  clearHistory() {
    for (const probe of this._probes) {
      probe.history.clear();
      probe.last = null;
    }
  }

  // One reading per probe, from the grid as it stands. Returns how many were
  // taken, so a caller can tell "no probes" from "nothing happened".
  //
  // A probe inside a body still records a sample - of NaN, which is what
  // probeCell reports there. Skipping it would leave a gap the plot could not
  // distinguish from a pause, and "there is no fluid here" is a true thing to
  // show rather than an absence.
  sample(grid, time, params) {
    for (const probe of this._probes) {
      const reading = this.read(grid, probe, params);
      probe.last = reading;
      probe.history.push(time, reading);
    }
    return this._probes.length;
  }

  // What a probe reads right now, without recording it. The pinned point is
  // resolved to its cell here; a point that has fallen outside the domain -
  // which a scenario change would cause, and which clears the probes anyway -
  // reports as not inside rather than throwing.
  read(grid, probe, params) {
    return probeAt(grid, probe.x, probe.y, params);
  }

  seriesFor(id, quantity) {
    const probe = this.probeById(id);
    return probe === null ? null : probe.history.series(quantity);
  }
}
