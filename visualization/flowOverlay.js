// Arrows and curves drawn over the field.
//
// Split the same way visualization/timeseries.js is: the arithmetic that could
// be wrong - which cells get an arrow, how long it is, where a physical point
// lands on the canvas - is pure and exported, and the canvas half is a handful
// of moveTo and lineTo calls a browser check confirms actually paint.
//
// Everything here reads the grid and writes only to a 2D context.

import { velocityAtCell } from "../physics/velocityField.js";

// Arrows are spaced by DISPLAY PIXELS, not by cells.
//
// A fixed cell stride gives a different picture on every grid: at 128 x 36 a
// stride of 4 is an unreadable mat of overlapping arrows, and at 24 x 24 it is
// a scatter of six. What a reader wants is roughly constant spacing on screen,
// so the stride is derived from the zoom - and the number below is the target
// gap in pixels, chosen so an arrow and its neighbour do not touch at the
// maximum length used here.
const TARGET_ARROW_GAP_PX = 22;

// Arrow length as a fraction of the stride. The floor matters: an arrow scaled
// purely by magnitude vanishes wherever the flow is slow, which is exactly
// where a reader most needs to be told there IS flow and which way it goes. A
// cell at exactly zero still draws nothing at all, so "no arrow" keeps its
// meaning.
const MIN_ARROW = 0.18;
const MAX_ARROW = 0.92;

export function arrowStride(scale) {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(1, Math.round(TARGET_ARROW_GAP_PX / scale));
}

// Which cells get an arrow, and how long each one is.
//
// `reference` is the speed the longest arrow corresponds to - handed in rather
// than computed here so it matches whatever the colour scale is using, and the
// arrows cannot disagree with the picture underneath them about what "fast"
// means.
export function sampleVectors(grid, { stride = 4, reference = null, maxArrows = 2500 } = {}) {
  const arrows = [];
  let peak = 0;
  // A first pass only when no reference is supplied - normally the caller has
  // one from the view it just prepared. Scanned over EVERY fluid cell rather
  // than over the strided subset: a coarser sample misses the true peak, and
  // the arrow colours would then shift with the zoom level while the colour
  // map underneath them did not. Measured on the cylinder at stride 6 against
  // stride 3: 1.396 against 1.489, for the same field.
  if (reference === null) {
    for (let j = 1; j <= grid.ny; j++) {
      for (let i = 1; i <= grid.nx; i++) {
        if (grid.solid[grid.idx(i, j)]) continue;
        const { u, v } = velocityAtCell(grid, i, j);
        const speed = Math.hypot(u, v);
        if (Number.isFinite(speed) && speed > peak) peak = speed;
      }
    }
  }
  const top = reference !== null && reference > 0 ? reference : (peak > 0 ? peak : 1);

  // A cap on the total, widening the stride until it is met. The display scale
  // cannot currently produce a stride small enough to need this - it is
  // clamped to 9 pixels a cell, which puts the stride at 2 or more - but a
  // guard that depends on another module's clamp is not a guard.
  let step = Math.max(1, Math.round(stride));
  while (Math.ceil(grid.nx / step) * Math.ceil(grid.ny / step) > maxArrows) step++;

  // Offset so the sampled cells sit in the middle of each stride block rather
  // than hugging the bottom-left corner of the domain.
  const offset = Math.floor(step / 2);
  for (let j = 1 + offset; j <= grid.ny; j += step) {
    for (let i = 1 + offset; i <= grid.nx; i += step) {
      if (grid.solid[grid.idx(i, j)]) continue;
      const { u, v } = velocityAtCell(grid, i, j);
      const speed = Math.hypot(u, v);
      // A non-finite cell gets no arrow. Drawing one would need a direction,
      // and there is none - and a zero-length arrow would read as still fluid
      // rather than as broken fluid, which the colour map underneath is
      // already saying correctly.
      if (!Number.isFinite(speed) || speed === 0) continue;
      const { x, y } = grid.cellCentre(i, j);
      const fraction = Math.min(MAX_ARROW, Math.max(MIN_ARROW, speed / top));
      arrows.push({
        x, y,
        dx: u / speed, dy: v / speed,
        speed,
        // In cells, so the drawing layer multiplies by the same scale it uses
        // for everything else.
        length: fraction * step,
        t: Math.min(1, speed / top),
      });
    }
  }
  return { arrows, reference: top, stride: step };
}

// Physical point to canvas pixel. The same arithmetic as
// ui/canvasMapping.physicalToCanvas, which this cannot import: visualization/
// does not depend on ui/.
function toCanvas(x, y, { originX, originY, scale, h, ny }) {
  return { px: originX + (x / h) * scale, py: originY + (ny - y / h) * scale };
}

