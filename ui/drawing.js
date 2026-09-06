// The drawing layer: turning pointer gestures into geometry operations.
//
// Two rules shape this.
//
// The PREVIEW IS THE SAMPLED RESULT, not the drawn outline. While a shape is
// being dragged out, the cells highlighted are the cells that will actually
// become solid - the same testRegion call the sampler will make, on the same
// cell centres. Drawing a smooth outline and then sampling it produces a
// staircase that does not match what the user was shown, and the mismatch is
// worst exactly where it matters: a thin feature that looks drawn but samples
// to nothing.
//
// The GESTURE IS SEPARATE FROM THE DOCUMENT. A drag in progress is not an
// edit; nothing reaches the editor until the pointer is released, so a
// cancelled drag leaves no history and the undo stack contains only things the
// user finished doing.

import { TOOLS } from "../geometry/editor.js";
import { testRegion, validateRegion } from "../geometry/document.js";
import { clampToDomain, isInsideDomain, screenToPhysical } from "./canvasMapping.js";

export const DRAW_TOOLS = {
  select: { label: "Select", makes: null },
  rectangle: { label: "Rectangle", makes: (a, b) => TOOLS.rectangle(a.x, a.y, b.x, b.y) },
  circle: {
    label: "Circle",
    makes: (a, b) => TOOLS.circle(a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y)),
  },
  eraseRectangle: { label: "Erase rect", makes: (a, b) => TOOLS.eraseRectangle(a.x, a.y, b.x, b.y) },
  eraseCircle: {
    label: "Erase circle",
    makes: (a, b) => TOOLS.eraseCircle(a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y)),
  },
  // Two tools that do not produce geometry at all. They are listed here so the
  // palette has one source of truth for what is on it, and carry `makes: null`
  // so the drawing controller ignores them - the harness routes their pointer
  // events to ui/brush.js, which has the opposite lifecycle.
  brush: {
    label: "Brush",
    makes: null,
    kind: "momentum",
    hint: "drag on the fluid to push it",
  },
  placeSource: {
    label: "Place source",
    makes: null,
    kind: "place",
    hint: "click to place a source at that point",
  },
};

// Preview colours. Additions read as the solid they will become; erasures read
// as the fluid they will expose.
const ADD_TINT = [0xff, 0xc2, 0x6c, 0.55];
const ERASE_TINT = [0xff, 0x5c, 0x8a, 0.45];

export class DrawingController {
  constructor({ getLayout, onCommit }) {
    this.getLayout = getLayout;
    this.onCommit = onCommit;
    this.tool = "select";
    this.anchor = null;
    this.cursor = null;
  }

  get active() {
    return this.anchor !== null && DRAW_TOOLS[this.tool].makes !== null;
  }

  // The operation a release right now would commit, or null.
  //
  // The shape is VALIDATED here, not merely constructed. A tool builds a
  // region object without checking it - a click with no drag yields a rect
  // with zero width, which is a perfectly well-formed object and an invalid
  // shape - and the check does not otherwise happen until the editor commits.
  // Leaving it that late turns a stray click into an error message, so the
  // same validateRegion the document model will apply is applied here, and a
  // gesture that has not yet become a shape simply has no pending operation.
  get pending() {
    if (!this.active) return null;
    const make = DRAW_TOOLS[this.tool].makes;
    try {
      const operation = make(this.anchor, this.cursor);
      validateRegion(operation.region);
      return operation;
    } catch {
      return null;
    }
  }

  setTool(tool) {
    if (!DRAW_TOOLS[tool]) return false;
    this.tool = tool;
    this.anchor = null;
    this.cursor = null;
    return true;
  }

  down(clientX, clientY) {
    if (DRAW_TOOLS[this.tool].makes === null) return false;
    const layout = this.getLayout();
    const point = screenToPhysical(clientX, clientY, layout);
    // A press on the boundary bands is not a press on the fluid - but a press
    // aimed at the outermost row of cells is, even when it lands a hair
    // outside in floating point. Half a cell of tolerance, then clamped, so
    // the anchor is a point in the domain either way.
    if (!isInsideDomain(point, layout, layout.h / 2)) return false;
    this.anchor = clampToDomain(point, layout);
    this.cursor = this.anchor;
    return true;
  }

  move(clientX, clientY) {
    if (this.anchor === null) return false;
    const layout = this.getLayout();
    this.cursor = clampToDomain(screenToPhysical(clientX, clientY, layout), layout);
    return true;
  }

  up() {
    const operation = this.pending;
    this.anchor = null;
    this.cursor = null;
    if (operation === null) return false;
    this.onCommit(operation);
    return true;
  }

  cancel() {
    const had = this.anchor !== null;
    this.anchor = null;
    this.cursor = null;
    return had;
  }

  // A tint function for the renderer: the cells this gesture would change,
  // evaluated exactly as the sampler will evaluate them.
  tintFor(grid) {
    const operation = this.pending;
    if (operation === null) return null;
    const colour = operation.op === "add" ? ADD_TINT : ERASE_TINT;
    return (i, j) => {
      const { x, y } = grid.cellCentre(i, j);
      return testRegion(operation.region, x, y) ? colour : null;
    };
  }
}

// Distinct tints for connected fluid regions, so a viewer can see at a glance
// that a wall they drew has cut the domain in two. Derived from the same
// labelling the solver uses, not a second computation of connectivity.
const REGION_TINTS = [
  null, // the first region is left untinted: usually there is only one
  [0xc9, 0x8b, 0xdc, 0.3],
  [0x7f, 0xd1, 0x8b, 0.3],
  [0xe0, 0xc4, 0x6c, 0.3],
  [0xff, 0x5c, 0x8a, 0.3],
];

export function regionTint(grid, regions) {
  if (regions.count <= 1) return null;
  return (i, j) => {
    const id = regions.label[grid.idx(i, j)];
    if (id < 0) return null;
    return REGION_TINTS[id % REGION_TINTS.length];
  };
}

// A short human name for an operation, for the shape list. Composites are
// summarised rather than expanded: the scenario documents contain nested
// any/all/not trees that no one needs spelled out in a side panel, and the
// point of the list is to let someone find and remove a shape they drew.
export function describeOperation(operation) {
  const verb = operation.op === "add" ? "solid" : "erase";
  return `${verb} ${operation.label ?? describeRegion(operation.region)}`;
}

function describeRegion(region) {
  const n = (value) => Number(value).toFixed(2);
  // Composites are keyed by the presence of `all` / `any` / `not`, not by a
  // `kind` field - only primitives carry a kind. Reading them through `kind`
  // silently produced "solid undefined" for every scenario document, since
  // those are all unions of intersections.
  if (region.all) return `all of ${region.all.length}`;
  if (region.any) return `any of ${region.any.length}`;
  if (region.not) return `not ${describeRegion(region.not)}`;
  switch (region.kind) {
    case "rect":
      return `rect ${n(region.x0)},${n(region.y0)} - ${n(region.x1)},${n(region.y1)}`;
    case "disk":
      return `circle r=${n(region.radius)} at ${n(region.cx)},${n(region.cy)}`;
    case "polygon":
      return `polygon (${region.vertices.length} points)`;
    case "halfPlane":
      return `half-plane ${region.axis} ${region.comparison} ${n(region.at)}`;
    default:
      return region.kind;
  }
}
