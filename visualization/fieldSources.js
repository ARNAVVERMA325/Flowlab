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

export const FIELD_SOURCES = [VELOCITY, PRESSURE, DYE];
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
