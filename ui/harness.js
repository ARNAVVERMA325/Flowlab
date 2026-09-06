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
  computeContinuityError, boundaryPlanFor, SolverDivergenceError, SolverGeometryError,
} from "../solver/ns2d.js";
import { sourcePlanFor } from "../sources/compile.js";
import { SolverStabilityError } from "../solver/stability.js";
import { inspectField } from "../physics/fieldStats.js";
import { FieldRenderer } from "../visualization/fieldRenderer.js";
import { samplerCss } from "../visualization/colormap.js";
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
import { describeSource } from "../sources/kinds.js";
import {
  prepareView,
  FIELD_SOURCES,
  DEFAULT_FIELD_SOURCE,
} from "../visualization/fieldSources.js";
import { SCENARIOS, DEFAULT_SCENARIO } from "../scenarios/index.js";
import { SimulationSession, StaleFieldError } from "./session.js";
import { assessField, isUnprojectedInitialCondition } from "./fieldHealth.js";
import { ValidationPanel } from "./validationPanel.js";
import { exponential, fixed, integer, isBad } from "./format.js";

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

const STEPS_PER_FRAME = 4;
const FRAME_BUDGET_MS = 24;

// Width of the boundary-condition bands, and the margin they live in. The
// bands sit BESIDE the field, not over its edge: the outermost cells carry the
// boundary layer, which is the part of the picture the boundary condition is
// most responsible for, and covering it to label it would be a poor trade.
const BAND = 7;
const MARGIN = BAND + 2;

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

    const mode = root.querySelector("#mode");
    for (const source of FIELD_SOURCES) {
      const option = document.createElement("option");
      option.value = source.id;
      option.textContent = source.label;
      mode.appendChild(option);
    }
    mode.value = this.mode;
    mode.addEventListener("change", () => this.setMode(mode.value));

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
      button.textContent = tool.label;
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

    // Pointer rather than mouse events, so a stylus or a touch drag works and
    // so capture is available: a drag that leaves the canvas keeps reporting,
    // and clampToDomain decides what that means rather than the gesture simply
    // stopping wherever the pointer crossed the edge.
    const canvas = root.querySelector("#field");
    canvas.addEventListener("pointerdown", (event) => {
      const tool = this.pointerTool;
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
      if (this.pointerTool === "brush") {
        if (this.brush.move(event.clientX, event.clientY)) this.draw();
        return;
      }
      if (this.drawing.move(event.clientX, event.clientY)) this.draw();
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
    });
  }

  // A pure display change. No step, no reset, no field is touched - which is
  // the whole requirement for M3's mode switching, and is asserted rather than
  // assumed in tests/test9_m3_visualization.js.
  setMode(id) {
    this.mode = id;
    this.draw();
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

    const canvas = this.root.querySelector("#field");
    const scale = Math.max(1, Math.min(9, Math.floor((760 - 2 * MARGIN) / grid.nx)));
    this.scale = scale;
    canvas.width = grid.nx * scale + 2 * MARGIN;
    canvas.height = grid.ny * scale + 2 * MARGIN;
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
    try {
      for (let n = 0; n < STEPS_PER_FRAME; n++) {
        // One session step: it chooses the timestep from the field, runs the
        // solver, and advects the tracer on the field the solver just
        // produced. It refuses outright if the geometry moved underneath it.
        this.session.advance();
        if (performance.now() - started > FRAME_BUDGET_MS) break;
      }
    } catch (error) {
      // Three solver failure modes are hard stops here: the scheme coming apart
      // (stability), the projection failing to deliver the incompressibility it
      // promised (divergence), and the domain the geometry describes not being
      // solvable at all.
      //
      // The last one only became reachable when drawing arrived. Before M5 the
      // geometries were fixed and valid, so a rejected domain could not happen
      // from the UI; now the most natural experiment there is - draw a wall
      // across the channel - produces exactly that, and it must land in the
      // panel rather than as an uncaught exception inside a frame callback.
      const isSolverFailure =
        error instanceof SolverStabilityError ||
        error instanceof SolverDivergenceError ||
        error instanceof SolverGeometryError ||
        error instanceof StaleFieldError;
      if (!isSolverFailure) throw error;
      this.state = "failed";
      this.stopLoop();
      this.failure = error.message;
      // A rejected geometry is not a broken field. The field is still the
      // initial condition, unmodified - the solver refused before touching it -
      // so the banner must not tell anyone the numbers below are wreckage.
      this.failureKind = error instanceof SolverGeometryError ? "geometry" : "field";
      this.draw();
      return;
    }

    this.draw();
    if (this.state === "running") this.frame = requestAnimationFrame(() => this.tick());
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

    const view = prepareView(this.mode, { grid, tracer: this.tracer });
    // The preview and the region overlay are drawn through the renderer's tint
    // hook, inside the loop that already visits every cell, and the count of
    // affected cells is taken from that same pass. Counting separately would be
    // a second implementation of "which cells does this shape cover", free to
    // disagree with the one the user is looking at.
    const pending = this.drawing.pending;
    const counter = { changing: 0 };
    this.renderer.render(grid, view, MARGIN, this.composeTint(grid, counter));
    this.previewSummary = pending === null ? null : { operation: pending, changing: counter.changing };
    drawBoundaryOverlay(this.renderer.context, this.plan, {
      originX: MARGIN,
      originY: MARGIN,
      scale: this.scale,
      band: BAND,
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
    set("#dt", sel ? exponential(sel.dt, 3) : "chosen per step");
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
    root.querySelector("#run").disabled = this.state !== "paused";
    root.querySelector("#pause").disabled = this.state !== "running";

    this.updateTracerReadouts();
    this.updateSourcePanel();
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

    for (const button of root.querySelectorAll("#tools .tool")) {
      button.classList.toggle("on", button.dataset.tool === this.drawing.tool);
    }

    set("#geomtool", DRAW_TOOLS[this.drawing.tool].label);
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

    if (!view) {
      set("#legendmin", "-");
      set("#legendmid", "");
      set("#legendmax", "-");
      set("#viewnote", "This view is not available for the current state.");
      return;
    }

    // Same rule as the peak readout: a scale drawn from a partly broken field
    // is not a scale anyone should read a value off, and prepareView hands
    // back NaN bounds rather than the survivors' range when that happens.
    const { lo, hi, centre } = view.scale;
    set("#legendmin", exponential(lo, 2), isBad(lo));
    set("#legendmid", centre === null ? "" : exponential(centre, 2));
    set("#legendmax", exponential(hi, 2), isBad(hi));
    set("#viewnote", view.note);
  }
}
