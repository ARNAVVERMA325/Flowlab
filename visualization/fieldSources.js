// What the colour map is showing, and how it is scaled.
//
// Each source turns the state the driver already has into a scalar per cell
// plus the scale and ramp to paint it with. Switching between them is a pure
// display change: nothing here steps the solver, touches the tracer, rebuilds
// a scenario or writes to any field. prepareView() reads and returns; that is
// the whole contract, and tests/test9 pins it with checksums taken either side
// of a switch.
//
// Keeping this layer free of the DOM is deliberate. The renderer needs a
// canvas and can only be exercised in a browser; the decisions that could
// actually be wrong - what gets subtracted before pressure is shown, what a
// broken field normalises to, whether dye is auto-scaled - live here, where
// node can test them.

import { deviationPercentile, inspectScalar, speedAtCell } from "../physics/fieldStats.js";
import { vorticityAtCell } from "../physics/probe.js";
import { continuityErrorAt } from "../solver/ns2d.js";

// The pressure scale is fitted to this fraction of the cells rather than to the
// extreme. Chosen from the distributions, not picked: at p99 roughly one cell
// in a hundred clips and the rest of the field gets several times more of the
// ramp, while p99.9 does essentially nothing and p95 throws away too much.
//
//   scenario      max|p-mean|   p99     cells clipped   field gets
//   bend-sharp        6.244    1.373    18 (0.96%)         4.5x
//   bend-smooth       2.899    0.695    17 (0.96%)         4.2x
//   cylinder          0.687    0.360   121 (1.00%)         1.9x
//   cavity            0.587    0.073    40 (0.98%)         8.1x
const PRESSURE_CLIP = 0.99;
import { sampleRamp, sampleDiverging, sampleDye } from "./colormap.js";

// A scale is NaN-poisoned rather than defaulted when the field is not usable.
// Every normalise() below divides by it, so a broken field yields NaN for
// every cell, and sampleRamp turns NaN into the not-finite colour instead of
// clamping it to an end of the ramp. That chain is the reason a NaN field
// cannot come out looking like a healthy picture.
const VELOCITY = {
  id: "velocity",
  label: "velocity magnitude",
  requires: "grid",
  note:
    "Speed at cell centres, averaged from the surrounding staggered faces. " +
    "Scaled to the largest speed currently present.",
  prepare(context) {
    const { grid } = context;
    const valueAt = (i, j) => speedAtCell(grid, i, j);
    const summary = inspectScalar(grid, valueAt);
    // A flat zero field is still a legitimate picture - still water - so it
    // scales to 1 and paints uniformly at the bottom of the ramp rather than
    // dividing by zero.
    const hi = summary.finite ? (summary.max > 0 ? summary.max : 1) : NaN;
    return {
      valueAt,
      summary,
      scale: { lo: 0, hi, centre: null, diverging: false },
      normalise: (value) => value / hi,
      ramp: sampleRamp,
    };
  },
};

