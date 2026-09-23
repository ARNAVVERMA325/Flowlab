// Solver harness: Run / Pause / Reset, a scalar colour map, and the raw
// numbers behind it.
//
// This layer drives the solver and reads its output. It never reaches into the
// numerics: the only solver entry point used is step(), and the only fields
// read are grid.u/v/p/solid.
//
// The panel's job is to let someone watch the validated solver and trust what
// they are seeing, which means it has to be incapable of showing a healthy
// number for a broken field. Two rules enforce that:
//
//   1. Every frame calls inspectField(), which classifies each fluid cell with
//      Number.isFinite rather than reducing with a bare comparison.
//   2. If the field is not finite the run halts immediately, the panel switches
//      to a failure state, and the affected quantities are shown as NaN. The
//      simulation cannot be restarted except through Reset, so a stale frame
//      can never be mistaken for a live one.
//
// M3 adds two more views and a dye tracer. The rule they are held to:
// switching what is displayed is a PURE DISPLAY CHANGE. setMode() sets a
// string and redraws - it does not step, reset, rebuild the scenario or touch
// a field. The dye is advected by the flow and feeds nothing back into it;
// see tracer/passiveScalar.js for how that separation is enforced and
// tests/test9_m3_visualization.js for the assertion that it holds.
//
// M5 adds drawing, which is NOT a display change: it replaces the domain. The
// harness owns none of the rules for that - the session does, and it stops the
// run and rebuilds the field. What the harness owns is everything downstream
// of the mask, which is re-derived through syncScenario() on every edit. The
// boundary plan above all: surface conditions attach to solid faces, and after
// an edit those faces are somewhere else.

import {
  computeContinuityError, boundaryPlanFor, pressureIsGauge,
  SolverDivergenceError, SolverGeometryError,
} from "../solver/ns2d.js";
import { sourcePlanFor } from "../sources/compile.js";
import { SolverStabilityError } from "../solver/stability.js";
import { inspectField } from "../physics/fieldStats.js";
import { FieldRenderer } from "../visualization/fieldRenderer.js";
import {
  DEFAULT_MAGNITUDE_RAMP, MAGNITUDE_RAMPS, samplerCss,
  sampleDiverging as sampleDivergingRamp, sampleDye as sampleDyeRamp,
} from "../visualization/colormap.js";
import { drawSurfaceOutline } from "../visualization/surfaceOutline.js";
import {
  drawBoundaryOverlay, boundaryLegend, measureBoundaryFlux,
} from "../visualization/boundaryOverlay.js";
import { analyseRegions, describeRegions } from "../boundaries/regionAnalysis.js";
import { fluidRegions } from "../geometry/regions.js";
import { BOUNDARY_TYPES, SIDES } from "../boundaries/conditions.js";
import { fieldsFor } from "../boundaries/editor.js";
import { DRAW_TOOLS, DrawingController, describeOperation, regionTint } from "./drawing.js";
import { clampToDomain, isInsideDomain, screenToPhysical } from "./canvasMapping.js";
import { BRUSH_DEFAULTS, BrushController } from "./brush.js";
import { PROBE_QUANTITIES } from "./probes.js";
import { probeAt } from "../physics/probe.js";
import { drawProbeMarkers } from "../visualization/probeOverlay.js";
import {
  arrowStride, drawPolylines, drawVectors, sampleVectors,
} from "../visualization/flowOverlay.js";
import { traceStreamlines } from "../physics/streamlines.js";
import { analyseFlow, pressureDropBetween } from "../physics/flowAnalysis.js";
import { drawSeries, seriesRange } from "../visualization/timeseries.js";
import { describeSource } from "../sources/kinds.js";
import {
  prepareView,
  FIELD_SOURCES,
  DEFAULT_FIELD_SOURCE,
} from "../visualization/fieldSources.js";
import { SCENARIOS, DEFAULT_SCENARIO } from "../scenarios/index.js";
import { SimulationSession, StaleFieldError } from "./session.js";
import {
  assessField, classifyRunFailure, isUnprojectedInitialCondition,
} from "./fieldHealth.js";
import { ValidationPanel } from "./validationPanel.js";
import { compact, exponential, fixed, integer, isBad } from "./format.js";

// Where a sample was taken, and what it says. Split so the probe list can put
// them on separate lines while the hover readout keeps them on one.
function describePosition(sample) {
  if (!sample.inside) return "outside the domain";
  return `(${fixed(sample.x, 2)}, ${fixed(sample.y, 2)}) cell ${sample.i},${sample.j}`;
}

function describeValues(sample) {
  if (!sample.inside) return "-";
  // In words rather than as six NaNs. The numbers ARE NaN and format.js would
  // faithfully print them, but NaN reads as a broken simulation and this is the
  // ordinary, correct answer for a point inside a wall.
  if (sample.solid) return "solid - no fluid here";
  return (
    `u ${exponential(sample.u, 2)}  v ${exponential(sample.v, 2)}  ` +
    `|u| ${exponential(sample.speed, 2)}  p ${exponential(sample.pressure, 2)}  ` +
    `\u03c9 ${exponential(sample.vorticity, 2)}  cell Re ${fixed(sample.cellRe, 2)}`
  );
}

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// The intrinsic canvas width the scale is fitted to, and the largest number of
// canvas pixels a cell may take. 960 matches the centre column of the layout
// at common widths; 14 keeps the 64x64 cavity to a square under 900 pixels.
const TARGET_WIDTH = 960;
const MAX_SCALE = 14;

// Short names for the mode tiles. The views' own labels are written for the
// legend, where there is room to say what they are.
const TILE_LABELS = {
  velocity: "Velocity",
  pressure: "Pressure",
  vorticity: "Vorticity",
  shear: "Shear rate",
  q: "Rotation (\u221aQ)",
  continuity: "Continuity",
  dye: "Dye",
};

// Which ramp a view is drawn in, without preparing it. Used for the tile
// swatches; the renderer takes its ramp from the prepared view itself.
function rampForView(id, palette) {
  const source = FIELD_SOURCES.find((entry) => entry.id === id);
  if (source === undefined) return MAGNITUDE_RAMPS[DEFAULT_MAGNITUDE_RAMP].sample;
  if (id === "velocity") return (MAGNITUDE_RAMPS[palette] ?? MAGNITUDE_RAMPS[DEFAULT_MAGNITUDE_RAMP]).sample;
  if (id === "dye") return sampleDyeRamp;
  return sampleDivergingRamp;
}

// Tool icons, as SVG path markup. Static strings owned by this file.
const TOOL_ICONS = {
  select: '<path d="M3 2l9 5-4 1-1 4z"/>',
  rectangle: '<rect x="2.5" y="4" width="11" height="8" rx="1"/>',
  circle: '<circle cx="8" cy="8" r="5.5"/>',
  eraseRectangle: '<rect x="2.5" y="4" width="11" height="8" rx="1" stroke-dasharray="2 2"/><path d="M5 6l6 4M11 6l-6 4"/>',
  eraseCircle: '<circle cx="8" cy="8" r="5.5" stroke-dasharray="2 2"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
  brush: '<path d="M2 12c3 0 3-3 6-3s3 3 6 3"/><path d="M10 4l3 3"/>',
  placeSource: '<circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2"/>',
  probe: '<circle cx="7" cy="7" r="4"/><path d="M10 10l4 4"/>',
};

const STEPS_PER_FRAME = 4;
const FRAME_BUDGET_MS = 24;

// Width of the boundary-condition bands, and the margin they live in. The
// bands sit BESIDE the field, not over its edge: the outermost cells carry the
// boundary layer, which is the part of the picture the boundary condition is
// most responsible for, and covering it to label it would be a poor trade.
const BAND = 7;
const MARGIN = BAND + 2;

// The error types a run can fail with, handed to classifyRunFailure so that the
// classification itself stays free of solver imports and can be tested without
// one. Adding a new solver error type means adding it here and nowhere else.
const RUN_FAILURE_KINDS = {
  stability: SolverStabilityError,
  divergence: SolverDivergenceError,
  geometry: SolverGeometryError,
  staleField: StaleFieldError,
};

export class Harness {
  constructor(root) {
    this.root = root;
    this.scenarioId = DEFAULT_SCENARIO;
    this.mode = DEFAULT_FIELD_SOURCE;
    this.renderer = new FieldRenderer(root.querySelector("#field"));
    this.state = "paused"; // paused | running | failed
    this.session = null;
    this.failure = null;
    this.failureKind = null;
    this.frame = null;
    // What the pointer is currently drawing, and what the last completed edit
    // had to say. Both are display state only; the document lives in the
    // session's editor.
    this.previewSummary = null;
    this.editMessage = null;
    this.showRegions = true;
    // Overlays are independent of the colour map, not alternatives to it: the
    // reference gallery shows streamlines drawn over a velocity-magnitude
    // field, and making them mutually exclusive would forbid the most useful
    // combination for no reason. Each is a pure display toggle, exactly as
    // #showregions already is.
    this.overlays = { vectors: false, streamlines: false, pathlines: false };
    this.overlayCounts = null;
    // Display quality. Smooth rendering is the default because a
    // higher-quality fluid picture was asked for; the computed cells are one
    // checkbox away, because seeing the resolution the answer was computed at
    // is still worth something. See visualization/fieldRenderer.js.
    this.smooth = true;
    this.palette = DEFAULT_MAGNITUDE_RAMP;
    // Frames and steps per second, for the status bar.
    this.perf = { frames: 0, steps: 0, since: performance.now(), fps: null, sps: null };
    // Probe display state. The probes themselves live in the session, which is
    // what samples them; these three are only about what is being looked at.
    this.hoverPoint = null;
    this.probeSelection = null;
    this.probeQuantity = "speed";
    this.drawing = new DrawingController({
      getLayout: () => this.layout(),
      onCommit: (operation) => this.commitEdit(() => this.session.applyEdit(operation)),
    });
    // The brush is a separate controller because its lifecycle is the opposite:
    // a geometry gesture commits on release, a brush exists only while the
    // pointer is down. It never touches the geometry document.
    this.brush = new BrushController({
      getLayout: () => this.layout(),
      onChange: (source) => {
        if (this.session.setBrushSource(source)) this.draw();
      },
    });

    this.validation = new ValidationPanel(root);
    this.bindControls();
    this.load(this.scenarioId);
    // The validation record is fetched asynchronously; re-render once it lands
    // so the panel stops saying "loading" and starts showing measurements.
    this.validation.load().then(() => this.renderValidation());
  }

