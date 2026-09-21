// Streamlines: curves everywhere tangent to the velocity field AS IT STANDS.
//
// Reads solver output. Never writes to it.
//
// A streamline is an instantaneous object. It answers "if the field froze now,
// where would this fluid go" - which is not the same question as "where has
// this fluid been", and in an unsteady flow the two curves differ. That second
// question is a PATHLINE and is computed elsewhere, because it needs state
// that evolves with the simulation rather than a snapshot of it. In a steady
// flow they coincide exactly, and that coincidence is a useful test rather
// than a reason to build only one.
//
// ---------------------------------------------------------------------------
// SEEDING, AND WHY A LATTICE IS NOT ENOUGH
// ---------------------------------------------------------------------------
//
// Seeding on a regular lattice and tracing every seed produces a picture where
// lines bundle together wherever the flow converges and leave bare patches
// wherever it diverges - so the visual density of lines reads as a property of
// the flow when it is an artefact of where the seeds happened to be.
//
// The fix in the literature is evenly-spaced placement (Jobard & Lefebvre,
// 1997): trace a line, then refuse to let any later line come within a chosen
// distance of it. What is implemented here is the cheap approximation of that
// - an OCCUPANCY GRID at the target spacing, where a line stops on entering a
// cell another line already holds, and a seed in an occupied cell is skipped.
// It is coarser than the real algorithm (the test is per-cell rather than a
// true distance) and it buys most of the benefit for a fraction of the work.
//
// Recorded as an approximation rather than presented as the method.

import { isFluidAt, traceStep } from "./velocityField.js";

// How close to its own start a line has to return before it is treated as
// closed. Measured in steps: a line in a vortex would otherwise circle until
// it ran out of budget, redrawing the same curve many times over.
const CLOSURE_STEPS = 8;

// Traces one streamline through a seed point, forward and backward.
//
// Bidirectional so the curve PASSES THROUGH the seed rather than starting at
// it. Tracing forward only makes the seed lattice visible as a row of line
// ends, which is the artefact the seeding is trying not to have.
export function traceStreamline(grid, seed, options = {}) {
  const { ds = grid.h / 2, maxSteps = 2000, occupancy = null, id = 0 } = options;
  if (!isFluidAt(grid, seed.x, seed.y)) return null;

  // Every cell this line takes, so a caller that decides not to keep the line
  // can give them back. See traceStreamlines.
  const claimed = [];
  // The SEED's own cell is claimed before either march.
  //
  // It was not, at first, and that left exactly one point per line outside the
  // separation rule - the seed is pushed into the polyline directly rather
  // than through march(). Where the backward march produced nothing, that
  // unclaimed point was the line's first, and it could sit in a cell another
  // line already held. Measured at 72 such points on the sharp bend and 606 on
  // the cylinder: small, invisible in the picture, and a rule with an
  // exception nobody had written down.
  if (occupancy !== null) {
    const seedCell = occupancy.claim(seed.x, seed.y, id);
    if (seedCell < 0) return { points: [], closed: false, claimed };
    claimed.push(seedCell);
  }
  const backward = march(grid, seed, -ds, maxSteps, occupancy, id, claimed);
  const forward = march(grid, seed, ds, maxSteps, occupancy, id, claimed);
  // Backward reversed, then the seed, then forward: one polyline in order.
  const points = [...backward.reverse(), { x: seed.x, y: seed.y, speed: seed.speed ?? 0 }, ...forward];
  if (points.length < 2) return { points: [], closed: false, claimed };
  return { points, closed: forward.closed === true, claimed };
}

function march(grid, seed, ds, maxSteps, occupancy, id, claimed) {
  const points = [];
  let x = seed.x;
  let y = seed.y;
  for (let n = 0; n < maxSteps; n++) {
    const next = traceStep(grid, x, y, ds);
    // No direction: a stagnation point or a broken cell. The line ends rather
    // than continuing in a direction nothing supplied.
    if (next === null) break;
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) break;
    // Leaving the fluid - the domain edge or a body - ends it. This is also
    // what bounds how far the reflected in-body face values can reach: at most
    // the half cell before this test fires.
    if (!isFluidAt(grid, next.x, next.y)) break;
    if (occupancy !== null) {
      const cell = occupancy.claim(next.x, next.y, id);
      if (cell < 0) break;
      if (claimed !== undefined) claimed.push(cell);
    }
    x = next.x;
    y = next.y;
    points.push({ x, y, speed: next.speed });
    // A closed streamline - the inside of a recirculation - would otherwise
    // redraw itself until the step budget ran out.
    if (n > CLOSURE_STEPS && Math.hypot(x - seed.x, y - seed.y) < Math.abs(ds)) {
      points.closed = true;
      break;
    }
  }
  return points;
}

