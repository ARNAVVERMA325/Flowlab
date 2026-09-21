// Wall shear stress, and where a boundary layer separates.
//
// Reads solver output. Never writes to it.
//
// ---------------------------------------------------------------------------
// WHAT IS COMPUTED, AND WHAT IS REFUSED
// ---------------------------------------------------------------------------
//
// PER-FACE wall shear is computed. Every surface face on this grid is
// axis-aligned by construction - a face between a fluid cell and a solid one
// is a segment of a cell boundary - so its normal is exact, the tangential
// direction is exact, and
//
//   tau = mu * d(u_tangential)/dn
//
// is a proper velocity gradient at that face, accurate to the scheme's order.
// This is right for THE DOMAIN THE SOLVER IS SOLVING, which is the staircase,
// and that is the only domain there is.
//
// INTEGRATED wall force - total shear, drag, lift - is refused, and the reason
// is measured rather than cautious. Summing over surface faces sums over the
// staircase perimeter, and for a curved body that is not the perimeter of the
// body it represents. Measured on a circle of diameter D, at five resolutions:
//
//   n     staircase perimeter   true circle   ratio
//   16           2.0000           1.5708      1.2732
//   32           2.0000           1.5708      1.2732
//   64           2.0000           1.5708      1.2732
//   128          2.0000           1.5708      1.2732
//   256          2.0000           1.5708      1.2732
//
// The ratio is 4/pi exactly and IT DOES NOT CONVERGE. The staircase perimeter
// of any convex shape is the perimeter of its bounding box, at every
// resolution - the classic staircase paradox - so an integrated drag would be
// about 27% high on the cylinder and refining the grid would not reduce the
// error at all. A number that wrong, and wrong in a way more resolution cannot
// fix, is not a number to put beside correct ones.
//
// This is the same refusal M5 makes for flux-prescribing conditions on drawn
// surfaces, for the same underlying reason and with the same remedy: a cut-cell
// or immersed-boundary treatment, which is well beyond this solver.
//
// On an AXIS-ALIGNED body the staircase perimeter is exact - measured at 12.00
// for the sharp bend, which is its true wall length - so integration would be
// legitimate there. It is still not offered, because deciding which case a
// domain is in needs a classifier with a threshold in it, and a number that is
// sometimes meaningful is worse than one that is never shown. See
// docs/M9-flow-analysis.md.

