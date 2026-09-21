// The velocity gradient tensor, and what falls out of it.
//
// Reads solver output. Never writes to it.
//
// ---------------------------------------------------------------------------
// WHERE EACH COMPONENT LIVES
// ---------------------------------------------------------------------------
//
// On a MAC grid the four components of grad(u) are not in the same place, and
// two of them are free while two are not:
//
//   du/dx = (u[i,j] - u[i-1,j]) / h        exact AT THE CELL CENTRE
//   dv/dy = (v[i,j] - v[i,j-1]) / h        exact AT THE CELL CENTRE
//   du/dy = (u[i,j+1] - u[i,j]) / h        exact AT THE CORNER
//   dv/dx = (v[i+1,j] - v[i,j]) / h        exact AT THE CORNER
//
// The diagonal terms are centred differences of the two faces that bracket the
// cell; the off-diagonal terms are centred on the corner, exactly as vorticity
// is - which is the same fact seen twice, since vorticity IS dv/dx - du/dy.
//
// So bringing the tensor to one place needs the off-diagonals averaged from
// the four corners, and this module does that rather than pretending the
// difference does not exist. The consequence is recorded in M7 and holds here:
// the averaged terms stay second order in the interior and become one-sided,
// first-order estimates against a wall.
//
// The cross-check that keeps this honest is that vorticity computed here must
// equal physics/probe.js's to the last bit. Two derivations of the same
// quantity that can drift apart is the shape this project keeps finding, so a
// test pins them together.

import { vorticityAtCell, vorticityAtNode } from "./probe.js";

// The full tensor at a cell centre.
export function velocityGradientAt(grid, i, j) {
  const { h } = grid;
  const k = grid.idx(i, j);
  const dudx = (grid.u[k] - grid.u[grid.idx(i - 1, j)]) / h;
  const dvdy = (grid.v[k] - grid.v[grid.idx(i, j - 1)]) / h;

  // The off-diagonals, averaged from the four corners of this cell.
  let dudy = 0;
  let dvdx = 0;
  for (const [a, b] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) {
    dudy += (grid.u[grid.idx(a, b + 1)] - grid.u[grid.idx(a, b)]) / h;
    dvdx += (grid.v[grid.idx(a + 1, b)] - grid.v[grid.idx(a, b)]) / h;
  }
  return { dudx, dvdy, dudy: dudy / 4, dvdx: dvdx / 4 };
}

// Engineering shear rate: the off-diagonal of the strain-rate tensor, doubled.
//
//   gamma_dot = du/dy + dv/dx
//
// Not to be confused with vorticity, which is the same two terms SUBTRACTED.
// The pair is the whole content of the decomposition: a flow can have large
// shear and no rotation (a uniform shear layer), large rotation and no shear
// (solid-body rotation), or both. Reporting one under the other's name would
// make a shear layer look like a vortex, which is the distinction a viewer is
// most often trying to make.
export function shearRateAt(grid, i, j) {
  const { dudy, dvdx } = velocityGradientAt(grid, i, j);
  return dudy + dvdx;
}

// Vorticity, delegated to physics/probe.js rather than recomputed.
//
// It would be one line here - dv/dx minus du/dy, both already in the tensor -
// and that line is why this delegates instead. Taking the four corner
// vorticities and averaging them is not the same FLOATING-POINT operation as
// averaging du/dy and dv/dx separately and then subtracting, even though it is
// the same arithmetic: measured at up to 1.8e-15 apart on a cylinder run.
// Small, and the beginning of two numbers called "vorticity" that a reader
// would reasonably expect to be one.
//
// Q below deliberately does NOT delegate: it compares the rotation tensor
// against the strain tensor, and both have to come from the same tensor or the
// comparison is between two slightly different fields. That is the one place
// the tensor's own pair is the right pair.
export function vorticityFromGradient(grid, i, j) {
  return vorticityAtCell(grid, i, j);
}

