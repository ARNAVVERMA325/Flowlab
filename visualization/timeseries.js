// A time series drawn on a canvas, with no charting library.
//
// Split in two on purpose. `layoutSeries` is pure arithmetic - it turns a
// series into pixel points, a y-range and a list of gaps - and `drawSeries`
// strokes what it produced. Everything worth getting wrong is in the first
// half, which node can test exactly; the second half is a handful of moveTo
// and lineTo calls that a browser check confirms actually paint.
//
// ---------------------------------------------------------------------------
// A BROKEN SAMPLE BREAKS THE LINE
// ---------------------------------------------------------------------------
//
// The y-range is built by classifying every value with Number.isFinite, never
// by reducing with a bare comparison - the mistake physics/fieldStats.js
// exists to prevent, which once let an entirely NaN field report a maximum of
// zero. A plot is worse than a reduction here: `lineTo(NaN, NaN)` does not
// throw and does not draw, so the canvas quietly shows a line running from the
// last good sample to the next one, straight through a hole in the data, and
// it looks exactly like a measurement.
//
// So non-finite samples are counted, excluded from the range, and drawn as
// GAPS - the stroke stops and restarts - and the count is returned so the
// caller can say so in words.

// The smallest half-height a flat series is given, so a constant signal draws
// as a line through the middle of the box rather than dividing by zero.
const FLAT_PAD = 1e-12;