// One surface face.
//
//   axis      "x" for a vertical surface (normal along x), "y" for horizontal
//   solidSide -1 if the solid cell is the lower-index one, +1 if the higher
//   tangential the tangential velocity half a cell out in the fluid
//   tau       mu * tangential / (h/2), signed along +y (axis "x") or +x ("y")
//
// The sign is taken along a FIXED axis direction rather than relative to the
// outward normal. For separation - which is where the tangential flow along a
// wall reverses - a consistent direction is what matters, and a normal-relative
// sign would flip at every step of a staircase for no physical reason.
// ---------------------------------------------------------------------------
// TWO KINDS OF WALL, AND THE PROXY THAT MISSED ONE
// ---------------------------------------------------------------------------
//
// The first version of this keyed on `solid[i] !== solid[i+1]` - a face with
// exactly one solid neighbour. That is a proxy for "the fluid meets a no-slip
// wall here", and the two come apart for half the scenarios in this project:
// the cavity's lid and the pressure channel's walls are BOUNDARY CONDITIONS,
// not solid cells, so both reported zero surface faces and no wall shear at
// all. The cavity's lid is the single most interesting wall in the project.
//
// This is instance 8 of working agreement item 8's shape, caught before it
// shipped rather than after. The property actually meant is "is there a
// no-slip wall at this face", and it is asked of the compiled boundary plan as
// well as of the mask.
//
// A `freeSlip` boundary is deliberately NOT included. It has zero tangential
// stress by construction, so a face there would be a true zero among measured
// values - reporting it would pad the surface with cells that can never
// separate and can never carry the peak.
export function surfaceFaces(grid, { nu, rho = 1, plan = null } = {}) {
  const { nx, ny, h, solid, u, v } = grid;
  const mu = nu * rho;
  const faces = [];

  // Domain-boundary walls, from the plan the solver is actually running.
  if (plan !== null) {
    const wallAt = (side, index) => {
      const condition = plan.conditions[plan.faces[side][index]];
      return condition && condition.type === "wall" ? condition : null;
    };
    for (let j = 1; j <= ny; j++) {
      for (const [side, i, sign] of [["left", 1, 1], ["right", nx, -1]]) {
        const condition = wallAt(side, j);
        if (condition === null || solid[grid.idx(i, j)]) continue;
        const k = grid.idx(i, j);
        // Relative to the WALL's own velocity: a moving wall shears the fluid
        // by the difference, and a lid dragging fluid with it at exactly its
        // own speed exerts none.
        const wall = condition.v ?? 0;
        const tangential = (v[k] + v[grid.idx(i, j - 1)]) / 2 - wall;
        faces.push({
          axis: "x", i: side === "left" ? 0 : nx, j, solidSide: sign === 1 ? -1 : 1,
          boundary: side,
          x: side === "left" ? 0 : nx * h, y: (j - 0.5) * h,
          tangential, tau: (mu * tangential) / (h / 2),
        });
      }
    }
    for (let i = 1; i <= nx; i++) {
      for (const [side, j, sign] of [["bottom", 1, 1], ["top", ny, -1]]) {
        const condition = wallAt(side, i);
        if (condition === null || solid[grid.idx(i, j)]) continue;
        const k = grid.idx(i, j);
        const wall = condition.u ?? 0;
        const tangential = (u[k] + u[grid.idx(i - 1, j)]) / 2 - wall;
        faces.push({
          axis: "y", i, j: side === "bottom" ? 0 : ny, solidSide: sign === 1 ? -1 : 1,
          boundary: side,
          x: (i - 0.5) * h, y: side === "bottom" ? 0 : ny * h,
          tangential, tau: (mu * tangential) / (h / 2),
        });
      }
    }
  }

  // Vertical surfaces: u faces with exactly one solid neighbour. The
  // tangential component there is v.
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i < nx; i++) {
      const a = solid[grid.idx(i, j)];
      const b = solid[grid.idx(i + 1, j)];
      if (a === b) continue;
      // The fluid cell is whichever side is not solid; its cell-centred v is
      // the mean of its own two horizontal faces.
      const fi = a ? i + 1 : i;
      const k = grid.idx(fi, j);
      const tangential = (v[k] + v[grid.idx(fi, j - 1)]) / 2;
      faces.push({
        axis: "x", i, j, solidSide: a ? -1 : 1,
        x: i * h, y: (j - 0.5) * h,
        tangential,
        tau: (mu * tangential) / (h / 2),
      });
    }
  }

  // Horizontal surfaces: v faces with one solid neighbour. Tangential is u.
  for (let j = 1; j < ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const a = solid[grid.idx(i, j)];
      const b = solid[grid.idx(i, j + 1)];
      if (a === b) continue;
      const fj = a ? j + 1 : j;
      const k = grid.idx(i, fj);
      const tangential = (u[k] + u[grid.idx(i - 1, fj)]) / 2;
      faces.push({
        axis: "y", i, j, solidSide: a ? -1 : 1,
        x: (i - 0.5) * h, y: j * h,
        tangential,
        tau: (mu * tangential) / (h / 2),
      });
    }
  }
  return faces;
}