// The Q-criterion (Hunt, Wray & Moin 1988): half the difference between the
// squared magnitudes of the rotation-rate and strain-rate tensors.
//
//   Q = 0.5 * (|Omega|^2 - |S|^2)
//
// Q > 0 where rotation dominates strain - a vortex core. Q < 0 where strain
// dominates - a shear layer or a stagnation region. Q = 0 in pure shear, where
// they balance exactly.
//
// This is the standard local vortex-identification criterion and it is chosen
// over "the velocity is negative" for one reason: the latter needs a direction
// to be negative RELATIVE TO, and every choice of that direction is a property
// of the domain rather than of the flow. Q needs nothing but the field, so it
// means the same thing in a channel, a cavity and a bend.
//
// In 2D, with S the symmetric part and Omega the antisymmetric part:
//
//   |Omega|^2 = omega^2 / 2
//   |S|^2     = (du/dx)^2 + (dv/dy)^2 + (gamma_dot)^2 / 2
//
// which gives three exact values worth knowing: solid-body rotation at rate
// W has Q = W^2, pure shear has Q = 0 exactly, and planar strain at rate a
// has Q = -a^2.
export function qCriterionAt(grid, i, j) {
  const { dudx, dvdy, dudy, dvdx } = velocityGradientAt(grid, i, j);
  const vorticity = dvdx - dudy;
  const shear = dudy + dvdx;
  const rotation = (vorticity * vorticity) / 2;
  const strain = dudx * dudx + dvdy * dvdy + (shear * shear) / 2;
  return 0.5 * (rotation - strain);
}

// A cell counts as rotation-dominated when rotation exceeds strain by this
// margin, rather than when Q is merely positive.
//
// Q > 0 is the textbook statement and it is a COIN FLIP in a shear flow. Pure
// shear has |Omega|^2 = |S|^2 exactly, so Q is analytically zero and its
// measured sign is decided by the last bits of a difference of two nearly
// equal numbers. Measured on the pressure channel - a fully developed
// Poiseuille flow, which is pure shear everywhere and contains no vortex at
// all - a bare Q > 0 test reported 49.2% of the fluid as rotating.
//
// A RELATIVE margin rather than an absolute threshold, so it is scale-free:
// there is no velocity or length in it, and it means the same thing in a
// cavity at Re 1000 and a channel at Re 20. 10% is a round number and the
// panel says what it is, the same way the percentile clip on the pressure
// scale does.
const ROTATION_MARGIN = 0.1;

// How much of the fluid is turning rather than shearing or stretching.
//
// Reported as a COUNT and a fraction rather than as a mask, because the useful
// question is "is there a recirculation here at all" and the answer is a
// number a panel can show beside the picture. Non-finite cells are counted
// separately and never folded into either total - the rule the rest of
// physics/ follows.
export function rotationSummary(grid, { margin = ROTATION_MARGIN } = {}) {
  const { nx, ny, solid } = grid;
  let rotating = 0;
  let straining = 0;
  let fluid = 0;
  let nonFinite = 0;
  let peak = 0;
  let peakAt = null;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      if (solid[grid.idx(i, j)]) continue;
      const { dudx, dvdy, dudy, dvdx } = velocityGradientAt(grid, i, j);
      const vorticity = dvdx - dudy;
      const shear = dudy + dvdx;
      const rotation = (vorticity * vorticity) / 2;
      const strain = dudx * dudx + dvdy * dvdy + (shear * shear) / 2;
      const q = 0.5 * (rotation - strain);
      if (!Number.isFinite(q)) { nonFinite++; continue; }
      fluid++;
      if (rotation > (1 + margin) * strain) rotating++;
      else if (strain > (1 + margin) * rotation) straining++;
      if (q > peak) { peak = q; peakAt = { i, j }; }
    }
  }
  return {
    rotating,
    straining,
    // Neither: within the margin of each other, which is what a shear layer
    // is. Counted rather than absorbed into one side or the other.
    balanced: fluid - rotating - straining,
    fluid,
    nonFinite,
    margin,
    fraction: fluid > 0 ? rotating / fluid : NaN,
    peak: fluid > 0 ? peak : NaN,
    peakAt,
  };
}

// The largest shear rate anywhere in the fluid, and where.
export function shearSummary(grid) {
  const { nx, ny, solid } = grid;
  let peak = 0;
  let peakAt = null;
  let fluid = 0;
  let nonFinite = 0;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      if (solid[grid.idx(i, j)]) continue;
      const value = shearRateAt(grid, i, j);
      if (!Number.isFinite(value)) { nonFinite++; continue; }
      fluid++;
      if (Math.abs(value) > Math.abs(peak)) { peak = value; peakAt = { i, j }; }
    }
  }
  return { peak: fluid > 0 ? peak : NaN, peakAt, fluid, nonFinite };
}

// Kept so a caller that wants the corner value can have it without importing
// two modules for one quantity.
export { vorticityAtCell, vorticityAtNode };