// The y-range of a series, and the evidence about whether it means anything.
export function seriesRange(value) {
  let lo = Infinity;
  let hi = -Infinity;
  let finite = 0;
  let nonFinite = 0;
  for (const v of value) {
    if (!Number.isFinite(v)) { nonFinite++; continue; }
    finite++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (finite === 0) return { lo: NaN, hi: NaN, finite: 0, nonFinite, usable: false };
  if (lo === hi) {
    // A constant series still has to occupy the box. Pad proportionally so a
    // constant 1000 and a constant 1e-9 both read as flat rather than one of
    // them looking like noise at full scale.
    const pad = Math.max(Math.abs(lo) * 0.05, FLAT_PAD);
    return { lo: lo - pad, hi: hi + pad, finite, nonFinite, usable: true, flat: true };
  }
  return { lo, hi, finite, nonFinite, usable: true, flat: false };
}

// Series to pixels.
//
// Returns `segments`: runs of consecutive finite samples, each an array of
// {px, py}. A non-finite sample ends one run and the next finite sample starts
// another, so the stroke has a hole exactly where the data does.
// A LOG axis maps each value through log10 first, and a value that is not
// strictly positive has no position on one. Those are counted as `unplottable`
// and drawn as gaps - the same treatment as a non-finite sample, and for the
// same reason: a line drawn through a hole looks like data. A continuity error
// of exactly zero is a real and good result (still water produces one), so the
// count is reported rather than folded in with the broken samples.
//
// A FIXED range, `range: { lo, hi }`, replaces the fitted one. It exists for a
// quantity whose interesting value is "under the bound" - the per-step
// continuity error, which converges TO its tolerance every step rather than
// far below it. Fitted to itself, that series spans a fifth of a decade and
// its rounding noise fills the whole chart as a scribble; on a fixed axis
// anchored to the bound it is a flat band just under a dashed line, which is
// the truth. Values outside a fixed range are drawn AT the edge and counted as
// `clipped`, never dropped.
export function layoutSeries({ time, value }, { width, height, padding = 4, log = false, range: fixed = null } = {}) {
  let unplottable = 0;
  if (log) {
    const mapped = new Float64Array(value.length);
    for (let m = 0; m < value.length; m++) {
      const v = value[m];
      if (Number.isFinite(v) && v <= 0) unplottable++;
      mapped[m] = Number.isFinite(v) && v > 0 ? Math.log10(v) : NaN;
    }
    const logFixed = fixed === null ? null : { lo: Math.log10(fixed.lo), hi: Math.log10(fixed.hi) };
    const laid = layoutSeries({ time, value: mapped }, { width, height, padding, range: logFixed });
    // The range is reported in the ORIGINAL units, so a caller labelling the
    // axis prints 1e-8, not -8.
    const range = laid.range.usable
      ? { ...laid.range, lo: 10 ** laid.range.lo, hi: 10 ** laid.range.hi, log: true }
      : { ...laid.range, log: true };
    return { ...laid, range, unplottable };
  }
  const measured = seriesRange(value);
  const range = fixed === null || !measured.usable
    ? measured
    : { ...measured, lo: fixed.lo, hi: fixed.hi, flat: false, fixed: true };
  const empty = { segments: [], range, points: 0, gaps: 0, span: null, clipped: 0 };
  if (value.length === 0 || !range.usable) return empty;

  let t0 = Infinity;
  let t1 = -Infinity;
  for (let m = 0; m < time.length; m++) {
    if (!Number.isFinite(time[m])) continue;
    if (!Number.isFinite(value[m])) continue;
    if (time[m] < t0) t0 = time[m];
    if (time[m] > t1) t1 = time[m];
  }
  if (!Number.isFinite(t0)) return empty;

  const left = padding;
  const right = width - padding;
  const top = padding;
  const bottom = height - padding;
  // A single sample, or several taken at the same instant, has no time span to
  // spread across. Drawn at the right-hand edge, where the newest sample
  // belongs, rather than at an arbitrary middle.
  const spanT = t1 - t0;
  const xAt = (t) => (spanT > 0 ? left + ((t - t0) / spanT) * (right - left) : right);
  const spanV = range.hi - range.lo;
  let clipped = 0;
  const yAt = (v) => {
    let at = bottom - ((v - range.lo) / spanV) * (bottom - top);
    if (at < top) { at = top; clipped++; } else if (at > bottom) { at = bottom; clipped++; }
    return at;
  };

  const segments = [];
  let run = null;
  let points = 0;
  let gaps = 0;
  for (let m = 0; m < value.length; m++) {
    const finite = Number.isFinite(value[m]) && Number.isFinite(time[m]);
    if (!finite) {
      if (run !== null) { segments.push(run); run = null; gaps++; }
      continue;
    }
    if (run === null) run = [];
    run.push({ px: xAt(time[m]), py: yAt(value[m]) });
    points++;
  }
  if (run !== null) segments.push(run);

  return { segments, range, points, gaps, span: { t0, t1 }, clipped };
}

// Strokes a laid-out series. Returns the layout, so a caller labelling the
// axes reads the same numbers that were drawn rather than recomputing them.
export function drawSeries(context, series, options) {
  const {
    width, height, colour = "#4fc3f7", background = null, lineWidth = 1.5, grid = true,
  } = options;
  if (background !== null) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  } else {
    context.clearRect(0, 0, width, height);
  }

  // Recessive guide lines at quarters, so a reader can place a value without a
  // full axis. Drawn before the series and in a colour well below it.
  if (grid) {
    const padding = options.padding ?? 4;
    context.save();
    context.strokeStyle = "rgba(148, 163, 184, 0.10)";
    context.lineWidth = 1;
    context.beginPath();
    for (let q = 0; q <= 4; q++) {
      const y = Math.round(padding + ((height - 2 * padding) * q) / 4) + 0.5;
      context.moveTo(padding, y);
      context.lineTo(width - padding, y);
    }
    context.stroke();
    context.restore();
  }

  const layout = layoutSeries(series, options);
  context.strokeStyle = colour;
  context.lineWidth = lineWidth;
  context.lineJoin = "round";
  for (const segment of layout.segments) {
    if (segment.length === 1) {
      // One sample is a dot. A zero-length stroke paints nothing, which would
      // make the first moments of a run look like no data at all.
      context.fillStyle = colour;
      context.fillRect(segment[0].px - 1, segment[0].py - 1, 2, 2);
      continue;
    }
    context.beginPath();
    context.moveTo(segment[0].px, segment[0].py);
    for (let m = 1; m < segment.length; m++) context.lineTo(segment[m].px, segment[m].py);
    context.stroke();
  }
  return layout;
}