const PRESSURE = {
  id: "pressure",
  label: "pressure",
  requires: "grid",
  // Two limitations that a pressure picture hides unless it is told not to,
  // both VISION 4.3 items. They are shown next to the view, not left for the
  // viewer to work out.
  note:
    "Shown relative to the domain mean: every scenario uses Neumann pressure " +
    "boundaries, so p is defined only up to an additive constant and absolute " +
    "values carry no meaning - only differences do. This is also the " +
    "projection pressure from a first-order Chorin step, which is accurate to " +
    "O(dt) and carries a known error layer near walls, where the numerical " +
    "condition dp/dn = 0 is a convenience rather than the true boundary " +
    "condition.",
  prepare(context) {
    const { grid } = context;
    const raw = (i, j) => grid.p[grid.idx(i, j)];
    const summary = inspectScalar(grid, raw);
    const mean = summary.mean;
    const spread = summary.finite
      ? Math.max(Math.abs(summary.max - mean), Math.abs(summary.min - mean))
      : NaN;
    // Fitted to the 99th percentile, not to the extreme.
    //
    // A geometric singularity - the mitre bend's sharp corner, the cavity's lid
    // corners - reaches many times the rms of the field around it, and a scale
    // drawn from the maximum spends almost the whole ramp on a handful of cells
    // while everything the picture is meant to explain collapses to the centre.
    // Measured on the mitre bend at t=8: the legend read +-9.66, set entirely by
    // two adjacent cells at the corner, and the duct became indistinguishable
    // from the wall.
    //
    // What is clipped is REPORTED rather than hidden - `clipped` carries the
    // count and the true range, and the panel prints both. Fitting a scale
    // quietly to a percentile would be exactly the kind of flattering picture
    // this layer is not allowed to draw; saying "12 cells are beyond this, and
    // the real range is X" is not.
    const percentile = summary.finite
      ? deviationPercentile(grid, raw, mean, PRESSURE_CLIP)
      : null;
    // A perfectly uniform pressure field is meaningful (still water) and must
    // land on the centre stop rather than dividing by zero.
    const fitted = percentile !== null && percentile.threshold > 0
      ? percentile.threshold
      : spread > 0 ? spread : 1;
    const amplitude = summary.finite ? fitted : NaN;
    return {
      valueAt: (i, j) => raw(i, j) - mean,
      summary,
      scale: {
        lo: -amplitude, hi: amplitude, centre: 0, diverging: true,
        clipped: percentile === null || percentile.beyond === 0 ? null : {
          cells: percentile.beyond,
          of: percentile.cells,
          trueLo: summary.min - mean,
          trueHi: summary.max - mean,
        },
      },
      // Clamped, so a clipped cell lands ON the end of the ramp rather than
      // running off it into a colour the scale does not describe.
      normalise: (value) =>
        Math.min(1, Math.max(0, 0.5 + (0.5 * value) / amplitude)),
      ramp: sampleDiverging,
    };
  },
};

// Vorticity is clipped at the same percentile as pressure, and for a weaker
// reason, which is why the number is different.
//
// Measured over 400 steps, max|w| against its own p99 and rms:
//
//   scenario          max|w|    p99     rms    max/p99  max/rms
//   bend-sharp         35.76   15.17    4.48      2.4      8.0
//   bend-smooth        31.05   11.75    4.08      2.6      7.6
//   cylinder           12.32    2.70    0.67      4.6     18.3
//   cavity             59.44   22.57    4.99      2.6     11.9
//   pressure-channel    3.28    3.28    1.75      1.0      1.9
//   jet                10.57    7.74    2.31      1.4      4.6
//
// Less concentrated than pressure (max/rms 8.9 to 20.3 there), because a
// vorticity extreme is usually a WALL LAYER - an extended structure that is
// the whole point of the view - rather than the two corner cells that set the
// pressure scale on the mitre bend. The percentile is self-limiting for
// exactly that reason: on the pressure channel, where the extreme is a full
// row of wall cells, p99 IS the maximum and nothing is clipped at all. Where
// the extreme is concentrated - the cylinder's staircase surface - the rest of
// the field gets 4.6x more of the ramp and 1% of cells clip, reported.
const VORTICITY_CLIP = 0.99;

