// The velocity field as a function of position, for things that integrate it.
//
// Reads solver output. Never writes to it.
//
// ---------------------------------------------------------------------------
// WHY THIS INTERPOLATES WHEN physics/probe.js REFUSES TO
// ---------------------------------------------------------------------------
//
// A probe reports the CELL under the pointer and deliberately does not
// interpolate: it is a measurement shown to a person, and sliding smoothly
// between cells would hide the resolution the answer was computed at. See the
// note at the top of physics/probe.js.
//
// This module does the opposite, and the difference is the consumer. A
// streamline or a pathline is not a reading - it is a TRAJECTORY, produced by
// integrating the field between cell centres. Integrating a piecewise-constant
// field does not preserve the resolution; it manufactures a staircase that is
// not in the flow and is a worse lie about it than a smooth curve would be.
// The particle is genuinely between cells, so the field it sees has to be too.
//
// Both are honest about a different thing, and neither is the default for the
// other's job.
//
// ---------------------------------------------------------------------------
// WHAT THE INTERPOLATION KNOWS ABOUT WALLS
// ---------------------------------------------------------------------------
//
// It samples the arrays as they stand. Faces on a body's surface hold zero,
// which is the no-penetration condition and exactly right; faces INSIDE a body
// hold a reflection of the adjacent fluid value, which the solver puts there
// to serve the tangential no-slip stencil and which is not a velocity.
//
// A stencil anchored in fluid can reach one of those reflected faces within
// half a cell of the surface. Rather than special-casing the stencil - which
// would need a wall normal a staircase surface does not have - every consumer
// here STOPS at the first solid cell, so the reflected value can only affect
// the last half-cell of a trajectory that was about to end anyway. That limit
// is real and is written down rather than papered over.

// Cell-centred velocity: the mean of that cell's own two opposing faces.
// The same averaging physics/fieldStats.speedAtCell does, returning both
// components rather than the magnitude.
export function velocityAtCell(grid, i, j) {
  const k = grid.idx(i, j);
  return {
    u: (grid.u[grid.idx(i - 1, j)] + grid.u[k]) / 2,
    v: (grid.v[grid.idx(i, j - 1)] + grid.v[k]) / 2,
  };
}

// Bilinear interpolation from each component's OWN staggered positions.
//
//   u lives at (i*h, (j-0.5)*h)   for i = 0..nx, j = 1..ny
//   v lives at ((i-0.5)*h, j*h)   for i = 1..nx, j = 0..ny
//
// So the two components use different index offsets, and getting that wrong
// shifts the field by half a cell in a way that still looks like a flow. The
// check that catches it is exactness on a linear field: this reproduces
// u = ax + b exactly, so any half-cell slip shows up as a constant error.
export function velocityAt(grid, x, y) {
  const { h, nx, ny } = grid;
  const lerp = (a, b, t) => a + (b - a) * t;

  // u: no offset in x, half a cell in y.
  const ux = x / h;
  const uy = y / h + 0.5;
  const ui = clamp(Math.floor(ux), 0, nx - 1);
  const uj = clamp(Math.floor(uy), 0, ny);
  const utx = clamp(ux - ui, 0, 1);
  const uty = clamp(uy - uj, 0, 1);
  const u = lerp(
    lerp(grid.u[grid.idx(ui, uj)], grid.u[grid.idx(ui + 1, uj)], utx),
    lerp(grid.u[grid.idx(ui, uj + 1)], grid.u[grid.idx(ui + 1, uj + 1)], utx),
    uty
  );

  // v: half a cell in x, none in y.
  const vx = x / h + 0.5;
  const vy = y / h;
  const vi = clamp(Math.floor(vx), 0, nx);
  const vj = clamp(Math.floor(vy), 0, ny - 1);
  const vtx = clamp(vx - vi, 0, 1);
  const vty = clamp(vy - vj, 0, 1);
  const v = lerp(
    lerp(grid.v[grid.idx(vi, vj)], grid.v[grid.idx(vi + 1, vj)], vtx),
    lerp(grid.v[grid.idx(vi, vj + 1)], grid.v[grid.idx(vi + 1, vj + 1)], vtx),
    vty
  );

  return { u, v };
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

// Whether a physical point is in fluid. Outside the domain counts as not
// fluid, so one test ends a trajectory for either reason.
export function isFluidAt(grid, x, y) {
  const { nx, ny, h } = grid;
  if (!(x >= 0) || !(y >= 0) || x >= nx * h || y >= ny * h) return false;
  const i = Math.floor(x / h) + 1;
  const j = Math.floor(y / h) + 1;
  return grid.solid[grid.idx(i, j)] === 0;
}

// One midpoint (RK2) step along the field.
//
// RK2 rather than Euler because a streamline through a vortex is the case
// these are most often used to look at, and Euler spirals outward there at a
// rate proportional to the step - producing a picture of a vortex that is
// decaying when the simulation's is not. RK4 was not chosen: it costs four
// evaluations per step for an accuracy that is not visible at the step sizes
// used here, and halving the step with RK2 is cheaper and more predictable.
//
// `ds` is an ARC LENGTH, not a time: the field is normalised to a unit
// direction first, so the points along a streamline are evenly spaced in
// distance regardless of how fast the fluid is moving. Stepping by time
// instead clusters points where the flow is slow, which is exactly where a
// streamline needs them least and where the stagnation test below should be
// ending it anyway.
//
// Returns null where the field has no direction - a stagnation point, or a
// non-finite cell - so the caller ends the line rather than integrating a
// direction it invented.
export function traceStep(grid, x, y, ds) {
  const first = velocityAt(grid, x, y);
  const d0 = direction(first);
  if (d0 === null) return null;
  const midX = x + d0.x * ds * 0.5;
  const midY = y + d0.y * ds * 0.5;
  const second = velocityAt(grid, midX, midY);
  const d1 = direction(second);
  if (d1 === null) return null;
  return { x: x + d1.x * ds, y: y + d1.y * ds, speed: Math.hypot(first.u, first.v) };
}

function direction({ u, v }) {
  const magnitude = Math.hypot(u, v);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  return { x: u / magnitude, y: v / magnitude };
}
