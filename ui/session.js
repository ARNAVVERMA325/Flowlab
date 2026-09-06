// A scenario plus its live state, and the rules for changing its geometry.
//
// This lives in ui/ rather than scenarios/ because it owns a dye tracer, and
// scenarios/ is sealed against the tracer: a scenario is a physics
// configuration, dye is a display aid, and tests/test9 asserts that deleting
// tracer/ leaves the solver and everything describing the simulation
// untouched. The M3 separation test caught this as soon as the session was
// written in the wrong place.
//
// The session is the DRIVER - the thing an interactive app runs - so it is the
// right home for state only an interactive app needs. A headless use of the
// solver needs none of it.
//
// ---------------------------------------------------------------------------
// WHAT HAPPENS TO THE FIELD WHEN THE GEOMETRY CHANGES
// ---------------------------------------------------------------------------
//
// The field is discarded and the run restarts. Not repaired, not carried over.
//
// The tempting alternative is to keep the flow and patch the difference: zero
// the cells that became solid, seed the ones that became fluid, carry on. It
// would look continuous on screen and it would be wrong in a way that is hard
// to see. Cells that became fluid have no history to carry; cells that became
// solid were carrying momentum that has to go somewhere; and the patched field
// is not divergence-free anywhere near the change, so the first step after it
// would be solving from an initial condition that satisfies nothing. The
// divergence bound step() promises would be met, technically, about a field
// nobody should read.
//
// The honest reason underneath: a domain that changes shape while fluid moves
// through it is a moving-boundary problem. This solver is a fixed-grid method
// and does not model one. Animating the transition would be inventing
// behaviour the simulation did not compute, which is the same failure as fake
// turbulence wearing different clothes.
//
// So the rules are:
//
//   1. A geometry edit stops the run.
//   2. The mask is resampled from the document.
//   3. Velocity, pressure and dye are rebuilt from the scenario's own initial
//      condition - by rebuilding the scenario, so the initial state is exactly
//      what the scenario specifies rather than an approximation of it.
//   4. Iteration count and simulated time return to zero.
//   5. Stepping a grid whose mask has moved since the field was built is
//      REFUSED, not merely discouraged. That guard is mechanical because the
//      alternative is discipline, and discipline is what fails.
//
// The guard tracks whether the field is consistent with the mask, which is the
// property that actually matters - not a proxy for it such as "did the user
// press the edit button".

import { GeometryEditor } from "../geometry/editor.js";
import { BoundaryEditor } from "../boundaries/editor.js";
import { compileBoundaryConditions } from "../boundaries/compile.js";
import { sampleDocument } from "../geometry/document.js";
import { PassiveTracer } from "../tracer/passiveScalar.js";
import { tracerConfigFor } from "../tracer/seeds.js";
import { step } from "../solver/ns2d.js";
import { computeStableTimestep } from "../solver/stability.js";
import { sourcePlanFor } from "../sources/compile.js";
import { combineSources } from "./brush.js";
import { validateSource } from "../sources/kinds.js";
import { buildScenario } from "../scenarios/index.js";

export class StaleFieldError extends Error {
  constructor(message) {
    super(message);
    this.name = "StaleFieldError";
  }
}

export class SimulationSession {
  constructor(scenarioId) {
    this.scenarioId = scenarioId;
    const scenario = buildScenario(scenarioId);
    // The scenario's own geometry, kept so the session can say whether the
    // domain on screen is still the one anything was validated against.
    this.pristineGeometry = scenario.geometry;
    this.editor = new GeometryEditor(scenario.geometry);
    this.boundaries = this.#makeBoundaryEditor(scenario);
    this.placedSources = scenario.sources ?? [];
    this.brushSource = null;
    this.#rebuildSources();
    this.reset();
  }

  get grid() { return this.scenario.grid; }
  // The EDITOR's specification, not the scenario's own. They start identical
  // and diverge the moment a boundary is edited, and everything - the solver,
  // the overlay, the flux readout - has to read the same one or the picture of
  // what is applied stops matching what is applied.
  get bc() { return this.boundaries.spec; }
  get canUndoBoundary() { return this.boundaries.canUndo; }
  get canRedoBoundary() { return this.boundaries.canRedo; }
  get params() { return this.scenario.params; }
  get document() { return this.editor.document; }

  // The combined array - placed sources plus whatever the brush is applying -
  // held rather than recomputed on read.
  //
  // That is a performance requirement, not a style choice. sourcePlanFor caches
  // on the array's identity, and step() plus the timestep selection each ask
  // for a plan on every step. Building a fresh array per READ would miss the
  // cache eight times a frame at four steps per frame, and a compile on the
  // largest grid here costs 0.872 ms against 0.0003 ms for a hit. Rebuilt only
  // when something actually changes, that becomes one compile per pointer move.
  get sources() { return this._sources; }