// Arrows are drawn in ONE high-contrast colour over a dark halo, not coloured
// by magnitude.
//
// Colouring them by speed through the velocity ramp is the obvious thing and
// it made them INVISIBLE: over the velocity view - the default, and the one
// they are most often wanted with - an arrow's colour is the ramp evaluated at
// very nearly the same speed as the cell it sits on, so it is painted in
// exactly the colour of its own background. Confirmed by looking at a
// screenshot in which 332 arrows had been drawn and none could be seen.
//
// The reference gallery does colour its arrows by magnitude, but its vector
// panel has no colour map underneath - it is a view, not an overlay. Different
// constraint, different answer. Here magnitude is carried by the LENGTH and by
// the picture underneath, and the arrow's job is direction; a fixed colour is
// what lets it do that over pressure, vorticity and dye as well.
const ARROW_COLOUR = "rgba(255,255,255,0.92)";
const ARROW_HALO = "rgba(0,0,0,0.55)";

export function drawVectors(context, sampled, placement, { width = 1.3 } = {}) {
  const { arrows } = sampled;
  if (arrows.length === 0) return 0;
  const { scale } = placement;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const arrow of arrows) {
    const { px, py } = toCanvas(arrow.x, arrow.y, placement);
    // Canvas y runs down, physical y runs up, so the y component flips. Getting
    // this wrong draws a field that is a mirror of the one being simulated and
    // looks entirely plausible.
    const lx = arrow.dx * arrow.length * scale;
    const ly = -arrow.dy * arrow.length * scale;
    const tipX = px + lx * 0.5;
    const tipY = py + ly * 0.5;
    const tailX = px - lx * 0.5;
    const tailY = py - ly * 0.5;

    // A head, scaled to the shaft but floored so the shortest arrows still
    // point somewhere.
    const head = Math.max(2.5, Math.min(5, arrow.length * scale * 0.34));
    const angle = Math.atan2(ly, lx);
    const path = () => {
      context.beginPath();
      context.moveTo(tailX, tailY);
      context.lineTo(tipX, tipY);
      context.moveTo(tipX - head * Math.cos(angle - 0.4), tipY - head * Math.sin(angle - 0.4));
      context.lineTo(tipX, tipY);
      context.lineTo(tipX - head * Math.cos(angle + 0.4), tipY - head * Math.sin(angle + 0.4));
      context.stroke();
    };
    // Halo first, then the arrow over it, so a white arrow stays readable
    // against the light end of a ramp as well as the dark one.
    context.strokeStyle = ARROW_HALO;
    context.lineWidth = width + 1.6;
    path();
    context.strokeStyle = ARROW_COLOUR;
    context.lineWidth = width;
    path();
  }
  context.restore();
  return arrows.length;
}

// Polylines in physical coordinates - streamlines or pathline trails.
//
// `colourAt` receives a point and returns [r,g,b], so a line can carry speed
// along its length. Drawn as a sequence of short segments when it does, and as
// one stroke when it does not: a single-colour line costs one path, and a
// per-segment one costs as many paths as it has points, which at several
// thousand points is the difference between free and visible.
export function drawPolylines(context, lines, placement, options = {}) {
  const {
    colourAt = null, colour = "rgba(255,255,255,0.7)", width = 1.1, fade = false,
  } = options;
  let drawn = 0;
  context.save();
  context.lineWidth = width;
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const line of lines) {
    const points = line.points ?? line;
    if (points.length < 2) continue;
    drawn++;
    if (colourAt === null && !fade) {
      context.strokeStyle = colour;
      context.beginPath();
      const first = toCanvas(points[0].x, points[0].y, placement);
      context.moveTo(first.px, first.py);
      for (let n = 1; n < points.length; n++) {
        const at = toCanvas(points[n].x, points[n].y, placement);
        context.lineTo(at.px, at.py);
      }
      context.stroke();
      continue;
    }
    for (let n = 1; n < points.length; n++) {
      const a = toCanvas(points[n - 1].x, points[n - 1].y, placement);
      const b = toCanvas(points[n].x, points[n].y, placement);
      // A trail fades towards its tail, so the direction of travel is visible
      // without drawing an arrowhead on every parcel.
      const alpha = fade ? n / points.length : 1;
      if (colourAt !== null) {
        const [r, g, bb] = colourAt(points[n]);
        context.strokeStyle = `rgba(${r},${g},${bb},${alpha})`;
      } else {
        context.strokeStyle = colour.replace(/[\d.]+\)$/, `${alpha})`);
      }
      context.beginPath();
      context.moveTo(a.px, a.py);
      context.lineTo(b.px, b.py);
      context.stroke();
    }
  }
  context.restore();
  return drawn;
}
