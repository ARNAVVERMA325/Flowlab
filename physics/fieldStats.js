// Derived quantities read off a velocity field for display.
//
// Reads solver output. Never writes to it.
//
// The whole of this module exists under one rule: a broken field must be
// impossible to mistake for a healthy one.
//
// The solver previously had a bug where `if (a > max) max = a` silently skipped
// NaN, so an entirely NaN field reported a maximum divergence of exactly zero
// and a "converged" pressure solve. That is fixed in the solver, but the same
// mistake is available to every consumer that reduces over a field - a colour
// scale computed as `max = Math.max(max, speed)` produces a perfectly ordinary
// looking legend from a field of NaN. So nothing here reduces with a bare
// comparison: every value is classified with Number.isFinite first, and the
// count of non-finite cells is reported alongside any range, so a caller cannot
// obtain a range without also being handed the evidence that it is meaningless.

export function speedAtCell(grid, i, j) {
  const u = (grid.u[grid.idx(i - 1, j)] + grid.u[grid.idx(i, j)]) / 2;
  const v = (grid.v[grid.idx(i, j - 1)] + grid.v[grid.idx(i, j)]) / 2;
  return Math.hypot(u, v);
}

// Scans the fluid cells and reports both the range and the field's health.
//
//   finite          false if ANY fluid cell holds a non-finite value
//   nonFiniteCells  how many
//   firstNonFinite  where the first one is, for reporting
//   minSpeed/maxSpeed  over the finite cells only; NaN when there are none
export function inspectField(grid) {
  const { nx, ny, solid } = grid;

  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let finiteCells = 0;
  let nonFiniteCells = 0;
  let firstNonFinite = null;

  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      if (solid[grid.idx(i, j)]) continue;
      const speed = speedAtCell(grid, i, j);
      if (!Number.isFinite(speed)) {
        nonFiniteCells++;
        if (firstNonFinite === null) firstNonFinite = { i, j };
        continue;
      }
      finiteCells++;
      if (speed < minSpeed) minSpeed = speed;
      if (speed > maxSpeed) maxSpeed = speed;
    }
  }

  const haveRange = finiteCells > 0;
  return {
    finite: nonFiniteCells === 0 && finiteCells > 0,
    fluidCells: finiteCells + nonFiniteCells,
    finiteCells,
    nonFiniteCells,
    firstNonFinite,
    minSpeed: haveRange ? minSpeed : NaN,
    maxSpeed: haveRange ? maxSpeed : NaN,
  };
}

// The same scan for an arbitrary cell-centred scalar - pressure, dye, anything
// the display wants to colour. `valueAt(i, j)` supplies the value; this module
// does not need to know what field it came from.
//
// Same rule as inspectField, for the same reason: the range and the count of
// non-finite cells are returned together, so no caller can obtain a colour
// scale without also being handed the evidence that it is meaningless. `mean`
// is here because a pressure field with all-Neumann boundaries is only defined
// up to a constant, so the display has to subtract something before it can
// show it - see visualization/fieldSources.js.
// The magnitude below which a given fraction of the fluid cells fall, measured
// as |value - centre|.
//
// This exists because fitting a colour scale to the extreme is fitting it to
// whatever singularity the geometry happens to contain. On the mitre bend the
// sharp corner reaches |p - mean| = 6.24 while the rms over the whole domain is
// 0.70 - a ratio of 8.9 - so a scale drawn from the maximum squashes the
// pressure field that actually explains the flow into the middle of the ramp
// and leaves it invisible. The lid-driven cavity is worse: max/rms = 20.3.
//
// Returns null when the field is not usable, so a caller cannot get a plausible
// number out of a broken field.
export function deviationPercentile(grid, valueAt, centre, fraction) {
  const { nx, ny, solid } = grid;
  const deviations = [];
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      if (solid[grid.idx(i, j)]) continue;
      const value = valueAt(i, j);
      if (!Number.isFinite(value)) return null;
      deviations.push(Math.abs(value - centre));
    }
  }
  if (deviations.length === 0) return null;
  deviations.sort((a, b) => a - b);
  const index = Math.min(deviations.length - 1, Math.floor(fraction * deviations.length));
  const threshold = deviations[index];
  let beyond = 0;
  for (const deviation of deviations) if (deviation > threshold) beyond++;
  return { threshold, beyond, cells: deviations.length };
}

export function inspectScalar(grid, valueAt) {
  const { nx, ny, solid } = grid;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let finiteCells = 0;
  let nonFiniteCells = 0;
  let firstNonFinite = null;

  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      if (solid[grid.idx(i, j)]) continue;
      const value = valueAt(i, j);
      if (!Number.isFinite(value)) {
        nonFiniteCells++;
        if (firstNonFinite === null) firstNonFinite = { i, j };
        continue;
      }
      finiteCells++;
      sum += value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  const usable = nonFiniteCells === 0 && finiteCells > 0;
  return {
    finite: usable,
    fluidCells: finiteCells + nonFiniteCells,
    finiteCells,
    nonFiniteCells,
    firstNonFinite,
    // A range drawn from the survivors of a partly broken field is not a range
    // anyone should scale a picture by, so it is withheld entirely.
    min: usable ? min : NaN,
    max: usable ? max : NaN,
    mean: usable ? sum / finiteCells : NaN,
  };
}
