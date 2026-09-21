// The flow analysis summary: the numbers a panel shows about a running flow.
//
// Reads solver output. Never writes to it.
//
// Pure, so node can test the decisions - which Reynolds number is being
// reported, what a pressure difference is measured between, what is withheld -
// without a browser. The harness formats what comes back and adds nothing.
//
// ---------------------------------------------------------------------------
// TWO REYNOLDS NUMBERS, EACH NAMED BY ITS SPEED
// ---------------------------------------------------------------------------
//
// A scenario's Reynolds number is an INPUT: the build function picks Re and a
// reference pair (U, L), and derives nu from them. Nothing in the app could
// previously reconstruct it, because the pair was local to the builder and not
// recorded - so `reference` is now declared beside `Re`, and a test asserts
// that Re is round(U*L/nu) for every scenario. That closes a hole nothing was
// checking: a scenario whose nu was edited and whose Re label was not would
// have gone on claiming the old number.
//
// The second number is the PEAK Reynolds number, u_max*L/nu, using the same
// length and the fastest fluid actually present. It is always at least the
// declared one and says how far the flow locally exceeds its nominal regime -
// the sharp bend's corner jet reaches about 2.9 times the inlet speed, which
// is a fact about the flow that the declared number cannot show.
//
// Both are named by the speed they use. The M7 lesson applies unchanged: two
// quantities that answer to one name must never be allowed to share it.

import { rotationSummary, shearSummary } from "./gradients.js";
import { inspectScalar, speedAtCell } from "./fieldStats.js";
import { separationPoints, surfaceFaces, surfacePerimeter, wallShearSummary } from "./wallShear.js";

export function analyseFlow(grid, { nu, rho = 1, plan = null, reference = null, Re = null } = {}) {
  const speed = inspectScalar(grid, (i, j) => speedAtCell(grid, i, j));
  const pressure = inspectScalar(grid, (i, j) => grid.p[grid.idx(i, j)]);

  const faces = surfaceFaces(grid, { nu, rho, plan });
  const wall = wallShearSummary(faces);
  const separations = separationPoints(faces, grid);

  const length = reference && Number.isFinite(reference.L) ? reference.L : null;
  const peakRe = length !== null && Number.isFinite(speed.max) && nu > 0
    ? (speed.max * length) / nu
    : NaN;

  return {
    // What the scenario declares, and what it is built from.
    declaredRe: Re,
    reference,
    // The same length, the fastest fluid present.
    peakRe,
    peakSpeed: speed.max,
    speedIsUsable: speed.finite,

    shear: shearSummary(grid),
    rotation: rotationSummary(grid),

    wall: {
      ...wall,
      perimeter: surfacePerimeter(grid, faces),
      // How much of the wall is a drawn body rather than a domain boundary.
      // Kept because the integration refusal is about curved drawn bodies, and
      // a domain with none is a domain where it would not have bitten.
      bodyFaces: faces.filter((face) => face.boundary === undefined).length,
    },
    separations,

    pressure: {
      // The RANGE, not an absolute value. With nothing prescribing a pressure
      // the field is a gauge and only differences mean anything - see
      // solver/ns2d.pressureIsGauge - so the range is the largest honest
      // statement that needs no second point.
      range: pressure.finite ? pressure.max - pressure.min : NaN,
      min: pressure.min,
      max: pressure.max,
      usable: pressure.finite,
    },
  };
}

// The pressure difference between two points, which is the only form of
// pressure reading that is meaningful under every boundary condition.
//
// Returns null when either point is outside the fluid, rather than a number
// built from a cell with no fluid in it. `from` and `to` are physical points.
export function pressureDropBetween(grid, from, to) {
  const at = (point) => {
    const { nx, ny, h } = grid;
    const i = Math.floor(point.x / h) + 1;
    const j = Math.floor(point.y / h) + 1;
    if (i < 1 || i > nx || j < 1 || j > ny) return null;
    if (grid.solid[grid.idx(i, j)]) return null;
    return { i, j, p: grid.p[grid.idx(i, j)] };
  };
  const a = at(from);
  const b = at(to);
  if (a === null || b === null) return null;
  return {
    from: a, to: b,
    // b minus a: positive means the pressure is higher at `to`.
    drop: b.p - a.p,
    distance: Math.hypot(b.i - a.i, b.j - a.j) * grid.h,
  };
}