const VORTICITY = {
  id: "vorticity",
  label: "vorticity",
  requires: "grid",
  note:
    "omega = dv/dx - du/dy at cell centres, averaged from the four surrounding " +
    "corners where the staggered grid computes it exactly. Second order in the " +
    "interior and verified against a closed-form field; against a wall the " +
    "corner values come from the surface faces, making that estimate one-sided " +
    "and first order - see docs/M7-probes.md. The scale is centred on ZERO, " +
    "which is vorticity's own datum rather than a convention: irrotational " +
    "fluid reads as the centre colour and the sign carries the direction of " +
    "rotation.",
  prepare(context) {
    const { grid } = context;
    const valueAt = (i, j) => vorticityAtCell(grid, i, j);
    const summary = inspectScalar(grid, valueAt);
    // Centred on ZERO rather than on the mean. That is the one difference from
    // the pressure view and it is not cosmetic: pressure's datum is arbitrary,
    // so its picture must be relative to something, while vorticity has a
    // physical zero and shifting it would paint still fluid as rotating.
    const percentile = summary.finite
      ? deviationPercentile(grid, valueAt, 0, VORTICITY_CLIP)
      : null;
    const extreme = summary.finite
      ? Math.max(Math.abs(summary.max), Math.abs(summary.min))
      : NaN;
    const fitted = percentile !== null && percentile.threshold > 0
      ? percentile.threshold
      : extreme > 0 ? extreme : 1;
    const amplitude = summary.finite ? fitted : NaN;
    return {
      valueAt,
      summary,
      scale: {
        lo: -amplitude, hi: amplitude, centre: 0, diverging: true,
        clipped: percentile === null || percentile.beyond === 0 ? null : {
          cells: percentile.beyond,
          of: percentile.cells,
          trueLo: summary.min,
          trueHi: summary.max,
        },
      },
      normalise: (value) =>
        Math.min(1, Math.max(0, 0.5 + (0.5 * value) / amplitude)),
      ramp: sampleDiverging,
    };
  },
};

// The continuity view is the one view here whose scale is FIXED, and choosing
// what to fix it to took two goes.
//
// Every other view fits itself to the field. Doing that here would be actively
// misleading: this quantity is supposed to be zero, and a scale fitted to it
// would paint the rounding noise of a perfectly healthy solve at full
// saturation. A viewer would see a domain covered in structure and conclude
// the simulation was failing, when what they were looking at is the last digit
// of a converged pressure solve.
//
// THE FIRST FIX HAD THE SAME FAULT. Anchoring at +-divergenceTol - the number
// step() actually guarantees - sounds exactly right and produces the identical
// picture, because a converged solve stops AT its tolerance rather than far
// below it. Measured across these scenarios after 400 steps:
//
//   scenario           max|div u|   p99|div u|   bound
//   bend-sharp            7.75e-8     5.81e-8    1e-7
//   bend-smooth           8.80e-8     6.40e-8    1e-7
//   cylinder              9.48e-8     5.34e-8    1e-7
//   cavity                9.76e-8     6.07e-8    1e-7
//   pressure-channel      7.84e-8     6.90e-8    1e-7
//   jet                   7.74e-8     5.29e-8    1e-7
//
// Typical cells sit at 50-98% of the bound. Normalising against the bound puts
// them at 50-98% of the ramp, which is saturation. Those numbers were measured
// before the scale was written and were not checked against it.
//
// So the anchor is a DECADE past the bound. A healthy field then occupies the
// innermost tenth of the ramp and reads as near-uniform, which is the correct
// picture; the tolerance itself sits a tenth of the way out, so a field at the
// limit is a visible tint rather than an alarm; and a field an order of
// magnitude past the promise saturates, which is when an alarm is deserved.
// Same argument as the dye view's fixed 0..1 range, applied to a quantity
// whose interesting value is "nothing here".
const DIVERGENCE_HEADROOM = 10;
//
// It shows the CONTINUITY ERROR, div u - q, not the raw divergence - and is
// labelled that way whether or not a mass source is running, for the reason
// given in docs/M6-sources.md: with one running, max|div u| is q by design and
// reads about 1.8 where the bound is 1e-7. A view called "divergence" would
// light up red for a source that is working perfectly.
const CONTINUITY = {
  id: "continuity",
  label: "continuity error",
  requires: "grid",
  note:
    "div u - q at each fluid cell: how far the projection is from delivering " +
    "the divergence the sources ask for, which is zero unless a mass source is " +
    "running. The scale is FIXED rather than fitted to the field, and anchored " +
    "a DECADE past the solver's divergence tolerance - a converged solve stops " +
    "AT its tolerance rather than far below it, so anchoring at the bound " +
    "itself paints the rounding noise of a healthy solve at full saturation. " +
    "A near-uniform picture here is therefore the correct one. The tolerance " +
    "falls one tenth of the way out from the centre; reaching the ends of the " +
    "ramp means ten times past what the projection promises.",
  prepare(context) {
    const { grid, sources = null, divergenceTol } = context;
    const valueAt = (i, j) => continuityErrorAt(grid, sources, i, j);
    const summary = inspectScalar(grid, valueAt);
    // The bound is read from the scenario, with a fallback that matches every
    // scenario in the project rather than a number invented here.
    const bound = Number.isFinite(divergenceTol) && divergenceTol > 0
      ? divergenceTol
      : 1e-7;
    const amplitude = bound * DIVERGENCE_HEADROOM;
    return {
      valueAt,
      summary,
      scale: {
        lo: -amplitude, hi: amplitude, centre: 0, diverging: true,
        fixed: true,
        // The promise, kept beside the scale so the legend can say where on
        // the ramp it falls rather than leaving the headroom unexplained.
        bound,
        // Cells past the bound are counted and named. Unlike the percentile
        // clip elsewhere, one here is not a display trade-off - it is the
        // solver failing to keep a promise, and it must be impossible to
        // mistake for a scaling choice.
        // Counted against the BOUND, not against the scale. The scale is a
        // display choice; the bound is what the solver undertook to deliver,
        // and it is the only one of the two a reader should be told about.
        breached: summary.finite
          ? countBeyond(grid, valueAt, bound)
          : null,
      },
      normalise: (value) =>
        Math.min(1, Math.max(0, 0.5 + (0.5 * value) / amplitude)),
      ramp: sampleDiverging,
    };
  },
};