  // Read-through to the session, which owns this state. The harness keeps no
  // copy of it.
  get scenario() { return this.session.scenario; }
  get tracer() { return this.session.tracer; }
  get iteration() { return this.session.iteration; }
  get simulatedTime() { return this.session.simulatedTime; }
  get lastStep() { return this.session.lastStep; }
  get lastSelection() { return this.session.lastSelection; }
  get lastTracer() { return this.session.lastTracer; }

  bindControls() {
    const { root } = this;
    root.querySelector("#run").addEventListener("click", () => this.run());
    root.querySelector("#pause").addEventListener("click", () => this.pause());
    root.querySelector("#reset").addEventListener("click", () => this.load(this.scenarioId));
    root.querySelector("#reseed").addEventListener("click", () => this.seedTracer());
    root.querySelector("#cleardye").addEventListener("click", () => this.clearTracer());

    const select = root.querySelector("#scenario");
    for (const entry of SCENARIOS) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.label;
      select.appendChild(option);
    }
    select.value = this.scenarioId;
    select.addEventListener("change", () => {
      this.scenarioId = select.value;
      this.load(this.scenarioId);
    });

    // Tiles rather than a dropdown, after the reference. Built from the table
    // of field sources, so a view added to visualization/fieldSources.js
    // appears here without anyone editing the markup - and each tile's swatch
    // is painted from that view's own ramp, so the tile shows the colours the
    // field will be drawn in rather than an icon that could drift from them.
    const mode = root.querySelector("#mode");
    for (const source of FIELD_SOURCES) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "modetile";
      tile.dataset.mode = source.id;
      tile.setAttribute("role", "radio");
      tile.title = source.label;
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.dataset.swatchFor = source.id;
      const label = document.createElement("span");
      label.textContent = TILE_LABELS[source.id] ?? source.label;
      tile.append(swatch, label);
      tile.addEventListener("click", () => this.setMode(source.id));
      mode.appendChild(tile);
    }
    this.syncModeTiles();

    const colormap = root.querySelector("#colormap");
    colormap.value = this.palette;
    colormap.addEventListener("change", () => {
      if (!(colormap.value in MAGNITUDE_RAMPS)) return;
      this.palette = colormap.value;
      this.syncModeTiles();
      this.draw();
    });
    const cells = root.querySelector("#showcells");
    cells.checked = !this.smooth;
    cells.addEventListener("change", () => {
      this.smooth = !cells.checked;
      root.querySelector("#field").classList.toggle("cells", !this.smooth);
      this.draw();
    });

    this.bindDrawingControls();
    this.bindBoundaryControls();
  }

  // The boundary editor. Unlike a geometry edit this does NOT stop the run or
  // rebuild the field - see ui/session.js for the measurements that settled
  // that. Opening a valve on a running flow is a thing the solver can march
  // through, and watching it happen is the point.
  bindBoundaryControls() {
    const { root } = this;

    const sideSelect = root.querySelector("#bcside");
    for (const side of SIDES) {
      const option = document.createElement("option");
      option.value = side;
      option.textContent = side;
      sideSelect.appendChild(option);
    }

    const typeSelect = root.querySelector("#bctype");
    for (const [id, spec] of Object.entries(BOUNDARY_TYPES)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = spec.label;
      typeSelect.appendChild(option);
    }

    // Changing either selector re-derives the form from the type table, so a
    // new type or a new parameter shows up without anyone editing this file.
    sideSelect.addEventListener("change", () => this.syncBoundaryForm());
    typeSelect.addEventListener("change", () => this.renderBoundaryFields());

    root.querySelector("#bcapply").addEventListener("click", () => this.applyBoundaryEdit());
    root.querySelector("#bcundo").addEventListener("click", () =>
      this.commitBoundary(() => this.session.undoBoundary()));
    root.querySelector("#bcredo").addEventListener("click", () =>
      this.commitBoundary(() => this.session.redoBoundary()));
  }

  // Fills the form from whatever the chosen side currently carries, so the
  // starting point is what is applied rather than a blank.
  syncBoundaryForm() {
    const side = this.root.querySelector("#bcside").value;
    const current = this.session.bc[side];
    // A segmented side has no single type; the editor replaces whole sides, so
    // it offers the first segment's type as a starting point and says so.
    const condition = Array.isArray(current) ? current[0] : current;
    this.root.querySelector("#bctype").value = condition.type;
    this.renderBoundaryFields(condition, Array.isArray(current));
  }

  renderBoundaryFields(condition = null, segmented = false) {
    const side = this.root.querySelector("#bcside").value;
    const type = this.root.querySelector("#bctype").value;
    const spec = fieldsFor(type, side);
    const host = this.root.querySelector("#bcfields");
    host.innerHTML = "";

    for (const field of [...spec.required, ...spec.optional]) {
      const required = spec.required.includes(field);
      const label = document.createElement("label");
      label.className = required ? "req" : "";
      label.textContent = field + (required ? "*" : "");
      const input = document.createElement("input");
      input.dataset.field = field;
      input.dataset.required = String(required);
      // `profile` is the one non-numeric parameter; everything else is a number.
      input.type = field === "profile" ? "text" : "number";
      input.step = "any";
      const existing = condition?.[field];
      input.value = existing === undefined ? "" : String(existing);
      input.placeholder = required ? "required" : "default";
      label.appendChild(input);
      host.appendChild(label);
    }

    const hint = this.root.querySelector("#bcedithint");
    hint.classList.remove("bad");
    hint.textContent = segmented
      ? `${side} is segmented; applying replaces the whole side. ${spec.summary}`
      : spec.summary;
  }

  applyBoundaryEdit() {
    const side = this.root.querySelector("#bcside").value;
    const type = this.root.querySelector("#bctype").value;
    const condition = { type };
    for (const input of this.root.querySelectorAll("#bcfields input")) {
      const raw = input.value.trim();
      if (raw === "") {
        if (input.dataset.required === "true") {
          this.showBoundaryError(`${input.dataset.field} is required for this type`);
          return;
        }
        continue;
      }
      condition[input.dataset.field] = input.type === "number" ? Number(raw) : raw;
    }
    this.commitBoundary(() => this.session.setBoundary(side, condition));
  }

  showBoundaryError(message) {
    const hint = this.root.querySelector("#bcedithint");
    hint.textContent = message;
    hint.classList.add("bad");
  }

  // A boundary edit re-derives the plan and redraws, and deliberately does not
  // touch this.state: a run in progress keeps running through the change.
  commitBoundary(apply) {
    try {
      if (!apply()) return false;
    } catch (error) {
      // The editor validates by compiling, so an impossible specification is
      // refused with the compiler's own message and the history is untouched.
      this.showBoundaryError(error.message);
      return false;
    }
    this.plan = boundaryPlanFor(this.scenario.grid, this.session.bc);
    this.syncBoundaryForm();
    this.draw();
    return true;
  }

  bindDrawingControls() {
    const { root } = this;
    const tools = root.querySelector("#tools");
    for (const [id, tool] of Object.entries(DRAW_TOOLS)) {
      const button = document.createElement("button");
      button.className = "tool";
      button.dataset.tool = id;
      button.title = tool.hint ?? tool.label;
      // An icon beside the label, as in the reference's tool list. Built as
      // markup the harness owns - none of it comes from outside the app.
      button.innerHTML =
        `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" ` +
        `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
        `${TOOL_ICONS[id] ?? TOOL_ICONS.select}</svg>`;
      button.append(tool.label);
      button.addEventListener("click", () => this.setTool(id));
      tools.appendChild(button);
    }

    root.querySelector("#undo").addEventListener("click", () =>
      this.commitEdit(() => this.session.undo()));
    root.querySelector("#redo").addEventListener("click", () =>
      this.commitEdit(() => this.session.redo()));
    root.querySelector("#clearshapes").addEventListener("click", () =>
      this.commitEdit(() => this.session.clearGeometry()));

    const regions = root.querySelector("#showregions");
    regions.checked = this.showRegions;
    regions.addEventListener("change", () => {
      this.showRegions = regions.checked;
      this.draw();
    });

    for (const [id, name] of [
      ["#showvectors", "vectors"],
      ["#showstreamlines", "streamlines"],
      ["#showpathlines", "pathlines"],
    ]) {
      const box = root.querySelector(id);
      box.checked = this.overlays[name];
      box.addEventListener("change", () => {
        this.overlays[name] = box.checked;
        this.draw();
      });
    }

    // Pointer rather than mouse events, so a stylus or a touch drag works and
    // so capture is available: a drag that leaves the canvas keeps reporting,
    // and clampToDomain decides what that means rather than the gesture simply
    // stopping wherever the pointer crossed the edge.
    const canvas = root.querySelector("#field");
    canvas.addEventListener("pointerdown", (event) => {
      const tool = this.pointerTool;
      if (tool === "probe") {
        event.preventDefault();
        this.pinProbeAt(event.clientX, event.clientY);
        return;
      }
      if (tool === "placeSource") {
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        this.placeSourceAt(event.clientX, event.clientY);
        return;
      }
      if (tool === "brush") {
        if (!this.brush.down(event.clientX, event.clientY)) return;
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
        this.draw();
        return;
      }
      if (!this.drawing.down(event.clientX, event.clientY)) return;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      this.draw();
    });
    canvas.addEventListener("pointermove", (event) => {
      // The hover readout is updated for EVERY tool and updates the panel
      // text only - it never redraws the canvas. Reading a cell while drawing
      // a wall through it is an obvious thing to want, and repainting the
      // field on every pointer move to show a line of text would cost a frame
      // for nothing.
      this.readHover(event.clientX, event.clientY);
      if (this.pointerTool === "brush") {
        if (this.brush.move(event.clientX, event.clientY)) this.draw();
        return;
      }
      if (this.drawing.move(event.clientX, event.clientY)) this.draw();
    });
    canvas.addEventListener("pointerleave", () => {
      if (this.hoverPoint === null) return;
      this.hoverPoint = null;
      this.updateProbeHover();
    });
    canvas.addEventListener("pointerup", (event) => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (this.pointerTool === "brush") {
        if (this.brush.up()) this.draw();
        return;
      }
      if (this.drawing.anchor === null) return;
      // up() commits through onCommit, which redraws. It returns false for a
      // gesture too small to make a shape, which still has to clear the
      // preview off the canvas.
      if (!this.drawing.up()) this.draw();
    });
    canvas.addEventListener("pointercancel", () => {
      if (this.brush.cancel()) this.draw();
      if (this.drawing.cancel()) this.draw();
    });
    // Escape abandons a drag. The gesture is not the document, so nothing
    // reaches the undo stack and there is nothing to undo afterwards.
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (this.brush.cancel()) this.draw();
      if (this.drawing.cancel()) this.draw();
    });

    for (const [id, name] of [
      ["#brushspeed", "speed"], ["#brushradius", "radius"], ["#brushrelax", "relaxationTime"],
    ]) {
      const input = root.querySelector(id);
      input.value = String(BRUSH_DEFAULTS[name]);
      input.addEventListener("change", () => {
        if (!this.brush.setSetting(name, Number(input.value))) {
          input.value = String(this.brush.settings[name]);
        }
      });
    }
    root.querySelector("#clearsources").addEventListener("click", () => {
      if (this.session.clearSources()) this.draw();
    });

    this.bindProbeControls();
  }

  bindProbeControls() {
    const { root } = this;
    const quantity = root.querySelector("#probequantity");
    // Built from the table rather than listed in the markup, so a quantity
    // added to ui/probes.js appears here without anyone editing index.html.
    for (const [id, spec] of Object.entries(PROBE_QUANTITIES)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = spec.label;
      option.title = spec.description;
      quantity.appendChild(option);
    }
    quantity.value = this.probeQuantity;
    quantity.addEventListener("change", () => {
      this.probeQuantity = quantity.value;
      this.draw();
    });

    root.querySelector("#probepick").addEventListener("change", (event) => {
      const id = Number(event.target.value);
      this.probeSelection = Number.isFinite(id) && id > 0 ? id : null;
      this.draw();
    });

    // Arms the probe tool, as the reference's "+ Add Probe" does. Pinning still
    // happens by clicking the field: a probe is a PLACE, and a button cannot
    // say where.
    root.querySelector("#addprobe").addEventListener("click", () => this.setTool("probe"));

    root.querySelector("#clearprobes").addEventListener("click", () => {
      if (!this.session.clearProbes()) return;
      this.probeSelection = null;
      this.draw();
    });
  }

  // Pins a probe where the pointer went down.
  //
  // Unlike a source, a probe is refused only for being outside the DOMAIN -
  // a probe inside a wall is a legitimate thing to pin, and it says "solid"
  // until the wall is erased.
  pinProbeAt(clientX, clientY) {
    const layout = this.layout();
    const point = screenToPhysical(clientX, clientY, layout);
    if (!isInsideDomain(point, layout, layout.h / 2)) return false;
    const { x, y } = clampToDomain(point, layout);
    let probe;
    try {
      probe = this.session.addProbe(x, y);
    } catch (error) {
      this.editMessage = `probe rejected: ${error.message}`;
      this.draw();
      return false;
    }
    // A newly pinned probe becomes the plotted one: it is the one just asked
    // for, and leaving the chart on an older probe would make pinning look
    // like it did nothing.
    this.probeSelection = probe.id;
    this.draw();
    return true;
  }

  // Where the pointer is, for the hover readout.
  //
  // The POINT is remembered, not the sample. Storing the sample would freeze
  // the reading at the instant the pointer last moved, and a running
  // simulation would then show a stale measurement under a live cursor - the
  // panel describing a field that has moved on, which is the one thing this
  // harness is required not to do. Recomputed on every repaint instead, which
  // costs one cell lookup.
  //
  // Nothing is recorded: a hover is not a measurement and must not enter a
  // history the plot draws.
  readHover(clientX, clientY) {
    const layout = this.layout();
    const point = screenToPhysical(clientX, clientY, layout);
    if (!isInsideDomain(point, layout, layout.h / 2)) {
      if (this.hoverPoint === null) return;
      this.hoverPoint = null;
      this.updateProbeHover();
      return;
    }
    this.hoverPoint = clampToDomain(point, layout);
    this.updateProbeHover();
  }

  // The numbers canvasMapping needs to turn a pointer position into a place in
  // the fluid. Read fresh every time: the canvas is displayed with max-width,
  // so its box changes with the window and a cached rect would put shapes
  // somewhere other than where they were drawn.
  layout() {
    const canvas = this.root.querySelector("#field");
    const { grid } = this.scenario;
    return {
      rect: canvas.getBoundingClientRect(),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      margin: MARGIN,
      scale: this.scale,
      h: grid.h,
      nx: grid.nx,
      ny: grid.ny,
    };
  }

  // Which controller a pointer event goes to. The brush and the source placer
  // make no geometry, so the drawing controller is parked on "select" while
  // either is armed rather than being asked to understand them.
  get pointerTool() { return this.armedTool ?? "select"; }

  setTool(id) {
    this.armedTool = id;
    const geometry = DRAW_TOOLS[id].makes !== null;
    this.drawing.setTool(geometry ? id : "select");
    if (!geometry) this.brush.cancel();
    this.root.querySelector("#field").classList.toggle("drawing", id !== "select");
    this.draw();
  }

  // A geometry edit. The session stops the run and rebuilds the field from the
  // scenario's initial condition; the harness re-derives everything downstream
  // of the mask.
  //
  // A failure is cleared here for the same reason Reset clears it: the field
  // being shown was replaced, not repaired, so there is no broken state left
  // to protect anyone from. What would be wrong is clearing it while keeping
  // the field, and that is not a thing this path can do.
  commitEdit(apply) {
    if (!this.session) return false;
    this.editMessage = null;
    let changed;
    try {
      changed = apply();
    } catch (error) {
      // An edit the document model rejects leaves the editor untouched, so the
      // right response is to say why and carry on rather than to halt.
      this.editMessage = `edit rejected: ${error.message}`;
      this.draw();
      return false;
    }
    if (!changed) return false;
    this.stopLoop();
    this.state = "paused";
    this.failure = null;
    this.failureKind = null;
    this.syncScenario();
    this.renderValidation();
    this.draw();
    return true;
  }

  // The panel is told whether the domain is still the scenario's own, so a
  // recorded wake length is never shown beside a cylinder that has been
  // erased. The session decides that by comparing masks; see ui/session.js.
  renderValidation() {
    this.validation.render(this.scenarioId, {
      geometryEdited: !this.session.geometryMatchesScenario,
      // The condition the scenario actually runs at, so a case benchmarked at a
      // different Reynolds number says so rather than letting "benchmarked"
      // stand beside a flow in another regime.
      scenarioRe: this.scenario.Re ?? null,
    });
  }

  // A pure display change. No step, no reset, no field is touched - which is
  // the whole requirement for M3's mode switching, and is asserted rather than
  // assumed in tests/test9_m3_visualization.js.
  setMode(id) {
    this.mode = id;
    this.syncModeTiles();
    this.draw();
  }

  // The selected tile, and every tile's swatch painted from the ramp its view
  // will actually use - including the magnitude ramp the viewer picked.
  syncModeTiles() {
    for (const tile of this.root.querySelectorAll("#mode .modetile")) {
      const on = tile.dataset.mode === this.mode;
      tile.setAttribute("aria-checked", on ? "true" : "false");
      tile.tabIndex = on ? 0 : -1;
    }
    for (const swatch of this.root.querySelectorAll("#mode .swatch")) {
      const ramp = rampForView(swatch.dataset.swatchFor, this.palette);
      const stops = [];
      for (let k = 0; k <= 12; k++) stops.push(`${samplerCss(ramp, k / 12)} ${(k / 12) * 100}%`);
      swatch.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
    }
  }

  // Cancels the animation loop without drawing. load() needs this because
  // drawing requires a scenario, and load() runs before one exists.
  stopLoop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  load(id) {
    this.stopLoop();
    // The session owns the scenario, its fields, and the rules for what
    // happens to them when the geometry changes. The harness drives it and
    // draws it, rather than keeping a second copy of that state which could
    // disagree about whether a field is still valid.
    if (this.session) this.session.load(id);
    else this.session = new SimulationSession(id);
    this.failure = null;
    this.failureKind = null;
    this.state = "paused";
    this.editMessage = null;
    this.drawing.cancel();
    // The session clears the probes themselves - a place in one domain is not
    // a place in another - so what is left here is the selection pointing at
    // one that no longer exists.
    this.probeSelection = null;
    this.hoverPoint = null;

    this.syncScenario();
    this.syncBoundaryForm();
    this.root.querySelector("#note").textContent = this.scenario.note;
    this.renderValidation();
    this.draw();
  }

  // Everything the harness derives from the current scenario object. Called on
  // load and again on every geometry edit, because an edit REPLACES the
  // scenario - the session rebuilds it rather than patching the field - so a
  // plan compiled before the edit describes a domain that no longer exists.
  syncScenario() {
    const { grid } = this.scenario;
    // Compiled once and handed to both the solver and the overlay, so the
    // picture of what is applied where cannot disagree with what is applied.
    // Compiling separately for the display would be two implementations of one
    // rule.
    // From the session's specification, which is the editor's - the same object
    // step() is handed. Reading scenario.bc here would draw the scenario's
    // original boundaries over a solver running the edited ones.
    this.plan = boundaryPlanFor(grid, this.session.bc);
    this.tracerConfig = this.session.tracerConfig;

    // Reseed is only meaningful where there is an initial pattern to restore.
    // On an injection-only scenario it would clear the dye and appear to do
    // nothing, so it says why it is unavailable instead.
    const reseed = this.root.querySelector("#reseed");
    reseed.disabled = !this.tracerConfig.seeded;
    reseed.title = this.tracerConfig.note;
    this.root.querySelector("#dyenote").textContent = this.tracerConfig.note;

    // Sized to the wider centre column of the new layout. The cap stops a
    // small grid from producing a canvas several screens tall; the smooth
    // renderer covers the extra pixels per cell by interpolation rather than
    // by enlarging blocks.
    const canvas = this.root.querySelector("#field");
    const scale = Math.max(1, Math.min(MAX_SCALE, Math.floor((TARGET_WIDTH - 2 * MARGIN) / grid.nx)));
    this.scale = scale;
    canvas.width = grid.nx * scale + 2 * MARGIN;
    canvas.height = grid.ny * scale + 2 * MARGIN;
    canvas.classList.toggle("cells", !this.smooth);
    this.root.querySelector("#scenariotitle").textContent = this.scenario.label;
  }

  // Dye controls only ever touch the tracer. They do not reset the run: the
  // flow keeps whatever state it has and only what is painted into it changes.
  seedTracer() {
    if (!this.session || !this.tracerConfig.seeded) return;
    this.tracer.clear();
    this.tracer.seed(this.scenario.grid, this.tracerConfig.seed);
    this.draw();
  }

  clearTracer() {
    if (!this.session) return;
    this.tracer.clear();
    this.draw();
  }

  run() {
    if (this.state === "failed") return; // only Reset clears a failure
    if (this.state === "running") return;
    this.state = "running";
    this.perf.frames = 0;
    this.perf.steps = 0;
    this.perf.since = performance.now();
    this.tick();
  }

  pause() {
    this.stopLoop();
    if (this.state === "running") this.state = "paused";
    if (this.scenario) this.draw();
  }

  tick() {
    if (this.state !== "running") return;
    const started = performance.now();

    // The timestep is chosen from the field before every step, not fixed for
    // the run. A stability failure is an exception, not a status code, so it
    // is caught here and turned into the same hard stop as a non-finite field.
    let stepsThisFrame = 0;
    try {
      for (let n = 0; n < STEPS_PER_FRAME; n++) {
        // One session step: it chooses the timestep from the field, runs the
        // solver, and advects the tracer on the field the solver just
        // produced. It refuses outright if the geometry moved underneath it.
        this.session.advance();
        stepsThisFrame++;
        if (performance.now() - started > FRAME_BUDGET_MS) break;
      }
    } catch (error) {
      // The decision about what an error MEANS is a pure function in
      // ui/fieldHealth.js, not a list of instanceof checks inlined in a frame
      // callback. It went wrong there once - M5 made a rejected geometry
      // producible from the UI, SolverGeometryError was not in the list, and the
      // exception escaped into the animation loop - and a decision reachable
      // only from a browser is a decision node tests cannot ask about.
      const failure = classifyRunFailure(error, RUN_FAILURE_KINDS);
      // An unrecognised error is rethrown. A catch-all here would dress a
      // programming mistake up as a physical failure.
      if (failure === null) throw error;
      this.state = "failed";
      this.stopLoop();
      this.failure = failure.message;
      this.failureKind = failure.kind;
      this.draw();
      return;
    }

    this.draw();
    this.countFrame(stepsThisFrame);
    if (this.state === "running") this.frame = requestAnimationFrame(() => this.tick());
  }

  // Frames and solver steps per second over the last second of running, for
  // the status bar. Measured, not configured: the harness asks for four steps
  // a frame and takes fewer when a step is slow, so the number that matters is
  // the one that happened.
  countFrame(steps) {
    const perf = this.perf;
    perf.frames++;
    perf.steps += steps;
    const now = performance.now();
    const elapsed = now - perf.since;
    if (elapsed >= 1000) {
      perf.fps = (perf.frames * 1000) / elapsed;
      perf.sps = (perf.steps * 1000) / elapsed;
      perf.frames = 0;
      perf.steps = 0;
      perf.since = now;
    }
  }

  draw() {
    const { grid } = this.scenario;
    const inspection = inspectField(grid);
    // The CONTINUITY ERROR, not the raw divergence. They are the same number
    // unless a mass source is deliberately imposing divergence, and where one
    // is, the raw value would read ~q - measured at 1.80e+0 against a bound of
    // 1e-7 - and tell a viewer who does not know a source is running that the
    // solver has failed. What is imposed gets its own row instead, so the panel
    // says a source is active rather than looking broken.
    // Compiled from the session's sources - the same array step() is handed -
    // so the panel cannot describe a source configuration the solver is not
    // running. Compiling from a separate reading of the scenario is what let
    // the two disagree the first time.
    this.sourcePlan = sourcePlanFor(grid, this.session.sources);
    const divergence = computeContinuityError(grid, this.sourcePlan);
    const health = assessField(inspection);

    // A field that has stopped being finite is a hard stop, not a warning.
    if (health.halt && this.state !== "failed") {
      this.state = "failed";
      this.stopLoop();
      this.failure = health.message;
      this.failureKind = "field";
    }

    // The compiled source plan and the solver's own divergence bound are
    // handed in, so the continuity view measures what the panel measures and
    // scales against the promise step() actually makes. Reading either from a
    // second place is how the panel and the picture start disagreeing.
    const view = prepareView(this.mode, {
      grid,
      tracer: this.tracer,
      sources: this.sourcePlan,
      divergenceTol: this.scenario.params.divergenceTol,
      palette: this.palette,
    });
    // The preview and the region overlay are drawn through the renderer's tint
    // hook, inside the loop that already visits every cell, and the count of
    // affected cells is taken from that same pass. Counting separately would be
    // a second implementation of "which cells does this shape cover", free to
    // disagree with the one the user is looking at.
    const pending = this.drawing.pending;
    const counter = { changing: 0 };
    this.renderer.render(grid, view, MARGIN, this.composeTint(grid, counter), {
      smooth: this.smooth,
      scale: this.scale,
    });
    this.previewSummary = pending === null ? null : { operation: pending, changing: counter.changing };
    // The wall, as a line along the faces the solver treats as surface. Drawn
    // before the bands and overlays so neither is hidden under it.
    drawSurfaceOutline(this.renderer.context, grid, {
      originX: MARGIN, originY: MARGIN, scale: this.scale, h: grid.h, ny: grid.ny,
    }, { width: Math.max(1, Math.min(2, this.scale / 4)) });
    drawBoundaryOverlay(this.renderer.context, this.plan, {
      originX: MARGIN,
      originY: MARGIN,
      scale: this.scale,
      band: BAND,
    });
    this.drawFlowOverlays(grid, view);
    // Last, so a marker is never painted over by the picture it refers to.
    drawProbeMarkers(this.renderer.context, this.session.probes.probes, {
      originX: MARGIN,
      originY: MARGIN,
      scale: this.scale,
      h: grid.h,
      ny: grid.ny,
    });
    this.updateReadouts(inspection, divergence, health, view);
  }

  updateReadouts(inspection, divergence, health, view) {
    const { scenario, root } = this;
    const { params, grid } = scenario;

    const set = (id, text, bad = false) => {
      const node = root.querySelector(id);
      node.textContent = text;
      node.classList.toggle("bad", bad);
    };

    set("#nu", exponential(params.nu, 3));
    set("#rho", fixed(params.rho, 1));
    const sel = this.lastSelection;
    set("#dt", sel ? compact(sel.dt) : "per step");
    set("#cfl", sel ? `${fixed(sel.cflNumber, 3)} / ${fixed(sel.diffusionNumber, 3)}` : "-");
    set("#dtlimit", sel ? sel.limitedBy : "-");
    set("#grid", `${grid.nx} x ${grid.ny}  (h = ${exponential(grid.h, 2)})`);
    set("#re", integer(scenario.Re));
    set("#iteration", integer(this.iteration));
    set("#time", fixed(this.simulatedTime, 3));

    set("#divmax", exponential(divergence.max, 2), isBad(divergence.max));
    set("#divrms", exponential(divergence.rms, 2), isBad(divergence.rms));
    this.updateDivergenceNote(divergence);
    this.updateImposedDivergence();

    // assessField decides what may be reported; see ui/fieldHealth.js for why
    // the peak speed is not simply inspection.maxSpeed.
    const reportedPeak = health.reportedPeakSpeed;
    set("#peak", exponential(reportedPeak, 3), isBad(reportedPeak));

    if (this.lastStep === null) {
      set("#poisson", "not stepped yet");
      set("#poissonits", "-");
    } else {
      const converged = this.lastStep.poissonConverged;
      set("#poisson", converged ? "converged" : "DID NOT CONVERGE", !converged);
      set(
        "#poissonits",
        `${integer(this.lastStep.poissonIterations)} iterations, residual ${exponential(this.lastStep.poissonResidual, 2)}`,
        isBad(this.lastStep.poissonResidual)
      );
    }

    set("#fieldstate", health.fieldSummary, !health.ok);

    const banner = root.querySelector("#banner");
    if (this.state === "failed") {
      banner.hidden = false;
      banner.textContent = this.failureKind === "geometry"
        ? `GEOMETRY REJECTED - ${this.failure} The field below is the initial ` +
          `condition, untouched: no step was taken. Change the geometry or the ` +
          `boundary conditions and it will run.`
        : `SIMULATION DIVERGED - ${this.failure}. Numbers below are from the broken field. Press Reset.`;
    } else {
      banner.hidden = true;
    }

    set("#status", this.state.toUpperCase(), this.state === "failed");
    const chip = root.querySelector("#statechip");
    chip.dataset.state = this.state;
    chip.textContent = this.state;
    const perf = this.perf;
    set(
      "#perf",
      this.state === "running" && perf.fps !== null
        ? `${fixed(perf.fps, 0)} fps \u00b7 ${fixed(perf.sps, 0)} steps/s`
        : "-"
    );
    this.drawResidualChart();
    root.querySelector("#run").disabled = this.state !== "paused";
    root.querySelector("#pause").disabled = this.state !== "running";

    this.updateTracerReadouts();
    this.updateSourcePanel();
    this.updateProbePanel();
    this.updateAnalysisPanel();
    this.updateBoundaryPanel();
    this.updateGeometryPanel();
    this.updateLegend(view);
  }

  // What gets blended over the field. A drag in progress wins over the region
  // overlay: while a shape is being pulled out, the cells it will change are
  // the only thing worth showing, and two tints at once would be unreadable.
  //
  // The preview colours cells the SHAPE covers; the counter records only the
  // ones that would actually change state, since a circle drawn over an
  // existing wall covers plenty of cells and changes none of them.
  composeTint(grid, counter) {
    const preview = this.drawing.tintFor(grid);
    if (preview !== null) {
      const adding = this.drawing.pending.op === "add";
      return (i, j) => {
        const colour = preview(i, j);
        if (colour !== null && (grid.solid[grid.idx(i, j)] !== 0) !== adding) counter.changing++;
        return colour;
      };
    }
    if (!this.showRegions) return null;
    // Drawn from the same labelling the solver reads, not a second computation
    // of connectivity - the same rule the M4 bands follow.
    return regionTint(grid, fluidRegions(grid));
  }

  // The geometry panel: which tool is armed, what the pending gesture would
  // do, and the document as a list you can remove entries from.
  updateGeometryPanel() {
    const { root, session } = this;
    const set = (id, text, bad = false) => {
      const node = root.querySelector(id);
      node.textContent = text;
      node.classList.toggle("bad", bad);
    };

    // The ARMED tool, not the drawing controller's. The controller is parked
    // on "select" whenever a tool that makes no geometry is armed - the brush,
    // the source placer, the probe - so reading it here highlighted Select
    // while the brush was the thing a click would use. Wrong since M6, and
    // found only when a check asserted what the tool list shows.
    const armed = this.pointerTool;
    for (const button of root.querySelectorAll("#tools .tool")) {
      button.classList.toggle("on", button.dataset.tool === armed);
    }

    set("#geomtool", DRAW_TOOLS[armed].label);
    const count = session.editor.size;
    set("#geomcount", count === 0 ? "none" : integer(count));

    // The live line goes to the toolbar, not to this panel: it is read while
    // dragging, so it belongs beside the canvas rather than four panels down
    // the right column. Rendered in one place only - two elements showing the
    // same live string is how the two come to disagree.
    const preview = this.previewSummary;
    if (this.editMessage !== null) {
      set("#drawstatus", this.editMessage, true);
    } else if (preview === null) {
      set(
        "#drawstatus",
        this.drawing.tool === "select"
          ? "pick a tool, then drag on the field to draw"
          : `${DRAW_TOOLS[this.drawing.tool].label}: drag on the field`
      );
    } else {
      const becomes = preview.operation.op === "add" ? "become solid" : "become fluid";
      // Zero is flagged rather than just printed. A drag narrower than a cell
      // is a perfectly valid shape that samples to nothing, and so is one drawn
      // entirely inside an existing wall - both look like the tool is broken
      // unless the readout says, before release, that this will change nothing.
      set("#drawstatus", `${integer(preview.changing)} cells ${becomes}`, preview.changing === 0);
    }

    root.querySelector("#undo").disabled = !session.canUndo;
    root.querySelector("#redo").disabled = !session.canRedo;
    root.querySelector("#clearshapes").disabled = count === 0;

    const list = root.querySelector("#geomlist");
    const signature = `${this.scenarioId}:${session.editor.revision}`;
    if (list.dataset.builtFor === signature) return;
    list.innerHTML = "";
    session.document.operations.forEach((operation, index) => {
      const row = document.createElement("div");
      row.className = "geomrow";
      const label = document.createElement("span");
      label.className = "gindex";
      label.textContent = String(index + 1);
      const text = document.createElement("span");
      text.className = "gtext";
      text.textContent = describeOperation(operation);
      const drop = document.createElement("button");
      drop.className = "gdrop";
      drop.textContent = "remove";
      drop.title = "Remove this shape";
      // Removing a scenario's own shape is allowed and is the point: deleting
      // the cylinder from the cylinder scenario is a legitimate edit, and the
      // solver is told about it the same way any drawn shape is.
      drop.addEventListener("click", () => this.commitEdit(() => session.removeEdit(index)));
      row.append(label, text, drop);
      list.appendChild(row);
    });
    list.dataset.builtFor = signature;
  }

  // A scenario's seeded field need not be divergence-free, and one is not: the
  // cylinder seeds a uniform stream in every fluid cell, which is discontinuous
  // across the obstacle and reads 1.20e+1 before the first step. The number is
  // correct, and shown identically to a running measurement it looks like a
  // broken solver rather than an un-projected initial condition.
  //
  // So it is LABELLED rather than fixed. The alternative - projecting the
  // initial condition in the scenario builder - would move the cylinder's
  // initial state and with it the golden fields and possibly the benchmark,
  // which is far too much to pay for a cosmetic problem.
  //
  // The note appears only when there is something to explain: at iteration 0,
  // and only when the divergence is above the scenario's own bound.
  updateDivergenceNote(divergence) {
    const note = this.root.querySelector("#divnote");
    const bound = this.scenario.params.divergenceTol;
    const unprojected = isUnprojectedInitialCondition(this.iteration, divergence.max, bound);

    this.root.querySelector("#divmax").classList.toggle("pending", unprojected);
    note.hidden = !unprojected;
    if (unprojected) {
      note.textContent =
        `Measured on the initial condition, before any step has been taken. A ` +
        `scenario seeds whatever field it defines and that field need not be ` +
        `divergence-free - this one seeds a uniform stream through cells the ` +
        `obstacle interrupts. The first projection is what makes it so; press Run ` +
        `and this drops below ${exponential(bound, 0)}.`;
    }
  }

  // What the sources deliberately impose, shown only when something does.
  //
  // Without this the continuity error would be the whole story and a reader
  // would have no way to tell, from the panel, that the field carries a
  // divergence of 1.8 on purpose. The row is not a warning - an imposed
  // divergence is the source working - so it is stated plainly rather than
  // flagged.
  updateImposedDivergence() {
    const mass = this.sourcePlan?.mass ?? null;
    const label = this.root.querySelector("#imposedlabel");
    const value = this.root.querySelector("#imposed");
    const note = this.root.querySelector("#imposednote");

    if (mass === null) {
      label.hidden = true;
      value.hidden = true;
      note.hidden = true;
      return;
    }

    const { grid } = this.scenario;
    let worst = 0;
    let cells = 0;
    for (let j = 1; j <= grid.ny; j++) {
      for (let i = 1; i <= grid.nx; i++) {
        const k = grid.idx(i, j);
        if (grid.solid[k]) continue;
        const row = mass.cells[k];
        if (row < 0) continue;
        cells++;
        worst = Math.max(worst, Math.abs(mass.table[row].q));
      }
    }

    label.hidden = false;
    value.hidden = false;
    value.textContent = `${exponential(worst, 2)} over ${integer(cells)} cells`;
    note.hidden = false;
    note.textContent =
      `A mass source is running, so the flow is non-solenoidal on purpose at ` +
      `those cells. The continuity error above is measured against what the ` +
      `sources ask for, max |div u - q|, which is what says whether the ` +
      `projection is doing its job; the raw max |div u| would read about ` +
      `${exponential(worst, 2)} and mean nothing is wrong.`;
  }

  // Places a persistent source where the pointer went down. The kind and its
  // parameters come from the same controls the brush uses, so what is placed is
  // what the brush would have applied - one set of numbers, not two.
  placeSourceAt(clientX, clientY) {
    const layout = this.layout();
    const point = screenToPhysical(clientX, clientY, layout);
    if (!isInsideDomain(point, layout, layout.h / 2)) return false;
    const { x, y } = clampToDomain(point, layout);
    const { speed, radius, relaxationTime } = this.brush.settings;
    const dye = Number(this.root.querySelector("#brushdye").value);
    const source = {
      kind: "momentum",
      label: "placed",
      where: {
        kind: "disk", cx: x, cy: y, radius: radius * layout.h,
        metric: "squared", closed: true,
      },
      // Placed sources push along +x by default; the list lets you remove one
      // and the controls let you change the speed before placing the next.
      u: speed, v: 0,
      relaxationTime,
      ...(Number.isFinite(dye) && dye > 0 ? { dye } : {}),
    };
    try {
      this.session.addSource(source);
    } catch (error) {
      // A source covering no updatable face is refused by the compiler with a
      // reason - most often placed inside a wall - and saying so beats a click
      // that appears to do nothing.
      this.editMessage = `source rejected: ${error.message}`;
      this.draw();
      return false;
    }
    this.draw();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Flow overlays: vectors, streamlines, pathlines
  // ---------------------------------------------------------------------------

  // All three read the field and draw on the canvas. None of them touches the
  // simulation, which is M3's rule and is what makes a toggle here the same
  // kind of thing as switching the colour map.
  //
  // Streamlines are TRACED here, on every repaint, because they are an
  // instantaneous object: the curve tangent to the field a moment ago is not
  // the curve tangent to it now, and caching one would show a picture of a
  // field that no longer exists. Measured worst case 4.4 ms on the cylinder,
  // the largest grid here, against an 86 ms solver step. Pathlines are the
  // opposite - they are state, advanced by the session on every step - so
  // nothing is computed for them here beyond reading the trails.
  drawFlowOverlays(grid, view) {
    const context = this.renderer.context;
    const placement = {
      originX: MARGIN, originY: MARGIN, scale: this.scale, h: grid.h, ny: grid.ny,
    };
    const counts = { vectors: 0, streamlines: 0, pathlines: 0, stride: null };

    if (this.overlays.pathlines) {
      // Drawn first, so an arrow or a streamline is never hidden behind a
      // trail. Faded along their length, which is what says which end is now.
      const trails = this.session.pathlines.particles
        .map((particle) => particle.trail)
        .filter((trail) => trail.length >= 2);
      // Near-white rather than the yellow they were: yellow sat on top of the
      // brightest part of the turbo ramp and was the "sharp" colour the UI
      // refresh was asked to remove. Faded towards the tail so the direction
      // of travel is readable without an arrowhead on every parcel.
      counts.pathlines = drawPolylines(context, trails, placement, {
        colour: "rgba(248,250,252,0.82)", width: 1.2, fade: true,
      });
    }

    if (this.overlays.streamlines) {
      const lines = traceStreamlines(grid, {
        // Six cells between seeds, half a cell per step. Both measured rather
        // than picked: at this spacing the cylinder yields 112 lines for
        // 4.4 ms, and the pair of lengths (seeds at `spacing`, separation at
        // half of it) is what takes the smooth bend from 4 lines to 13.
        spacing: grid.h * 6,
        ds: grid.h / 2,
      });
      counts.streamlines = drawPolylines(context, lines, placement, {
        colour: "rgba(255,255,255,0.78)", width: 1.2,
      });
    }

    if (this.overlays.vectors) {
      // The reference speed comes from the VELOCITY scale, not from whatever
      // the colour map happens to be showing: an arrow's length means speed
      // whether the picture underneath is pressure, vorticity or dye, and
      // borrowing an unrelated scale would make it mean nothing.
      const reference = view !== null && view.id === "velocity" && Number.isFinite(view.scale.hi)
        ? view.scale.hi
        : null;
      const sampled = sampleVectors(grid, { stride: arrowStride(this.scale), reference });
      counts.vectors = drawVectors(context, sampled, placement, {});
      counts.stride = sampled.stride;
      counts.reference = sampled.reference;
    }

    this.overlayCounts = counts;
    this.updateOverlayNote();
  }

  updateOverlayNote() {
    const node = this.root.querySelector("#overlaynote");
    const counts = this.overlayCounts;
    const parts = [];
    if (this.overlays.vectors && counts) {
      parts.push(
        `${integer(counts.vectors)} arrows every ${integer(counts.stride)} cells, ` +
        `longest = ${exponential(counts.reference, 2)}`
      );
    }
    if (this.overlays.streamlines && counts) {
      parts.push(`${integer(counts.streamlines)} streamlines (this instant)`);
    }
    if (this.overlays.pathlines && counts) {
      parts.push(
        `${integer(counts.pathlines)} of ${integer(this.session.pathlines.count)} parcels ` +
        `(trails over time)`
      );
    }
    node.textContent = parts.length === 0
      ? "none - streamlines are tangent to the field now, pathlines are where parcels have been"
      : parts.join("  -  ");
  }

  // ---------------------------------------------------------------------------
  // Flow analysis
  // ---------------------------------------------------------------------------

  // Everything here is computed by physics/flowAnalysis.js from the grid, the
  // compiled boundary plan the solver is running, and the scenario's declared
  // reference scale. The harness formats and adds nothing - which is what lets
  // node test the decisions about what is reported and what is withheld.
  updateAnalysisPanel() {
    const { root, scenario } = this;
    const set = (id, text, bad = false) => {
      const node = root.querySelector(id);
      node.textContent = text;
      node.classList.toggle("bad", bad);
    };

    const analysis = analyseFlow(scenario.grid, {
      nu: scenario.params.nu,
      rho: scenario.params.rho,
      plan: this.plan,
      reference: scenario.reference ?? null,
      Re: scenario.Re ?? null,
    });
    this.lastAnalysis = analysis;

    const reference = analysis.reference;
    set(
      "#fadeclared",
      reference === null
        ? integer(analysis.declaredRe)
        : `${integer(analysis.declaredRe)}  (${reference.speed} ${fixed(reference.U, 3)} ` +
          `x ${reference.length} ${fixed(reference.L, 3)})`
    );
    set(
      "#fapeak",
      Number.isFinite(analysis.peakRe)
        ? `${integer(analysis.peakRe)}  (|u| ${exponential(analysis.peakSpeed, 3)}, same length)`
        : "-",
      !analysis.speedIsUsable
    );

    const shear = analysis.shear;
    set(
      "#fashear",
      Number.isFinite(shear.peak)
        ? `${exponential(shear.peak, 3)}${shear.peakAt ? ` at cell ${shear.peakAt.i},${shear.peakAt.j}` : ""}`
        : "NaN",
      !Number.isFinite(shear.peak)
    );

    const wall = analysis.wall;
    set(
      "#fawall",
      wall.counted === 0
        ? "no no-slip wall in this domain"
        : `${exponential(Math.abs(wall.peak), 3)} over ${integer(wall.counted)} faces ` +
          `(${fixed(wall.perimeter, 2)} of wall; total force withheld)`,
      wall.nonFinite > 0
    );

    set(
      "#fasep",
      analysis.separations.length === 0
        ? "none"
        : `${integer(analysis.separations.length)} - ` +
          analysis.separations.slice(0, 3)
            .map((point) => `(${fixed(point.x, 2)}, ${fixed(point.y, 2)})`).join(" ") +
          (analysis.separations.length > 3 ? " ..." : "")
    );

    const rotation = analysis.rotation;
    set(
      "#farot",
      rotation.fluid === 0
        ? "-"
        : `${fixed((rotation.rotating / rotation.fluid) * 100, 1)}% rotating, ` +
          `${fixed((rotation.straining / rotation.fluid) * 100, 1)}% straining, ` +
          `${fixed((rotation.balanced / rotation.fluid) * 100, 1)}% balanced ` +
          `(margin ${fixed(rotation.margin * 100, 0)}%)`
    );

    set(
      "#fadp",
      analysis.pressure.usable
        ? `${exponential(analysis.pressure.range, 3)}  ` +
          `(${exponential(analysis.pressure.min, 2)} to ${exponential(analysis.pressure.max, 2)})`
        : "NaN",
      !analysis.pressure.usable
    );

    // A pressure DIFFERENCE between two pinned probes: the one form of
    // pressure reading that means the same thing under every boundary
    // condition, which is why it is offered rather than an absolute value.
    const probes = this.session.probes.probes;
    if (probes.length < 2) {
      set("#faprobedp", "pin two probes to measure one");
    } else {
      const measured = pressureDropBetween(scenario.grid, probes[0], probes[1]);
      set(
        "#faprobedp",
        measured === null
          ? `${probes[0].label} or ${probes[1].label} is not in fluid`
          : `${probes[1].label} - ${probes[0].label} = ${exponential(measured.drop, 3)} ` +
            `over ${fixed(measured.distance, 2)}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Probes
  // ---------------------------------------------------------------------------

  // One sample as a line of text. A solid cell says so in words rather than
  // printing six NaNs: the numbers are genuinely NaN and format.js would
  // faithfully show them, but "NaN" reads as a broken simulation and this is
  // the ordinary, correct answer for a point inside a wall.
  describeSample(sample) {
    if (!sample.inside) return "outside the domain";
    return `${describePosition(sample)}  ${describeValues(sample)}`;
  }

  // What the pressure numbers are measured against. Asked of the compiled
  // boundary plan through the solver's own predicate, so the panel cannot
  // claim a datum the solver is not using.
  pressureDatum() {
    // Short. The reasoning behind it is in the panel's note, where it can be
    // read once; repeating it in a readout that sits beside live numbers made
    // the datum eight wrapped lines tall and buried everything under it.
    return pressureIsGauge(this.plan) ? "gauge (zero-mean)" : "absolute (prescribed)";
  }

  updateProbeHover() {
    const node = this.root.querySelector("#probehover");
    const sample = this.hoverPoint === null
      ? null
      : probeAt(this.scenario.grid, this.hoverPoint.x, this.hoverPoint.y, {
        nu: this.scenario.params.nu,
      });
    if (sample === null || !sample.inside) {
      node.textContent = "hover the field to read a cell";
      node.classList.remove("bad");
      return;
    }
    node.textContent = this.describeSample(sample);
    // A cell that is neither solid nor finite is a broken one, and that is the
    // one case here that should read as alarming.
    node.classList.toggle("bad", !sample.solid && !sample.finite);
  }

  updateProbePanel() {
    const { root, session } = this;
    const probes = session.probes.probes;
    const list = root.querySelector("#probelist");

    // The ROW STRUCTURE is rebuilt only when the set of probes changes; the
    // VALUES are refreshed every repaint. Rebuilding the rows each frame would
    // discard and re-create a remove button sixty times a second, which makes
    // it unclickable.
    const signature = probes.map((probe) => probe.id).join(",");
    if (list.dataset.builtFor !== signature) {
      list.innerHTML = "";
      for (const probe of probes) {
        const row = document.createElement("div");
        row.className = "probrow";
        row.dataset.probe = String(probe.id);

        // Two lines: an identifying header, and the reading under it. One line
        // wrapped to five in a side panel, which made three probes unreadable.
        const head = document.createElement("div");
        head.className = "phead";
        const dot = document.createElement("span");
        dot.className = "pdot";
        dot.style.background = probe.colour;
        const label = document.createElement("span");
        label.className = "plabel";
        label.textContent = probe.label;
        const where = document.createElement("span");
        where.className = "pwhere";
        const drop = document.createElement("button");
        drop.className = "gdrop";
        drop.textContent = "remove";
        drop.addEventListener("click", () => {
          if (!session.removeProbe(probe.id)) return;
          if (this.probeSelection === probe.id) this.probeSelection = null;
          this.draw();
        });
        head.append(dot, label, where, drop);

        const values = document.createElement("span");
        values.className = "pvals";
        row.append(head, values);
        list.appendChild(row);
      }
      list.dataset.builtFor = signature;
    }

    for (const probe of probes) {
      const row = list.querySelector(`.probrow[data-probe="${probe.id}"]`);
      if (row === null) continue;
      // Read fresh rather than from the last recorded sample, so a paused run
      // still shows the field as it stands instead of the moment it stopped.
      const sample = session.readProbe(probe);
      row.querySelector(".pwhere").textContent = describePosition(sample);
      row.querySelector(".pvals").textContent = describeValues(sample);
      row.querySelector(".pvals").classList.toggle(
        "bad", sample.inside && !sample.solid && !sample.finite
      );
    }

    // Refreshed here too, so a hovered cell keeps reading live while the run
    // advances rather than only when the pointer moves.
    this.updateProbeHover();
    root.querySelector("#pdatum").textContent = this.pressureDatum();
    root.querySelector("#clearprobes").disabled = probes.length === 0;
    this.syncProbeSelector(probes);
    this.drawProbeChart();
  }

  syncProbeSelector(probes) {
    const pick = this.root.querySelector("#probepick");
    const signature = probes.map((probe) => `${probe.id}:${probe.label}`).join(",");
    if (pick.dataset.builtFor !== signature) {
      pick.innerHTML = "";
      if (probes.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "none pinned";
        pick.appendChild(option);
      }
      for (const probe of probes) {
        const option = document.createElement("option");
        option.value = String(probe.id);
        option.textContent = probe.label;
        pick.appendChild(option);
      }
      pick.dataset.builtFor = signature;
    }
    // A selection that no longer exists - the probe was removed, or a scenario
    // change cleared them all - falls back to the newest rather than leaving
    // the chart pointed at nothing.
    if (this.probeSelection !== null && !probes.some((p) => p.id === this.probeSelection)) {
      this.probeSelection = null;
    }
    if (this.probeSelection === null && probes.length > 0) {
      this.probeSelection = probes[probes.length - 1].id;
    }
    pick.value = this.probeSelection === null ? "" : String(this.probeSelection);
    pick.disabled = probes.length === 0;
  }

  drawProbeChart() {
    const canvas = this.root.querySelector("#probechart");
    const context = canvas.getContext("2d");
    const note = this.root.querySelector("#probeaxis");
    const { width, height } = canvas;
    const probe = this.probeSelection === null
      ? null
      : this.session.probes.probeById(this.probeSelection);

    if (probe === null) {
      context.clearRect(0, 0, width, height);
      note.textContent = "no probe pinned - choose the Probe tool and click the field";
      note.classList.remove("bad");
      return;
    }

    const spec = PROBE_QUANTITIES[this.probeQuantity];
    const layout = drawSeries(context, probe.history.series(this.probeQuantity), {
      width, height, padding: 8, colour: probe.colour, background: "#12141a",
    });

    // "Nothing recorded" and "everything recorded is NaN" are different
    // situations and must not share a message. A probe pinned inside a wall
    // records a sample every step - of NaN, correctly - and telling its owner
    // to press Run after a thousand steps is a readout describing a state the
    // app is not in. Found by running the app rather than by a check, which is
    // why there is now a check for it.
    if (layout.points === 0) {
      const recorded = probe.history.length;
      if (recorded === 0) {
        note.textContent = `${probe.label} ${spec.label}: no samples yet - press Run`;
        note.classList.remove("bad");
        return;
      }
      const solid = this.session.readProbe(probe).solid;
      note.textContent = solid
        ? `${probe.label} ${spec.label}: ${integer(recorded)} samples, all inside a wall - ` +
          `nothing to plot until the solid around it is erased`
        : `${probe.label} ${spec.label}: ${integer(recorded)} samples, NONE FINITE`;
      // A solid cell is the ordinary correct answer, not a failure. A cell
      // that is fluid and not finite is the other thing entirely.
      note.classList.toggle("bad", !solid);
      return;
    }
    const parts = [
      `${probe.label} ${spec.label}: ${exponential(layout.range.lo, 2)} to ` +
      `${exponential(layout.range.hi, 2)}`,
      `t = ${fixed(layout.span.t0, 3)} to ${fixed(layout.span.t1, 3)}`,
      `${integer(layout.points)} samples`,
    ];
    // Said in words, because a gap in a line is not self-explanatory and the
    // alternative - drawing straight through it - would look like data.
    if (layout.range.nonFinite > 0) {
      parts.push(`${integer(layout.range.nonFinite)} NOT FINITE, drawn as gaps`);
    }
    if (layout.range.flat) parts.push("constant");
    if (this.probeQuantity === "pressure") parts.push(`datum ${this.pressureDatum()}`);
    note.textContent = parts.join("  -  ");
    note.classList.toggle("bad", layout.range.nonFinite > 0);
  }

  // What sources are doing, drawn from the session's own array - the one the
  // solver is handed - rather than from a second reading of the controls.
  updateSourcePanel() {
    const { root, session } = this;
    const set = (id, text, bad = false) => {
      const node = root.querySelector(id);
      node.textContent = text;
      node.classList.toggle("bad", bad);
    };

    const placed = session.placedSources;
    set("#srccount", placed.length === 0 ? "none" : integer(placed.length));

    const brush = session.brushSource;
    set(
      "#srcbrush",
      brush === null
        ? (this.pointerTool === "brush" ? "armed - drag on the fluid" : "-")
        : `pushing (${fixed(brush.u, 2)}, ${fixed(brush.v, 2)})`
    );

    const injected = this.lastTracer?.injected;
    set(
      "#srcdye",
      injected && injected.cells > 0
        ? `${exponential(injected.added, 2)} into ${integer(injected.cells)} cells`
        : "none"
    );

    root.querySelector("#clearsources").disabled = placed.length === 0;

    const list = root.querySelector("#srclist");
    const signature = placed.map((s) => describeSource(s)).join("|");
    if (list.dataset.builtFor === signature) return;
    list.innerHTML = "";
    placed.forEach((source, index) => {
      const row = document.createElement("div");
      row.className = "geomrow";
      const label = document.createElement("span");
      label.className = "gindex";
      label.textContent = String(index + 1);
      const text = document.createElement("span");
      text.className = "gtext";
      text.textContent = describeSource(source);
      const drop = document.createElement("button");
      drop.className = "gdrop";
      drop.textContent = "remove";
      drop.addEventListener("click", () => {
        session.removeSource(index);
        this.draw();
      });
      row.append(label, text, drop);
      list.appendChild(row);
    });
    list.dataset.builtFor = signature;
  }

  updateTracerReadouts() {
    const { root } = this;
    const set = (id, text, bad = false) => {
      const node = root.querySelector(id);
      node.textContent = text;
      node.classList.toggle("bad", bad);
    };

    const { total, nonFiniteCells } = this.tracer.total(this.scenario.grid);
    set("#dyetotal", exponential(total, 3), isBad(total));
    set(
      "#dyebroken",
      nonFiniteCells === 0 ? "none" : `${integer(nonFiniteCells)} cells`,
      nonFiniteCells > 0
    );

    const advection = this.lastTracer;
    set("#dyecfl", advection ? fixed(advection.cfl, 3) : "-", advection ? isBad(advection.cfl) : false);
    // Substeps above 1 mean the tracer's own bound was tighter than the step
    // it was handed and it subdivided rather than asking for a smaller dt.
    // Shown because a silent substep would hide exactly the situation the
    // separate constraint exists to handle.
    set("#dyesubsteps", advection ? integer(advection.substeps) : "-");
  }

  // The boundary panel. Every row is derived from the compiled plan, and the
  // flux beside it is MEASURED from the velocity field rather than read back
  // off the specification - which is the whole point on a pressure boundary,
  // where nothing was specified and the flux is the answer.
  updateBoundaryPanel() {
    const list = this.root.querySelector("#bclist");
    // Keyed on the geometry revision as well as the scenario: surface
    // conditions attach to solid faces, so an edit can change what the legend
    // should say without the scenario changing at all.
    const signature =
      `${this.scenarioId}:${this.session.editor.revision}:${this.session.boundaries.revision}`;
    if (list.dataset.builtFor !== signature) {
      list.innerHTML = "";
      for (const entry of boundaryLegend(this.plan)) {
        const row = document.createElement("div");
        row.className = "bcrow";
        const extent =
          entry.spans.length === 1 && entry.cells === this.plan.sides[entry.side].cells
            ? "whole side"
            : entry.spans
                .map((s) => `${fixed(s.from, 2)}-${fixed(s.to, 2)}`)
                .join(", ");
        row.innerHTML =
          `<i class="sw" style="background:${entry.colour}"></i>` +
          `<span class="bcside">${entry.side}</span>` +
          `<span class="bctext">${escapeHtml(entry.label)}` +
          `<span class="bcextent">${escapeHtml(extent)}</span></span>`;
        list.appendChild(row);
      }
      list.dataset.builtFor = signature;
    }

    const flux = measureBoundaryFlux(this.scenario.grid, this.plan);
    const set = (id, text, bad = false) => {
      const node = this.root.querySelector(id);
      node.textContent = text;
      node.classList.toggle("bad", bad);
    };
    set(
      "#bcflux",
      ["left", "right", "bottom", "top"]
        .map((side) => `${side[0]} ${exponential(flux[side].flux, 2)}`)
        .join("  "),
      ["left", "right", "bottom", "top"].some((side) => isBad(flux[side].flux))
    );
    // Net flux is the quantity that must be zero for an incompressible domain.
    // Shown because a boundary specification that does not balance is a real
    // error, and this is where it becomes visible.
    set("#bcnet", exponential(flux.net, 2), isBad(flux.net) || Math.abs(flux.net) > 1e-6);

    this.root.querySelector("#bcundo").disabled = !this.session.canUndoBoundary;
    this.root.querySelector("#bcredo").disabled = !this.session.canRedoBoundary;

    // Connected fluid regions. A second region is not an error - a sealed
    // chamber runs perfectly well - so this reports rather than warns. The
    // solver rejects only the region it genuinely cannot solve, and says so
    // itself when it does.
    set("#bcregions", describeRegions(analyseRegions(this.scenario.grid, this.plan)));
  }

  updateLegend(view) {
    const bar = this.root.querySelector("#legendbar");
    const painted = view ? view.id : "none";
    if (bar.dataset.painted !== painted) {
      if (view) {
        const stops = [];
        for (let k = 0; k <= 24; k++) {
          stops.push(`${samplerCss(view.ramp, k / 24)} ${(k / 24) * 100}%`);
        }
        bar.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
      } else {
        bar.style.background = "transparent";
      }
      bar.dataset.painted = painted;
    }

    const set = (id, text, bad = false) => {
      const node = this.root.querySelector(id);
      node.textContent = text;
      node.classList.toggle("bad", bad);
    };

    this.updateScaleBar();
    if (!view) {
      set("#legendtitle", "-");
      set("#legendsub", "");
      set("#legendmin", "-");
      set("#legendmid", "");
      set("#legendmax", "-");
      set("#viewnote", "This view is not available for the current state.");
      return;
    }
    set("#legendtitle", view.label);
    set(
      "#legendsub",
      view.scale.fixed ? "fixed scale" : view.scale.diverging ? "centred on zero" : this.mode === "velocity" ? this.palette : ""
    );

    // Same rule as the peak readout: a scale drawn from a partly broken field
    // is not a scale anyone should read a value off, and prepareView hands
    // back NaN bounds rather than the survivors' range when that happens.
    const { lo, hi, centre, clipped, breached } = view.scale;
    set("#legendmin", compact(lo), isBad(lo));
    // The midpoint is printed for every scale now, not only centred ones: a
    // three-tick legend reads far more easily than a two-tick one, and for a
    // sequential scale the middle is simply the average of the ends.
    set("#legendmid", centre === null ? compact((lo + hi) / 2) : compact(centre));
    set("#legendmax", compact(hi), isBad(hi));

    // A clipped scale must SAY it is clipped, and say what it left out.
    //
    // Fitting the pressure scale to a percentile is what makes the field
    // readable at all next to a geometric singularity, and it is also a picture
    // that flatters: the ends of the ramp no longer mean what the legend says
    // unless the legend admits the range runs further. So the count and the
    // true extremes are printed with the note, not buried.
    const clipNote = clipped === null || clipped === undefined
      ? ""
      : ` Scale fitted to 99% of cells: ${integer(clipped.cells)} of ` +
        `${integer(clipped.of)} lie beyond it and are drawn at the ends of the ` +
        `ramp. The true range is ${exponential(clipped.trueLo, 2)} to ` +
        `${exponential(clipped.trueHi, 2)}, set by the sharpest feature in the ` +
        `geometry rather than by the flow.`;
    // A fixed scale says what it is anchored to, and whether anything is past
    // it. A breach here is not a display trade-off like the percentile clip -
    // it is the solver failing to deliver the bound it promises, so it is
    // stated in those terms and marked bad.
    let boundNote = "";
    if (breached !== null && breached !== undefined) {
      const bound = view.scale.bound;
      boundNote = breached.cells === 0
        ? ` Scale fixed at +-${exponential(hi, 0)}, a decade past the solver's ` +
          `divergence tolerance of ${exponential(bound, 0)}. Worst cell ` +
          `${exponential(breached.worst, 2)} over ${integer(breached.of)} fluid cells - ` +
          `inside the bound, which is what a near-uniform picture here means.`
        : ` ${integer(breached.cells)} of ${integer(breached.of)} cells are PAST the ` +
          `solver's divergence tolerance of ${exponential(bound, 0)}, worst ` +
          `${exponential(breached.worst, 2)}. That is the projection failing to deliver ` +
          `what it promises, not a scaling choice.`;
    }
    const paletteNote = view.paletteNote ? ` ${view.paletteNote}` : "";
    set("#viewnote", view.note + clipNote + boundNote + paletteNote,
      Boolean(breached && breached.cells > 0));
  }

  // A bar the length of the scenario's own reference length - the cylinder's
  // diameter, the duct's width - drawn at the scale the canvas is displayed
  // at. Physical units are not claimed: this solver is non-dimensional, and
  // the reference length is the unit its Reynolds number is built from.
  updateScaleBar() {
    const line = this.root.querySelector("#scalebarline");
    const label = this.root.querySelector("#scalebarlabel");
    const reference = this.scenario.reference;
    const canvas = this.root.querySelector("#field");
    const rect = canvas.getBoundingClientRect();
    if (!reference || rect.width === 0) {
      line.style.width = "0px";
      label.textContent = "-";
      return;
    }
    const cssPerUnit = (this.scale / this.scenario.grid.h) * (rect.width / canvas.width);
    line.style.width = `${Math.max(8, reference.L * cssPerUnit)}px`;
    label.textContent = `${reference.length} = ${compact(reference.L)}`;
  }

  // The continuity error after every solver step, on a log axis with the
  // solver's tolerance drawn across it. One series: the projection is the only
  // part of this method that iterates to a tolerance, so there is no momentum
  // residual to plot - see ui/residuals.js.
  drawResidualChart() {
    const canvas = this.root.querySelector("#residualchart");
    const note = this.root.querySelector("#residualaxis");
    const context = canvas.getContext("2d");
    const { width, height } = canvas;
    const history = this.session.residuals;
    const tolerance = this.scenario.params.divergenceTol;
    const series = history.series("continuity");
    // A FIXED log axis from four decades below the bound to three above it,
    // so the bound sits a little over halfway up. Fitted to the data this
    // chart was a scribble: every step converges TO the tolerance, so the
    // series spans a fifth of a decade and its rounding noise filled the whole
    // height - the continuity view's mistake, made again one panel over.
    const bound = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1e-7;
    const axis = { lo: bound * 1e-4, hi: bound * 1e3 };
    const layout = drawSeries(context, series, {
      width, height, padding: 12, colour: "#60a5fa", background: "#0a101b", log: true,
      lineWidth: 1.6, range: axis,
    });
    if (layout.points === 0) {
      note.textContent = history.length === 0
        ? "no steps yet - press Run"
        : `${integer(history.length)} steps, none plottable on a log axis`;
      note.classList.remove("bad");
      return;
    }
    // The tolerance line.
    const { lo, hi } = layout.range;
    const measured = seriesRange(series.value);
    if (hi > lo) {
      const top = 12;
      const bottom = height - 12;
      const y = bottom - ((Math.log10(bound) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (bottom - top);
      if (y >= top - 1 && y <= bottom + 1) {
        context.save();
        context.setLineDash([6, 5]);
        context.strokeStyle = "rgba(240, 93, 122, 0.8)";
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(12, y);
        context.lineTo(width - 12, y);
        context.stroke();
        context.restore();
      }
    }
    const latest = history.latest();
    const parts = [
      `max|div u - q| per step: ${compact(measured.lo)} to ${compact(measured.hi)}`,
      `bound ${compact(bound)} dashed, axis ${compact(lo)}-${compact(hi)} (log)`,
      `steps ${integer(layout.span.t0)}-${integer(layout.span.t1)}`,
    ];
    if (layout.clipped > 0) parts.push(`${integer(layout.clipped)} beyond the axis, drawn at its edge`);
    if (layout.unplottable > 0) parts.push(`${integer(layout.unplottable)} exact zeros not shown on a log axis`);
    if (layout.range.nonFinite > 0) parts.push(`${integer(layout.range.nonFinite)} NOT FINITE`);
    if (latest && Number.isFinite(latest.poisson)) parts.push(`last solve ${integer(latest.poisson)} CG iterations`);
    note.textContent = parts.join("  -  ");
    note.classList.toggle("bad", layout.range.nonFinite > 0 || measured.hi > bound);
  }
}