// The occupancy grid described above. One integer per cell of a lattice at the
// target spacing: -1 for free, otherwise the id of the line holding it.
export class Occupancy {
  constructor(grid, spacing) {
    this.spacing = spacing;
    this.nx = Math.max(1, Math.ceil((grid.nx * grid.h) / spacing));
    this.ny = Math.max(1, Math.ceil((grid.ny * grid.h) / spacing));
    this.cells = new Int32Array(this.nx * this.ny).fill(-1);
  }

  index(x, y) {
    const i = Math.floor(x / this.spacing);
    const j = Math.floor(y / this.spacing);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1;
    return i + this.nx * j;
  }

  // Takes the cell for `id`, or reports that another line already has it. A
  // line may re-enter its OWN cells freely - refusing that would make every
  // line stop on its second step.
  // Takes the cell for `id` and returns its index, or -1 if another line
  // already holds it (or the point is outside). A line may re-enter its OWN
  // cells freely - refusing that would stop every line on its second step.
  claim(x, y, id) {
    const at = this.index(x, y);
    if (at < 0) return -1;
    const holder = this.cells[at];
    if (holder !== -1 && holder !== id) return -1;
    this.cells[at] = id;
    return at;
  }

  // Hands cells back. A line that is traced and then discarded must not go on
  // blocking seeds on behalf of a curve nobody can see.
  release(cells) {
    for (const at of cells) this.cells[at] = -1;
  }

  isFree(x, y) {
    const at = this.index(x, y);
    return at >= 0 && this.cells[at] === -1;
  }
}

// A field of streamlines. Seeds walk a lattice at the target spacing, offset
// to the cell centres, and any seed whose cell is already held is skipped.
//
// Seeds are visited in a fixed order rather than randomly, so the same field
// produces the same picture twice - a set of streamlines that reshuffles every
// frame is unreadable even when each individual line is correct.
export function traceStreamlines(grid, options = {}) {
  const {
    spacing = grid.h * 6,
    ds = grid.h / 2,
    maxSteps = 2000,
    maxLines = 400,
    minPoints = 4,
  } = options;

  // Two lengths, as in Jobard & Lefebvre: seeds are laid out at `spacing`, and
  // the distance at which one line stops for another is HALF that. With a
  // single length the first line traced claims a corridor the full seed pitch
  // wide, and almost nothing else fits - measured at 4 lines on the smooth
  // bend against 26 with the pair.
  const occupancy = new Occupancy(grid, spacing / 2);
  const seedsX = Math.max(1, Math.ceil((grid.nx * grid.h) / spacing));
  const seedsY = Math.max(1, Math.ceil((grid.ny * grid.h) / spacing));
  const lines = [];
  let id = 0;

  for (let j = 0; j < seedsY && lines.length < maxLines; j++) {
    for (let i = 0; i < seedsX && lines.length < maxLines; i++) {
      const x = (i + 0.5) * spacing;
      const y = (j + 0.5) * spacing;
      if (!occupancy.isFree(x, y)) continue;
      if (!isFluidAt(grid, x, y)) continue;
      // Ids are unique per ATTEMPT, not per accepted line. Reusing an id
      // after a rejection let a discarded line's claims be inherited by the
      // next one, so two different curves could hold the same cell - measured
      // at 72 such points on the sharp bend - and the cells of a line nobody
      // kept went on blocking seeds for lines that would have been drawn.
      const line = traceStreamline(grid, { x, y }, { ds, maxSteps, occupancy, id });
      id++;
      // A line of two or three points is a seed that went nowhere; drawing it
      // puts a speck on the picture that reads as debris rather than as flow.
      if (line !== null && line.points.length >= minPoints) {
        lines.push(line);
      } else if (line !== null) {
        occupancy.release(line.claimed);
      }
    }
  }
  return lines;
}
