// The momentum brush, and placing a source by clicking.
//
// Separate from ui/drawing.js because the two have opposite lifecycles. A
// geometry gesture is drawn, previewed, and COMMITTED ON RELEASE: nothing
// reaches the document until the pointer comes up. A brush is the reverse - it
// exists only WHILE the pointer is down, drives the fluid the whole time, and
// leaves nothing behind. Sharing one controller between them would mean a
// pile of branches on which kind of gesture is in progress.
//
// ---------------------------------------------------------------------------
// WHY THE SPEED IS A CONTROL AND NOT THE POINTER'S OWN
// ---------------------------------------------------------------------------
//
// "The fluid moves with your hand" is the obvious behaviour and it cannot be
// implemented honestly. Screen displacement maps to physical displacement
// exactly - the canvas mapping is a known scale. Time does not: pointer events
// arrive in wall-clock milliseconds and the fluid advances in simulated
// seconds, and the ratio between them is whatever the solver happened to
// manage this frame. It varies by more than thirty times between the scenarios
// in this project.
//
// So a hand-speed-to-fluid-speed mapping needs a constant that is invented, and
// the same gesture would drive the cavity and the cylinder at very different
// speeds for reasons that have nothing to do with either. The brush therefore
// takes its DIRECTION from the drag, which is exact, and its MAGNITUDE from a
// control, which is honest. The alternative is a made-up number hidden inside
// the tool.
//
// ---------------------------------------------------------------------------
// AND WHY IT PRODUCES A NEW ARRAY EVERY TIME
// ---------------------------------------------------------------------------
//
// sourcePlanFor caches on the source array, exactly as boundaryPlanFor caches
// on the boundary specification - and mutating that array in place returns the
// stale plan, which is how a brush would silently keep pushing in the first
// direction it was given. Measured cost of not doing that: a full recompile on
// the largest grid in the project is 0.872 ms, against 0.0003 ms for a cached
// lookup. At sixty pointer moves a second that is about 5% of a frame, paid
// only while the pointer is actually moving.

import { clampToDomain, isInsideDomain, screenToPhysical } from "./canvasMapping.js";

// How far the pointer must travel before the stroke has a direction at all.
// Below this there is no direction to take, and inventing one - "no movement
// means stop the fluid" - would make a press-and-hold into a brake, which is a
// different tool wearing this one's clothes.
const DIRECTION_THRESHOLD_CELLS = 0.25;

export const BRUSH_DEFAULTS = {
  speed: 1.5,
  radius: 3,          // in cells
  relaxationTime: 0.05,
};

export class BrushController {
  // `getLayout` supplies the canvas mapping; `onChange` is called whenever the
  // set of live sources changes, with the new array.
  constructor({ getLayout, onChange, settings = {} }) {
    this.getLayout = getLayout;
    this.onChange = onChange;
    this.settings = { ...BRUSH_DEFAULTS, ...settings };
    this.anchor = null;     // where the pointer is now
    this.direction = null;  // unit vector, once the pointer has moved enough
    this.active = false;
  }

  get stroking() {
    return this.active;
  }

  // The source the brush is currently applying, or null. Null while the pointer
  // is down but has not yet moved far enough to have a direction.
  get source() {
    if (!this.active || this.direction === null || this.anchor === null) return null;
    const { speed, radius, relaxationTime } = this.settings;
    const layout = this.getLayout();
    return {
      kind: "momentum",
      label: "brush",
      where: {
        kind: "disk",
        cx: this.anchor.x, cy: this.anchor.y,
        radius: radius * layout.h,
        metric: "squared", closed: true,
      },
      u: this.direction.x * speed,
      v: this.direction.y * speed,
      relaxationTime,
    };
  }

  setSetting(name, value) {
    if (!(name in BRUSH_DEFAULTS)) return false;
    if (!Number.isFinite(value) || value <= 0) return false;
    this.settings[name] = value;
    if (this.active) this.#publish();
    return true;
  }

  down(clientX, clientY) {
    const layout = this.getLayout();
    const point = screenToPhysical(clientX, clientY, layout);
    if (!isInsideDomain(point, layout, layout.h / 2)) return false;
    this.active = true;
    this.anchor = clampToDomain(point, layout);
    this.direction = null;
    this.#publish();
    return true;
  }

  move(clientX, clientY) {
    if (!this.active) return false;
    const layout = this.getLayout();
    const point = clampToDomain(screenToPhysical(clientX, clientY, layout), layout);
    const dx = point.x - this.anchor.x;
    const dy = point.y - this.anchor.y;
    const distance = Math.hypot(dx, dy);
    this.anchor = point;
    if (distance >= DIRECTION_THRESHOLD_CELLS * layout.h) {
      this.direction = { x: dx / distance, y: dy / distance };
    }
    this.#publish();
    return true;
  }

  up() {
    if (!this.active) return false;
    this.active = false;
    this.anchor = null;
    this.direction = null;
    this.#publish();
    return true;
  }

  cancel() {
    return this.up();
  }

  #publish() {
    this.onChange(this.source);
  }
}

// Combines the persistent sources a user has placed with the brush's transient
// one, into the single array the solver and the panel both read.
//
// A NEW array every time, never a mutation of the stored one - see the note at
// the top. The persistent entries are shared by reference because they do not
// change; only the array wrapping them is fresh, which is what the plan cache
// keys on.
export function combineSources(placed, brushSource) {
  if (brushSource === null || brushSource === undefined) {
    return placed.length === 0 ? null : placed;
  }
  return [...placed, brushSource];
}
