// Paints a prepared scalar view as a colour map.
//
// Consumes solver output; never mutates it. Nothing in this file writes to
// grid.u, grid.v, grid.p, grid.solid or the tracer.
//
// ---------------------------------------------------------------------------
// TWO WAYS TO DRAW THE SAME FIELD
// ---------------------------------------------------------------------------
//
// CELLS: one cell of the simulation becomes one flat block, exactly as
// computed. This was the only mode until the UI refresh, on the principle that
// the resolution the answer was computed at should be visible in the picture.
// That principle stands and the mode stays one checkbox away.
//
// SMOOTH (now the default, because a higher-quality fluid picture was asked
// for): each display pixel is a BILINEAR INTERPOLATION of the field values at
// the surrounding cell centres, then colour-mapped. Three rules keep it honest:
//
//   1. VALUES are interpolated, never colours. Blending two turbo colours
//      passes through hues that belong to neither endpoint's value - blue and
//      yellow average to a grey that means nothing on that scale.
//   2. Only FLUID cells contribute. A solid cell's slot holds a ghost or
//      nothing, and letting it into the stencil would paint a dark halo along
//      every wall that reads as a boundary layer the flow does not have.
//   3. SOLIDS STAY CRISP at cell resolution. The staircase is the domain the
//      solver is solving; drawing the smooth circle it approximates would show
//      a shape that is not being simulated - M5's "the preview is the sampled
//      result", applied to the picture itself.
//
// And the rule that predates all of this survives it: if any fluid cell in a
// pixel's stencil is non-finite, the pixel is painted the not-finite colour.
// A NaN therefore spreads to the pixels around it rather than being averaged
// away, which makes a broken cell MORE visible, not less.

import { LUT_SIZE, NON_FINITE_COLOUR, SOLID_COLOUR, lutFor } from "./colormap.js";

// How many pixels the smooth path renders itself, per frame. The rest of the
// way to the display size is the browser's plain bilinear upscale.
//
// Measured on the 64x64 cavity drawn at 14 display pixels a cell, with the
// canvas flushed after each render so deferred work is counted:
//
//   buffer              blit quality    ms per render
//   4 px/cell  (65k)    low                6.6
//   6 px/cell (147k)    low                9.6
//   8 px/cell (262k)    low               15.3
//   14 px/cell (803k)   none needed       36.4
//   4 px/cell           high              23.1
//   8 px/cell           high              32.1
//   flat cells          nearest            1.1
//
// So rendering every display pixel is the slow option, not the careful one -
// the loop costs about 45 ns a pixel - and "high" resampling costs 16 ms on its
// own for no visible gain on a field that is already smooth. A fixed budget of
// buffer pixels with a LOW-quality (bilinear) upscale keeps every scenario near
// 8 ms. The bilinear step blends COLOURS, which rule 1 above forbids between
// cells - but here it blends buffer pixels a quarter of a cell or less apart,
// whose colours are already nearly equal, so no hue appears that the data does
// not contain.
export const PIXEL_BUDGET = 120000;
const MIN_SUBSAMPLE = 2;

export function subsampleFor(nx, ny, scale, budget = PIXEL_BUDGET) {
  const fit = Math.floor(Math.sqrt(budget / (nx * ny)));
  return Math.max(1, Math.min(Math.max(MIN_SUBSAMPLE, fit), Math.round(scale), 16));
}

// ADAPTIVE RESOLUTION (M14). The budget above was measured on one machine. A
// slower one would spend it past the frame, and a fixed number cannot know
// that - so the renderer times each smooth frame and moves its own budget:
// halved when the average passes RENDER_TARGET_MS, doubled back (never past
// the measured default) when it is comfortably under. Only the display's
// resolution moves. The simulation's grid never does: a coarser grid is a
// different computation, not a cheaper picture of the same one.
export const RENDER_TARGET_MS = 12;
export const MIN_PIXEL_BUDGET = 15000;

export function adaptBudget(budget, averageMs) {
  if (averageMs > RENDER_TARGET_MS && budget > MIN_PIXEL_BUDGET) return Math.max(MIN_PIXEL_BUDGET, budget / 2);
  if (averageMs < RENDER_TARGET_MS / 3 && budget < PIXEL_BUDGET) return Math.min(PIXEL_BUDGET, budget * 2);
  return budget;
}

