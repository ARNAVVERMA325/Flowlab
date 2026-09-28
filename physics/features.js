// Flow features located by measurement: the primary vortex of a cavity, the
// recirculation bubble behind a bluff body, the mean pressure across an inlet
// or an outlet.
//
// Reads solver output. Never writes to it.
//
// These began life in tests/support as the measurements the M2 validation
// cases are built on. M10's experiments need the same measurements in the
// app, and a second copy would be two definitions of one quantity free to
// drift apart - the shape this project keeps finding. So they live here, and
// the test helpers delegate to them: the validated numbers are produced by
// this code, and an edit here that moved them would fail the benchmarks.

// Centre of the primary vortex: the interior stagnation point, located as the
// cell of minimum speed inside a search window. The window excludes the outer
// band of a cavity because the weak secondary eddies in the corners are also
// stagnant and would otherwise win on a coarse grid. The default window is
// the one the Ghia comparison was validated with; it is in units of the
// cavity side.
export function primaryVortexCentre(grid, window = { x0: 0.15, x1: 0.9, y0: 0.3, y1: 0.95 }) {
  const { nx, ny, h } = grid;
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let j = 1; j <= ny; j++) {
    const y = (j - 0.5) * h;
    if (y < window.y0 || y > window.y1) continue;
    for (let i = 1; i <= nx; i++) {
      const x = (i - 0.5) * h;
      if (x < window.x0 || x > window.x1) continue;
      const uc = (grid.u[grid.idx(i - 1, j)] + grid.u[grid.idx(i, j)]) / 2;
      const vc = (grid.v[grid.idx(i, j - 1)] + grid.v[grid.idx(i, j)]) / 2;
      const speed = Math.hypot(uc, vc);
      if (speed < best) {
        best = speed;
        bx = x;
        by = y;
      }
    }
  }
  return { x: bx, y: by, speed: best };
}

function isFluidUFace(grid, i, j) {
  return !grid.solid[grid.idx(i, j)] && !grid.solid[grid.idx(i + 1, j)];
}

// Length of the standing recirculation bubble behind a body, measured along
// the row of u faces `row` from the body's rear face `rear` to where the
// velocity returns to zero, linearly interpolated to the sign change.
//
// Only faces with fluid on both sides are considered. Faces on the body
// surface carry a hard zero (no-penetration) and faces inside the body hold
// ghost values; neither is a velocity.
export function wakeLength(grid, { row, rear, D }) {
  const { nx, h } = grid;
  let sawReversal = false;
  let prevX = null;
  let prevU = null;
  for (let i = 1; i <= nx - 1; i++) {
    const x = i * h;
    if (x <= rear || !isFluidUFace(grid, i, row)) continue;
    const u = grid.u[grid.idx(i, row)];
    if (u < 0) {
      sawReversal = true;
      prevX = x;
      prevU = u;
      continue;
    }
    if (sawReversal) {
      const xr = prevX + (x - prevX) * (-prevU / (u - prevU));
      return { separated: true, length: xr - rear, lengthOverD: (xr - rear) / D };
    }
    return { separated: false, length: 0, lengthOverD: 0 };
  }
  return { separated: sawReversal, length: NaN, lengthOverD: NaN };
}

// The body as the solver sees it: the bounding box of the solid cells that
// are not walls of the domain. Measured from the mask rather than read from
// the scenario's builder, so an experiment reports on the staircase actually
// being simulated - its extent, its centre row - not on the circle it was
// sampled from.
export function bodyExtent(grid) {
  const { nx, ny, h, solid } = grid;
  let i0 = Infinity;
  let i1 = -Infinity;
  let j0 = Infinity;
  let j1 = -Infinity;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      if (!solid[grid.idx(i, j)]) continue;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
  }
  if (!Number.isFinite(i0)) return null;
  return {
    x0: (i0 - 1) * h, x1: i1 * h, y0: (j0 - 1) * h, y1: j1 * h,
    width: (i1 - i0 + 1) * h, height: (j1 - j0 + 1) * h,
    // The row through the middle of the body; exact for an odd row count.
    row: Math.round((j0 + j1) / 2),
  };
}

// Mean pressure over the fluid cells just inside every boundary face of a
// given condition type - "inflow", "outflow", "pressure" - read from the
// compiled plan the solver is running. The difference between two of these is
// a pressure DROP, which is meaningful whatever the pressure datum is; either
// one alone is not.
export function boundaryMeanPressure(grid, plan, types) {
  const wanted = new Set(Array.isArray(types) ? types : [types]);
  const { nx, ny, solid } = grid;
  let sum = 0;
  let cells = 0;
  const visit = (side, index, i, j) => {
    const condition = plan.conditions[plan.faces[side][index]];
    if (!condition || !wanted.has(condition.type)) return;
    const k = grid.idx(i, j);
    if (solid[k]) return;
    sum += grid.p[k];
    cells++;
  };
  for (let j = 1; j <= ny; j++) {
    visit("left", j, 1, j);
    visit("right", j, nx, j);
  }
  for (let i = 1; i <= nx; i++) {
    visit("bottom", i, i, 1);
    visit("top", i, i, ny);
  }
  return { mean: cells > 0 ? sum / cells : NaN, cells };
}
