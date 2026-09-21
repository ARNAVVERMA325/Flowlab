// Probe markers on the field.
//
// Drawn after the field and the boundary bands, so a marker is never painted
// over by the picture it refers to.
//
// The marker is a ring, not a filled dot: a probe reports the cell under it,
// and covering that cell with an opaque blob hides the one thing the reader is
// being asked to look at. Every stroke is drawn twice, dark then coloured, so
// the marker stays visible against both ends of the ramp and against the
// solid colour - the field underneath is arbitrary and a single-colour marker
// disappears into some part of it.

const RADIUS = 5;
const HALO = "rgba(0, 0, 0, 0.75)";

// `origin` and `scale` place the field inside the canvas exactly as the
// renderer did; `h` and `ny` turn a physical point into cell coordinates. The
// same arithmetic as ui/canvasMapping.js's physicalToCanvas, which this cannot
// import: visualization/ does not depend on ui/.
function toCanvas(x, y, { originX, originY, scale, h, ny }) {
  return { px: originX + (x / h) * scale, py: originY + (ny - y / h) * scale };
}

export function drawProbeMarkers(context, probes, placement) {
  if (probes.length === 0) return 0;
  context.save();
  context.lineWidth = 3;
  context.font = "10px ui-monospace, monospace";
  context.textBaseline = "middle";

  for (const probe of probes) {
    const { px, py } = toCanvas(probe.x, probe.y, placement);

    context.beginPath();
    context.arc(px, py, RADIUS, 0, Math.PI * 2);
    context.strokeStyle = HALO;
    context.lineWidth = 3.5;
    context.stroke();
    context.strokeStyle = probe.colour;
    context.lineWidth = 1.5;
    context.stroke();

    // A cross through the centre, so the exact point is identifiable even when
    // the ring is small.
    context.beginPath();
    context.moveTo(px - RADIUS - 2, py);
    context.lineTo(px + RADIUS + 2, py);
    context.moveTo(px, py - RADIUS - 2);
    context.lineTo(px, py + RADIUS + 2);
    context.strokeStyle = HALO;
    context.lineWidth = 3;
    context.stroke();
    context.strokeStyle = probe.colour;
    context.lineWidth = 1;
    context.stroke();

    context.strokeStyle = HALO;
    context.lineWidth = 3;
    context.strokeText(probe.label, px + RADIUS + 4, py - RADIUS);
    context.fillStyle = probe.colour;
    context.fillText(probe.label, px + RADIUS + 4, py - RADIUS);
  }

  context.restore();
  return probes.length;
}