// The blend rule, and the only implementation of it: the four cell centres
// around a point, with weights from the fractional offsets (fx, fy), SOLID
// cells excluded and the weights renormalised over the fluid ones.
//
// Returns NaN if any contributing fluid value is non-finite, and null if no
// fluid cell contributes. `k00` is the flat index of the lower-left centre.
//
// Split out with its inputs precomputed because the renderer calls it for
// every pixel, and working out the four indices and weights from scratch each
// time was most of the cost: measured at 26 ms a frame for the cavity against
// 4 ms for flat cells. The column and row parts are the same for a whole
// column or row, so the renderer computes them once.
export function blendCells(values, solid, stride, k00, fx, fy) {
  let sum = 0;
  let weight = 0;
  let broken = false;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  if (w00 > 0 && !solid[k00]) {
    const v = values[k00];
    if (Number.isFinite(v)) { sum += w00 * v; weight += w00; } else broken = true;
  }
  if (w10 > 0 && !solid[k00 + 1]) {
    const v = values[k00 + 1];
    if (Number.isFinite(v)) { sum += w10 * v; weight += w10; } else broken = true;
  }
  if (w01 > 0 && !solid[k00 + stride]) {
    const v = values[k00 + stride];
    if (Number.isFinite(v)) { sum += w01 * v; weight += w01; } else broken = true;
  }
  if (w11 > 0 && !solid[k00 + stride + 1]) {
    const v = values[k00 + stride + 1];
    if (Number.isFinite(v)) { sum += w11 * v; weight += w11; } else broken = true;
  }
  if (broken) return NaN;
  if (weight === 0) return null;
  return sum / weight;
}

// Where a fractional cell-centre coordinate falls: the lower centre's 0-based
// index and the offset from it, clamped so the edge rows and columns use their
// own centre rather than reaching past the domain. Cell (i, j) - 1-based - has
// its centre at (i - 1, j - 1).
export function centreOffset(c, n) {
  if (n < 2) return { index: 0, frac: 0 };
  const clamped = c < 0 ? 0 : c > n - 1 ? n - 1 : c;
  const index = Math.min(n - 2, Math.floor(clamped));
  return { index, frac: clamped - index };
}

// Bilinear interpolation at fractional cell-centre coordinates (cx, cy) -
// the two helpers above composed, for callers that have a point rather than a
// precomputed column and row. Pure, so node tests the rules without a canvas.
export function interpolateCells(values, solid, stride, nx, ny, cx, cy) {
  const col = centreOffset(cx, nx);
  const row = centreOffset(cy, ny);
  return blendCells(values, solid, stride, (col.index + 1) + stride * (row.index + 1), col.frac, row.frac);
}