// The largest shear stress on any surface, and where. Non-finite faces are
// counted rather than folded into the maximum - the same rule as everywhere
// else in physics/, because `a > max` is false for NaN.
export function wallShearSummary(faces) {
  let peak = 0;
  let peakAt = null;
  let counted = 0;
  let nonFinite = 0;
  for (const face of faces) {
    if (!Number.isFinite(face.tau)) { nonFinite++; continue; }
    counted++;
    if (Math.abs(face.tau) > Math.abs(peak)) { peak = face.tau; peakAt = face; }
  }
  return {
    faces: faces.length,
    counted,
    nonFinite,
    peak: counted > 0 ? peak : NaN,
    peakAt,
    // Said in the data, not only in a comment, so a caller cannot obtain the
    // per-face numbers and quietly add them up.
    integrable: false,
    integrationRefusedBecause:
      "summing over surface faces sums the staircase perimeter, which is 4/pi " +
      "times the true perimeter of a curved body at every resolution",
  };
}

// Separation: where the tangential flow along a wall reverses.
//
// tau = 0 with a sign change either side is the textbook separation criterion,
// and on a wall the tangential velocity half a cell out carries the same sign
// as tau, so the sign change is looked for in that.
//
// Walked along RUNS of consecutive, same-orientation, same-side faces. That is
// what "along the wall" means without needing to trace the surface as a curve:
// a horizontal surface is a run of faces at constant j over consecutive i, and
// a vertical one is a run at constant i over consecutive j. On a staircase the
// runs are short and this reports a point per step rather than per body, which
// is honest about the resolution rather than smoothing over it.
export function separationPoints(faces, grid) {
  const runs = new Map();
  for (const face of faces) {
    // Faces on opposite sides of a thin wall are different surfaces and must
    // not be walked as one.
    const key = `${face.axis}:${face.axis === "x" ? face.i : face.j}:${face.solidSide}`;
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key).push(face);
  }

  const points = [];
  for (const run of runs.values()) {
    run.sort((a, b) => (a.axis === "x" ? a.j - b.j : a.i - b.i));
    // A face sitting exactly at zero IS the separation point, so it is
    // reported at its own position rather than interpolated between neighbours.
    //
    // Skipping zeros - which the first version did, to keep the interpolation
    // safe - lost the separation entirely whenever the crossing landed on a
    // face: with taus of +0.1, 0, -0.1 the zero killed BOTH adjacent sign
    // tests and the reversal went unreported. The guard was protecting the
    // arithmetic from the one case the function exists to find.
    if (run.length > 0 && run[0].tau === 0) {
      points.push({ axis: run[0].axis, x: run[0].x, y: run[0].y, from: 0, to: 0, exact: true });
    }
    for (let n = 1; n < run.length; n++) {
      const prev = run[n - 1];
      const here = run[n];
      // Consecutive cells only: a gap in the run is a different stretch of
      // wall, not a reversal.
      const step = here.axis === "x" ? here.j - prev.j : here.i - prev.i;
      if (step !== 1) continue;
      if (!Number.isFinite(prev.tau) || !Number.isFinite(here.tau)) continue;
      if (here.tau === 0) {
        // Reported once, at the zero itself. The next pair starts from a zero
        // and is skipped below so it is not counted twice.
        if (prev.tau !== 0) {
          points.push({ axis: here.axis, x: here.x, y: here.y, from: prev.tau, to: 0, exact: true });
        }
        continue;
      }
      if (prev.tau === 0) continue;
      if ((prev.tau > 0) === (here.tau > 0)) continue;
      // Linear interpolation to the zero crossing, along the run's own axis.
      const t = Math.abs(prev.tau) / (Math.abs(prev.tau) + Math.abs(here.tau));
      points.push({
        axis: here.axis,
        x: prev.x + (here.x - prev.x) * t,
        y: prev.y + (here.y - prev.y) * t,
        from: prev.tau,
        to: here.tau,
        exact: false,
      });
    }
  }
  return points;
}

// The staircase perimeter of every solid surface, in physical units.
//
// Reported so the refusal above can be stated as a number in the panel rather
// than only as a rule. For an axis-aligned body this IS the true wall length;
// for a curved one it is 4/pi times it.
export function surfacePerimeter(grid, faces) {
  return faces.length * grid.h;
}
