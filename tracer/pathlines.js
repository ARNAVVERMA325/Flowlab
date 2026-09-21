// Pathlines: where individual parcels of fluid have actually been.
//
// Reads the velocity field. Never writes to it - the same seal the dye tracer
// is held to, and for the same reason: this is a display aid, and anything it
// fed back into the flow would be a picture changing the thing it depicts.
// Lives in tracer/ because that is where advected display aids live and
// because tests/test9 asserts the solver tree contains no reference to any of
// them.
//
// ---------------------------------------------------------------------------
// NOT THE SAME CURVE AS A STREAMLINE
// ---------------------------------------------------------------------------
//
// A streamline is tangent to the field at ONE INSTANT: freeze the flow, follow
// the arrows. A pathline is the trajectory of one parcel THROUGH TIME: it is
// integrated as the field changes underneath it, so it remembers a field that
// no longer exists.
//
// In a steady flow the two coincide exactly, and that is worth testing rather
// than assuming. In an unsteady one they can look nothing alike, which is the
// whole reason the roadmap asks for both.
//
// So a pathline cannot be computed from a snapshot. It is STATE - it has to be
// advanced by the session on every step, with the timestep the solver actually
// took - and like every other piece of state that depends on the flow's
// history, it is discarded when the field is rebuilt rather than carried
// across a join into a different simulation.
//
// ---------------------------------------------------------------------------
// STEPPED IN TIME, NOT IN ARC LENGTH
// ---------------------------------------------------------------------------
//
// physics/streamlines.js steps by distance, so points along a streamline are
// evenly spaced no matter how fast the fluid moves there. A pathline must do
// the opposite: its spacing IS the speed. A parcel that has barely moved
// leaves a short trail, and that shortness is the measurement.

import { isFluidAt, velocityAt } from "../physics/velocityField.js";

export const PATHLINE_DEFAULTS = {
  count: 300,
  // How many past positions each parcel remembers. At four steps a frame this
  // is about a third of a second of wall clock - long enough to read as a
  // streak, short enough that the picture is of the flow now rather than of
  // everything that ever happened.
  trail: 24,
};

// A small deterministic generator, so the same scenario seeds the same
// particles twice. A picture that reshuffles on every reset cannot be compared
// against itself, and a test cannot assert anything exact about one.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PathlineSet {
  constructor(grid, { count = PATHLINE_DEFAULTS.count, trail = PATHLINE_DEFAULTS.trail,
    seed = 0x5eed } = {}) {
    this.trail = trail;
    this.random = mulberry32(seed);
    this.particles = [];
    // A domain with no fluid at all - everything drawn over - gets no
    // particles rather than an infinite search for somewhere to put one.
    const spawnable = this.#fluidCells(grid);
    if (spawnable.length === 0) return;
    for (let n = 0; n < count; n++) {
      this.particles.push(this.#spawn(grid, spawnable));
    }
    this.spawnable = spawnable;
  }

  #fluidCells(grid) {
    const cells = [];
    for (let j = 1; j <= grid.ny; j++) {
      for (let i = 1; i <= grid.nx; i++) {
        if (grid.solid[grid.idx(i, j)] === 0) cells.push([i, j]);
      }
    }
    return cells;
  }

  // Uniformly over the fluid, not at the inlet.
  //
  // Releasing everything from an inlet is the more literal reading of
  // "particles released from inlet", and it produces a domain that is empty
  // everywhere the flow has not reached yet and crowded at the entrance. A
  // uniform respawn keeps the density of the picture even, which means the
  // density carries no false information about the flow.
  #spawn(grid, spawnable) {
    const [i, j] = spawnable[Math.floor(this.random() * spawnable.length)];
    const x = (i - 1 + this.random()) * grid.h;
    const y = (j - 1 + this.random()) * grid.h;
    return { x, y, trail: [{ x, y, speed: 0 }], age: 0 };
  }

  get count() { return this.particles.length; }

  // One step of every parcel, by the timestep the solver actually took.
  //
  // Midpoint (RK2), matching the streamline tracer: Euler through a vortex
  // spirals outward at a rate proportional to dt, which would draw a
  // recirculation that is decaying when the simulation's is not.
  advance(grid, dt) {
    if (!Number.isFinite(dt) || dt <= 0) return 0;
    let respawned = 0;
    for (const particle of this.particles) {
      const first = velocityAt(grid, particle.x, particle.y);
      const midX = particle.x + first.u * dt * 0.5;
      const midY = particle.y + first.v * dt * 0.5;
      const second = velocityAt(grid, midX, midY);
      const x = particle.x + second.u * dt;
      const y = particle.y + second.v * dt;

      // A parcel that has left the fluid - through an outlet, or into a body
      // that was drawn around it - is replaced rather than clamped to the
      // edge. Clamping would pile parcels against every wall and outlet and
      // read as fluid accumulating there.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !isFluidAt(grid, x, y)) {
        Object.assign(particle, this.#spawn(grid, this.spawnable));
        respawned++;
        continue;
      }

      particle.x = x;
      particle.y = y;
      particle.age++;
      particle.trail.push({ x, y, speed: Math.hypot(first.u, first.v) });
      if (particle.trail.length > this.trail) particle.trail.shift();
    }
    return respawned;
  }
}
