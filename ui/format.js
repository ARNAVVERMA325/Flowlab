// Number formatting for the readouts.
//
// These functions never substitute a placeholder for a bad value. There is no
// `?? 0`, no `|| "-"`, no try/catch that falls back to a dash. If a quantity is
// NaN or infinite, that is what the panel shows, because the alternative is a
// readout that looks fine while the simulation is broken - which is the exact
// failure this harness is required not to have.
//
// `Number.prototype.toExponential` already renders NaN as "NaN" and Infinity as
// "Infinity", so the honest path is mostly a matter of not adding a fallback.
// The explicit checks below exist so the intent survives future edits.

export function isBad(value) {
  return typeof value !== "number" || !Number.isFinite(value);
}

export function exponential(value, digits = 2) {
  if (typeof value !== "number") return "not a number";
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Infinity" : "-Infinity";
  return value.toExponential(digits);
}

export function fixed(value, digits = 4) {
  if (typeof value !== "number") return "not a number";
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Infinity" : "-Infinity";
  return value.toFixed(digits);
}

export function integer(value) {
  if (typeof value !== "number") return "not a number";
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Infinity" : "-Infinity";
  return String(Math.round(value));
}

// A short number for a legend tick or a top-bar readout: three significant
// figures in plain notation across the range a person reads comfortably, and
// exponential outside it. The non-finite cases go through the same path as
// exponential(), so a broken value still reads as NaN rather than as a blank.
export function compact(value) {
  if (typeof value !== "number") return "not a number";
  if (!Number.isFinite(value)) return exponential(value);
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-3 && magnitude < 1e4) {
    return String(Number(value.toPrecision(3)));
  }
  return value.toExponential(2);
}