function countBeyond(grid, valueAt, bound) {
  const { nx, ny, solid } = grid;
  let cells = 0;
  let of = 0;
  let worst = 0;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      if (solid[grid.idx(i, j)]) continue;
      of++;
      const magnitude = Math.abs(valueAt(i, j));
      if (magnitude > bound) cells++;
      if (magnitude > worst) worst = magnitude;
    }
  }
  return { cells, of, worst };
}

const DYE = {
  id: "dye",
  label: "dye (visualization aid)",
  requires: "tracer",
  note:
    "A passive scalar advected by the velocity field. It is NOT a solver " +
    "state field and nothing computed from it feeds back into the flow - see " +
    "tracer/passiveScalar.js. Concentration runs 0 to 1 by construction and " +
    "the scale is FIXED at that range, never fitted to the dye currently " +
    "present: an auto-scaled dye view would repaint a nearly empty domain as " +
    "a full one every frame.",
  prepare(context) {
    const { grid, tracer } = context;
    const valueAt = (i, j) => tracer.c[grid.idx(i, j)];
    const summary = inspectScalar(grid, valueAt);
    // The scale stays 0..1 even when the field is broken; what must not
    // survive a broken field is the per-cell value, and a NaN concentration
    // normalises to NaN and paints as not-finite regardless of the scale.
    return {
      valueAt,
      summary,
      scale: { lo: 0, hi: 1, centre: null, diverging: false },
      normalise: (value) => value,
      ramp: sampleDye,
    };
  },
};

export const FIELD_SOURCES = [VELOCITY, PRESSURE, VORTICITY, CONTINUITY, DYE];
export const DEFAULT_FIELD_SOURCE = "velocity";

export function fieldSourceById(id) {
  return FIELD_SOURCES.find((source) => source.id === id) ?? null;
}

export function fieldSourceAvailable(id, context) {
  const source = fieldSourceById(id);
  if (!source) return false;
  if (source.requires === "tracer") return Boolean(context?.tracer);
  return Boolean(context?.grid);
}

// Builds everything the renderer and the legend need for one frame.
// Returns null for a source that cannot be shown with the state on hand -
// the dye view with no tracer - so the caller says so rather than painting
// an empty field and letting it read as "no dye here".
export function prepareView(sourceId, context) {
  const source = fieldSourceById(sourceId) ?? fieldSourceById(DEFAULT_FIELD_SOURCE);
  if (!fieldSourceAvailable(source.id, context)) return null;
  const prepared = source.prepare(context);
  return {
    id: source.id,
    label: source.label,
    note: source.note,
    ...prepared,
  };
}
