// Reading the field at a point: what a probe reports, and what it refuses to.
//
// Reads solver output. Never writes to it.
//
// ---------------------------------------------------------------------------
// A PROBE REPORTS A CELL, NOT A POINT
// ---------------------------------------------------------------------------
//
// Nothing lives where you click. On a MAC grid u sits on vertical faces, v on
// horizontal faces, p at cell centres, and vorticity is naturally at the cell
// corners - four different places, none of them the pointer.
//
// The alternative to picking one is bilinear interpolation at the exact
// pointer position, which reads more smoothly and hides the thing a person
// most needs to see: the resolution. A probe that slides continuously across a
// three-cell-wide shear layer suggests the simulation resolves it that way. It
// does not. So every quantity is brought to the CELL CENTRE and the readout
// names the cell, for the same reason M5's drawing preview shows the sampled
// cells rather than the smooth outline it was dragged from.
//
// ---------------------------------------------------------------------------
// WHAT IS REFUSED
// ---------------------------------------------------------------------------
//
// A solid cell has no velocity to report. The faces around it hold values the
// solver put there for the stencils one layer out - a zero on the surface, a
// reflection inside the body - and those are ghosts serving the no-slip
// condition, not a flow. Averaging them produces a number, which is exactly
// the problem: it would look like fluid at rest rather than like no fluid.
//
// So a probe inside a body reports `solid: true` and NaN, and a probe outside
// the domain reports `inside: false`. Neither is a number anyone can mistake
// for a measurement.

// Which cell contains a physical point, or null if the point is outside the
// domain. Cell (i, j) spans x in [(i-1)h, i*h), so the index is floor(x/h) + 1.
export function cellAt(grid, x, y) {
  const { nx, ny, h } = grid;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const i = Math.floor(x / h) + 1;
  const j = Math.floor(y / h) + 1;
  if (i < 1 || i > nx || j < 1 || j > ny) return null;
  return { i, j };
}

// Vorticity at the cell corner (node) with its lower-left cell at (i, j).
//
//   omega = dv/dx - du/dy
//
// The node sits at (i*h, j*h). The two v faces used are half a cell either
// side of it in x and exactly on it in y; the two u faces are half a cell
// either side in y and exactly on it in x - so both differences are centred on
// the node and second-order, with no averaging anywhere. This is the one
// quantity the staggered grid gives for free, and it is why vorticity belongs
// at corners rather than at centres.
export function vorticityAtNode(grid, i, j) {
  const { h } = grid;
  const idx = (a, b) => grid.idx(a, b);
  const dvdx = (grid.v[idx(i + 1, j)] - grid.v[idx(i, j)]) / h;
  const dudy = (grid.u[idx(i, j + 1)] - grid.u[idx(i, j)]) / h;
  return dvdx - dudy;
}

// Vorticity at a cell centre: the mean of its four corners.
//
// At a wall the corner values are built from the surface faces, which the
// solver holds at zero for no-penetration and reflects for no-slip - so the
// difference quotient there is the usual one-sided estimate of wall vorticity
// rather than a centred one. That is where vorticity is generated and it is
// worth showing, but it is a first-order estimate sitting among second-order
// ones, which the documentation says and the number itself cannot.
export function vorticityAtCell(grid, i, j) {
  return (
    vorticityAtNode(grid, i - 1, j - 1) +
    vorticityAtNode(grid, i, j - 1) +
    vorticityAtNode(grid, i - 1, j) +
    vorticityAtNode(grid, i, j)
  ) / 4;
}

// Everything a probe reports about one cell.
//
// `nu` is needed for the cell Reynolds number and nothing else. It is passed
// rather than read off the grid because the grid does not carry it: viscosity
// is a property of the fluid, and this module is about the field.
export function probeCell(grid, i, j, { nu }) {
  const k = grid.idx(i, j);
  const { x, y } = grid.cellCentre(i, j);
  const base = { inside: true, i, j, x, y };

  if (grid.solid[k]) {
    return {
      ...base, solid: true, finite: false,
      u: NaN, v: NaN, speed: NaN, pressure: NaN, vorticity: NaN, cellRe: NaN,
    };
  }

  const u = (grid.u[grid.idx(i - 1, j)] + grid.u[k]) / 2;
  const v = (grid.v[grid.idx(i, j - 1)] + grid.v[k]) / 2;
  const speed = Math.hypot(u, v);
  const pressure = grid.p[k];
  const vorticity = vorticityAtCell(grid, i, j);
  // The CELL Reynolds number, |u|h/nu - the only Reynolds number that is
  // genuinely local. It compares advection to diffusion across one cell and is
  // a property of the discretisation as much as of the flow; it is not the
  // scenario's Reynolds number and is typically smaller by a factor of about
  // nx. Naming it "local Re" and letting it be read as the other one is the
  // kind of mislabelling this project keeps finding, so it is never called
  // that here or in the panel.
  const cellRe = Number.isFinite(nu) && nu > 0 ? (speed * grid.h) / nu : NaN;

  return {
    ...base,
    solid: false,
    // Reported together with the values, so no caller can take a number
    // without also being handed the evidence about whether it means anything -
    // the same rule physics/fieldStats.js follows for ranges.
    finite: [u, v, pressure, vorticity].every(Number.isFinite),
    u, v, speed, pressure, vorticity, cellRe,
  };
}

// The same, addressed by a physical point. Returns a sample whose `inside` is
// false when the point is not in the domain at all, rather than null, so a
// caller always has something to display.
export function probeAt(grid, x, y, options) {
  const cell = cellAt(grid, x, y);
  if (cell === null) {
    return {
      inside: false, solid: false, finite: false,
      i: null, j: null, x, y,
      u: NaN, v: NaN, speed: NaN, pressure: NaN, vorticity: NaN, cellRe: NaN,
    };
  }
  return probeCell(grid, cell.i, cell.j, options);
}