export class FieldRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.buffer = document.createElement("canvas");
    this.bufferContext = this.buffer.getContext("2d", { alpha: false });
    this.image = null;
    this.values = null;
    this.pixelBudget = PIXEL_BUDGET;
    this.renderAverage = null;
    this.renderFrames = 0;
    this.lastSubsample = 1;
  }

  // `view` comes from visualization/fieldSources.prepareView: it carries the
  // per-cell value, the scale, and the ramp. Passing it in rather than
  // computing a range here keeps a single scan as the one authority on the
  // field's range and its health - the renderer cannot quietly disagree with
  // the legend or the readouts about how bright the picture should be.
  // `inset` is the margin in display pixels around the field, where the
  // boundary-condition bands are drawn. The bands go beside the field rather
  // than over its outermost cells because those cells hold the boundary layer,
  // which is the part of the picture the boundary condition is most
  // responsible for - covering it to label it would be a poor trade.
  // `tint` optionally returns [r, g, b, alpha] for a cell, blended over
  // whatever the view painted there.
  render(grid, view, inset = 0, tint = null, { smooth = true, scale = 1 } = {}) {
    const started = performance.now();
    this.renderInner(grid, view, inset, tint, { smooth, scale });
    if (!smooth) return;
    // An average over a few frames, so one slow frame (a GC pause, a tab
    // switch) does not halve the picture.
    const ms = performance.now() - started;
    this.renderAverage = this.renderAverage === null ? ms : 0.8 * this.renderAverage + 0.2 * ms;
    this.renderFrames++;
    if (this.renderFrames >= 8) {
      this.pixelBudget = adaptBudget(this.pixelBudget, this.renderAverage);
      this.renderFrames = 0;
    }
  }

  renderInner(grid, view, inset, tint, { smooth, scale }) {
    const { nx, ny } = grid;
    const sub = smooth ? subsampleFor(nx, ny, scale, this.pixelBudget) : 1;
    this.lastSubsample = sub;
    const width = nx * sub;
    const height = ny * sub;

    if (this.buffer.width !== width || this.buffer.height !== height) {
      this.buffer.width = width;
      this.buffer.height = height;
      this.image = this.bufferContext.createImageData(width, height);
    }

    if (sub === 1) this.#paintCells(grid, view, tint);
    else this.#paintSmooth(grid, view, tint, sub);

    this.bufferContext.putImageData(this.image, 0, 0);

    const target = this.context;
    // Smoothing on for the smooth path only: its buffer is already an
    // interpolated field and any remaining upscale is invisible. The cells
    // path must stay nearest-neighbour or the blocks it exists to show blur.
    target.imageSmoothingEnabled = sub > 1;
    target.imageSmoothingQuality = "low";
    target.clearRect(0, 0, this.canvas.width, this.canvas.height);
    target.drawImage(
      this.buffer,
      inset,
      inset,
      this.canvas.width - 2 * inset,
      this.canvas.height - 2 * inset
    );
  }

  #blend(colour, over) {
    if (over === null || over === undefined) return colour;
    const a = over[3];
    return [
      Math.round(colour[0] * (1 - a) + over[0] * a),
      Math.round(colour[1] * (1 - a) + over[1] * a),
      Math.round(colour[2] * (1 - a) + over[2] * a),
    ];
  }

  // One flat block per cell - the mode that shows exactly what was computed.
  #paintCells(grid, view, tint) {
    const { nx, ny } = grid;
    const data = this.image.data;
    const blank = view === null;
    for (let j = 1; j <= ny; j++) {
      // Physical y runs up, canvas y runs down.
      const row = ny - j;
      for (let i = 1; i <= nx; i++) {
        const offset = (row * nx + (i - 1)) * 4;
        let colour;
        if (grid.solid[grid.idx(i, j)]) {
          colour = SOLID_COLOUR;
        } else if (blank) {
          // No view means the requested field does not exist for this state.
          // Painting it as not-finite is the honest answer: it is certainly
          // not a field of zeros.
          colour = NON_FINITE_COLOUR;
        } else {
          colour = view.ramp(view.normalise(view.valueAt(i, j)));
        }
        if (tint !== null) colour = this.#blend(colour, tint(i, j));
        data[offset] = colour[0];
        data[offset + 1] = colour[1];
        data[offset + 2] = colour[2];
        data[offset + 3] = 255;
      }
    }
  }

  #paintSmooth(grid, view, tint, sub) {
    const { nx, ny, stride, solid } = grid;
    const data = this.image.data;
    const width = nx * sub;
    const height = ny * sub;

    // Every fluid cell's NORMALISED value, computed once. The inner loop visits
    // sub^2 pixels per cell and reads four cells for each; evaluating valueAt
    // and normalise there cost a closure call per read.
    //
    // Interpolating the normalised value rather than the raw one differs only
    // for cells past a clipped scale, which are pinned to the end of the ramp
    // either way - and pinned first is what "drawn at the end of the ramp"
    // means. A non-finite value normalises to NaN and stays NaN.
    const size = (nx + 2) * (ny + 2);
    if (this.values === null || this.values.length !== size) this.values = new Float64Array(size);
    const values = this.values;
    if (view !== null) {
      for (let j = 1; j <= ny; j++) {
        for (let i = 1; i <= nx; i++) {
          const k = i + stride * j;
          values[k] = solid[k] ? NaN : view.normalise(view.valueAt(i, j));
        }
      }
    }
    const lut = view === null ? null : lutFor(view.ramp);
    const top = LUT_SIZE - 1;

    // A tint depends only on the cell, so it is evaluated ONCE PER CELL and
    // looked up per pixel. That is not only speed: the harness's tint callback
    // also COUNTS the cells a drawing preview would change, and the browser
    // check holds the mask to exactly that count. Calling it per pixel would
    // multiply the promise by sub^2.
    let tints = null;
    if (tint !== null) {
      tints = new Array(size).fill(null);
      for (let j = 1; j <= ny; j++) {
        for (let i = 1; i <= nx; i++) tints[i + stride * j] = tint(i, j) ?? null;
      }
    }

    // The column and row halves of every pixel's lookup, once each.
    const colCell = new Int32Array(width);
    const colBase = new Int32Array(width);
    const colFrac = new Float64Array(width);
    for (let px = 0; px < width; px++) {
      const X = (px + 0.5) / sub;
      colCell[px] = Math.min(nx, Math.floor(X) + 1);
      const { index, frac } = centreOffset(X - 0.5, nx);
      colBase[px] = index + 1;
      colFrac[px] = frac;
    }
    const [sr, sg, sb] = SOLID_COLOUR;
    const [nr, ng, nb] = NON_FINITE_COLOUR;

    for (let py = 0; py < height; py++) {
      const Y = ny - (py + 0.5) / sub;          // in cells, measured from the bottom
      const j = Math.min(ny, Math.floor(Y) + 1);
      const { index: rowIndex, frac: fy } = centreOffset(Y - 0.5, ny);
      const rowBase = stride * (rowIndex + 1);
      const cellRow = stride * j;
      let offset = py * width * 4;
      for (let px = 0; px < width; px++, offset += 4) {
        const cell = colCell[px] + cellRow;
        let r;
        let g;
        let b;
        if (solid[cell]) {
          r = sr; g = sg; b = sb;
        } else if (lut === null) {
          r = nr; g = ng; b = nb;
        } else {
          const t = blendCells(values, solid, stride, colBase[px] + rowBase, colFrac[px], fy);
          if (t === null || !Number.isFinite(t)) {
            r = nr; g = ng; b = nb;
          } else {
            const n = 3 * Math.round((t <= 0 ? 0 : t >= 1 ? 1 : t) * top);
            r = lut[n];
            g = lut[n + 1];
            b = lut[n + 2];
          }
        }
        if (tints !== null) {
          const over = tints[cell];
          if (over !== null) {
            const a = over[3];
            r = r * (1 - a) + over[0] * a;
            g = g * (1 - a) + over[1] * a;
            b = b * (1 - a) + over[2] * a;
          }
        }
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        data[offset + 3] = 255;
      }
    }
  }
}
