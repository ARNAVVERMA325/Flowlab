// The outline of every solid surface, drawn over the field.
//
// The reference draws each wall as a thin light line, and it does a job a fill
// colour cannot: it separates solid from fluid at every surface regardless of
// how close the adjacent fluid's colour happens to be to the solid's, which no
// single fill can promise against every ramp at once.
//
// Drawn along the faces the solver actually treats as surface - one face per
// cell edge between a solid cell and a fluid one - so a curved body is outlined
// as the STAIRCASE it is being simulated as. Tracing the smooth shape it came
// from would show a boundary the solver is not using.

function toCanvas(x, y, { originX, originY, scale, h, ny }) {
  return { px: originX + (x / h) * scale, py: originY + (ny - y / h) * scale };
}

export function drawSurfaceOutline(context, grid, placement, {
  colour = "rgba(226, 232, 240, 0.85)", width = 1.4,
} = {}) {
  const { nx, ny, h, solid } = grid;
  let faces = 0;
  context.save();
  context.beginPath();
  // Vertical faces between horizontally adjacent cells.
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i < nx; i++) {
      if (solid[grid.idx(i, j)] === solid[grid.idx(i + 1, j)]) continue;
      const a = toCanvas(i * h, (j - 1) * h, placement);
      const b = toCanvas(i * h, j * h, placement);
      context.moveTo(a.px, a.py);
      context.lineTo(b.px, b.py);
      faces++;
    }
  }
  // Horizontal faces between vertically adjacent cells.
  for (let j = 1; j < ny; j++) {
    for (let i = 1; i <= nx; i++) {
      if (solid[grid.idx(i, j)] === solid[grid.idx(i, j + 1)]) continue;
      const a = toCanvas((i - 1) * h, j * h, placement);
      const b = toCanvas(i * h, j * h, placement);
      context.moveTo(a.px, a.py);
      context.lineTo(b.px, b.py);
      faces++;
    }
  }
  context.strokeStyle = colour;
  context.lineWidth = width;
  context.lineCap = "square";
  context.stroke();
  context.restore();
  return faces;
}