  #rebuildSources() {
    this._sources = combineSources(this.placedSources, this.brushSource);
  }

  // Compiling the candidate is the validation, not just checking its shape.
  //
  // validateSource only says the object is well formed; whether it selects any
  // face the solver would update is a question about the GRID, and it is
  // answered by compileSources. Checking only the shape let a source placed
  // inside the cylinder pass here and throw later from inside draw(), as an
  // uncaught page error - found by the browser check, because the throw came
  // from somewhere no caller was guarding.
  #compiles(candidate) {
    sourcePlanFor(this.scenario.grid, candidate);
  }

  // The brush hands its live source in here. Null while the pointer is up, or
  // while it is down but has not moved far enough to have a direction.
  //
  // A stroke dragged over a wall produces a source covering no fluid face. That
  // is not an error to report - it is the brush not pushing anything, which is
  // what should happen there - so it is held as "no source" and the panel says
  // "armed" rather than "pushing". The distinction is visible, not silent.
  setBrushSource(source) {
    if (source === null && this.brushSource === null) return false;
    let next = source;
    if (next !== null) {
      try {
        this.#compiles(combineSources(this.placedSources, next));
      } catch {
        next = null;
      }
    }
    if (next === null && this.brushSource === null) return false;
    this.brushSource = next;
    this.#rebuildSources();
    return true;
  }

  // Placed sources are replaced, never mutated - the same rule as the boundary
  // specification, for the same reason: the compiled plan is cached on the
  // array, so editing one in place would leave the solver running the previous
  // configuration.
  addSource(source) {
    validateSource(source, `sources[${this.placedSources.length}]`);
    const next = [...this.placedSources, source];
    // Compiled before it is accepted, so an impossible source is refused here -
    // where the caller is guarding - rather than thrown later from a redraw.
    this.#compiles(combineSources(next, this.brushSource));
    this.placedSources = next;
    this.#rebuildSources();
    return true;
  }

  removeSource(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.placedSources.length) {
      throw new RangeError(
        `cannot remove source ${index}: there are ${this.placedSources.length}`
      );
    }
    this.placedSources = this.placedSources.filter((_, n) => n !== index);
    this.#rebuildSources();
    return true;
  }

  clearSources() {
    if (this.placedSources.length === 0) return false;
    this.placedSources = [];
    this.#rebuildSources();
    return true;
  }
  get canUndo() { return this.editor.canUndo; }
  get canRedo() { return this.editor.canRedo; }

  // Rebuilds everything from the scenario definition and the current document.
  // Rebuilding rather than clearing arrays is deliberate: a scenario's initial
  // condition is whatever its build function produces - the cylinder seeds a
  // uniform stream, for instance - and reproducing that by hand somewhere else
  // would be a second definition of it, free to drift.
  reset() {
    // The document is handed to the builder rather than applied afterwards, so
    // the scenario seeds its initial condition against the geometry that will
    // actually be in force. Applying it after would leave cells the edit
    // exposes holding whatever their slots contained.
    this.scenario = buildScenario(this.scenarioId, this.editor.document);
    this.tracer = new PassiveTracer(this.scenario.grid);
    this.tracerConfig = tracerConfigFor(this.scenarioId);
    this.tracer.seed(this.scenario.grid, this.tracerConfig.seed);

    this.iteration = 0;
    this.simulatedTime = 0;
    this.lastTimestep = null;
    this.lastSelection = null;
    this.lastStep = null;
    this.lastTracer = null;
    this.running = false;
    // The field is now consistent with this mask, and with nothing else.
    this.maskVersionAtReset = this.scenario.grid.maskVersion;
    this.geometryRevisionAtReset = this.editor.revision;
    this.geometryMatchesScenario = this.#sameDomainAsScenario();
    return this;
  }

  // Compiling against the live grid is the validation: a specification the
  // compiler refuses never reaches the editor's history, so undo can never
  // land on something that will not run.
  #makeBoundaryEditor(scenario) {
    return new BoundaryEditor(scenario.bc, (spec) => {
      compileBoundaryConditions(this.scenario?.grid ?? scenario.grid, spec);
    });
  }

  // A boundary edit KEEPS THE FIELD and does not stop the run.
  //
  // The opposite of a geometry edit, and measured rather than assumed: on a
  // settled channel, opening a wall into an inlet, turning an inlet from 1 to
  // 4, closing an inlet, and swapping a wall for free-slip all hold the
  // divergence bound over the following 120 steps with no restart. The domain
  // still exists and the field is still a valid state of it; what changed is a
  // real physical event the solver is entitled to march through.
  //
  // A change that makes the domain unsolvable - sealing the only outlet while
  // an inlet runs - is refused by assertRegionsAreSolvable on the next step,
  // which is the same machinery that refuses it in a scenario definition.
  setBoundary(side, condition) {
    this.boundaries.setSide(side, condition);
    return true;
  }

  undoBoundary() { return this.boundaries.undo(); }
  redoBoundary() { return this.boundaries.redo(); }

  // Whether the domain is still the scenario's own.
  //
  // Asked of the sampled MASK, not of the edit count or of the document. Those
  // are proxies and both are wrong in an ordinary case: a document edited and
  // undone back has a nonzero revision and an identical domain, and two
  // different documents can sample to the same cells. The mask is what the
  // solver reads and what a validation record describes, so the mask is what
  // gets compared.
  #sameDomainAsScenario() {
    const pristine = sampleDocument(this.pristineGeometry, this.scenario.grid);
    const current = this.scenario.grid.solid;
    if (pristine.length !== current.length) return false;
    for (let k = 0; k < pristine.length; k++) {
      if (pristine[k] !== current[k]) return false;
    }
    return true;
  }

  // True when the mask has moved since the field was built. Asked of the grid
  // rather than of any record of user actions, so a mask changed by any route
  // counts.
  get fieldIsStale() {
    return this.scenario.grid.maskVersion !== this.maskVersionAtReset;
  }

  // Every geometry change goes through here, so there is one place where the
  // run is stopped and the field rebuilt.
  #edit(mutate) {
    const changed = mutate();
    if (changed === false) return false;
    this.running = false;
    this.reset();
    return true;
  }

  applyEdit(operation) { return this.#edit(() => this.editor.append(operation) && true); }
  replaceEdit(index, operation) { return this.#edit(() => this.editor.replace(index, operation) && true); }
  removeEdit(index) { return this.#edit(() => this.editor.remove(index) && true); }
  clearGeometry() { return this.#edit(() => this.editor.clear() && true); }
  undo() { return this.#edit(() => this.editor.undo()); }
  redo() { return this.#edit(() => this.editor.redo()); }

  // One solver step, with the timestep chosen from the field as it stands.
  // Refuses outright if the geometry has moved underneath it.
  advance() {
    if (this.fieldIsStale) {
      throw new StaleFieldError(
        `the geometry changed after this field was built (mask version ` +
        `${this.maskVersionAtReset} -> ${this.scenario.grid.maskVersion}), so the field ` +
        `describes a domain that no longer exists. Call reset() to rebuild it. The field ` +
        `is not repaired in place because a domain that changes shape mid-flow is a ` +
        `moving-boundary problem, which this fixed-grid solver does not model - see the ` +
        `note at the top of scenarios/session.js.`
      );
    }

    const { grid, params, timestep } = this.scenario;
    const bc = this.bc;
    const sources = this.sources;
    const selection = computeStableTimestep(grid, {
      nu: params.nu,
      safety: timestep.safety,
      previousTimestep: this.lastTimestep,
      // A momentum source can leave the fluid moving at its target by the end
      // of this step, and the field does not know that yet. Sized against it
      // here so the step after this one is not the one that finds out.
      incomingSpeed: sourcePlanFor(grid, sources).maxTargetCflSpeed,
    });
    this.lastTimestep = selection.dt;
    this.lastSelection = selection;
    // `sources` lives on the scenario beside `bc`, because it is a description
    // of the domain rather than a property of the fluid - and it has to be
    // threaded through here explicitly. It was not, at first: the harness
    // compiled a plan from scenario.sources to draw with while step() received
    // params alone and saw no sources at all. The panel then reported a
    // continuity error of 3.20e-1 next to a raw divergence of 7.8e-8, which is
    // the signature of a source that is being displayed and not applied.
    this.lastStep = step(grid, bc, { ...params, dt: selection.dt, sources });
    this.iteration++;
    this.simulatedTime += selection.dt;
    this.lastTracer = this.tracer.advect(grid, bc, selection.dt, {
      inject: this.tracerConfig.inject,
      // The dye a source carries is read here and nowhere below the display
      // layer: sources/ never looks at it, which tests/test9 enforces.
      sources,
    });
    return this.lastStep;
  }

  // Switching scenario keeps nothing: a document drawn against one domain has
  // no meaning in another of a different size and shape.
  load(scenarioId) {
    this.scenarioId = scenarioId;
    const scenario = buildScenario(scenarioId);
    this.pristineGeometry = scenario.geometry;
    this.editor = new GeometryEditor(this.pristineGeometry);
    // Rebuilt only on a scenario change. A geometry edit calls reset(), and
    // boundary edits must survive that: they describe the same four sides of
    // the same domain, and discarding them because a wall moved would lose
    // work for no reason.
    this.boundaries = this.#makeBoundaryEditor(scenario);
    // Sources describe places in a particular domain, so a scenario change
    // discards them exactly as it discards a geometry document.
    this.placedSources = scenario.sources ?? [];
    this.brushSource = null;
    this.#rebuildSources();
    return this.reset();
  }
}
