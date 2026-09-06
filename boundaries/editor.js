// Editing a boundary specification, with undo and redo.
//
// Same shape as geometry/editor.js - snapshot history, a revision counter, one
// place where every change is validated - but the rule for what happens to the
// FIELD is the opposite, and that is not a matter of taste. It was measured.
//
// ---------------------------------------------------------------------------
// A BOUNDARY EDIT KEEPS THE FIELD. A GEOMETRY EDIT DOES NOT.
// ---------------------------------------------------------------------------
//
// A geometry edit changes which cells exist, so the field describes a domain
// that is gone and has to be rebuilt. A boundary edit changes only how the
// edges of a domain that still exists are treated. The field remains a valid
// state of the fluid, and the change is a real physical event - opening a
// valve, turning a pump up - that the solver is entitled to march through.
//
// Measured on a settled channel (peak 1.4085, max|div u| 9.99e-8), 120 steps
// after the change:
//
//   wall -> inflow, opening a valve      max|div u| 1.00e-7   CFL 0.595   runs
//   inlet 1 -> 4, turning a pump up      max|div u| 9.98e-8   CFL 0.948   runs
//   inlet -> wall, closing the inlet     max|div u| 1.00e-7   CFL 0.217   runs
//   wall -> free-slip                    max|div u| 9.99e-8   CFL 0.293   runs
//   outlet -> wall, sealing the domain   rejected: SolverGeometryError
//
// Every legitimate change holds the divergence bound with no restart, and the
// one illegitimate change is refused by the detector that already exists. So
// there is no new rule here and no reason to discard a running flow.
//
// ---------------------------------------------------------------------------
// WHY EVERY EDIT RETURNS A NEW, FROZEN OBJECT
// ---------------------------------------------------------------------------
//
// boundaryPlanFor caches compiled plans in a WeakMap keyed on the
// specification object, and the cache-validity check compares grid dimensions
// and mask version - not the contents of the specification. Mutating a spec in
// place therefore returns the STALE plan, silently:
//
//   const before = boundaryPlanFor(grid, bc);   // left inflow u = 1
//   bc.left.u = 7;
//   const after  = boundaryPlanFor(grid, bc);   // still u = 1, same object
//
// Measured exactly that, before this file existed. An editor that mutated in
// place would leave the solver running the previous boundary condition with
// nothing to say so, and the only evidence would be a flow that did not change
// - the same signature as the source that was displayed and never applied.
//
// So every edit produces a new object, and the objects handed out are frozen.
// Freezing turns the mistake from a silent stale plan into a TypeError at the
// point it is made, which is a defence rather than a convention.

import { BOUNDARY_TYPES, SIDES, isKnownType } from "./conditions.js";

export class BoundaryEditError extends Error {
  constructor(message) {
    super(message);
    this.name = "BoundaryEditError";
  }
}

function freezeSpec(spec) {
  for (const side of SIDES) {
    const entry = spec[side];
    if (Array.isArray(entry)) {
      entry.forEach((segment) => Object.freeze(segment));
      Object.freeze(entry);
    } else if (entry && typeof entry === "object") {
      Object.freeze(entry);
    }
  }
  if (Array.isArray(spec.surfaces)) {
    spec.surfaces.forEach((s) => Object.freeze(s));
    Object.freeze(spec.surfaces);
  }
  return Object.freeze(spec);
}

// A deep-enough copy that the result shares no mutable object with the input.
function copySpec(spec) {
  const next = {};
  for (const [key, value] of Object.entries(spec)) {
    if (Array.isArray(value)) next[key] = value.map((entry) => ({ ...entry }));
    else if (value && typeof value === "object") next[key] = { ...value };
    else next[key] = value;
  }
  return next;
}

export class BoundaryEditor {
  // `validate` is called with a candidate specification before it is recorded.
  // The session passes one that compiles it against the real grid, so an
  // invalid edit is refused with the compiler's own message rather than
  // surfacing as a NaN sixty steps later. Without one, only the shape of the
  // specification is checked.
  constructor(spec, validate = null) {
    this.validate = validate;
    this.#assertShape(spec);
    this.spec = freezeSpec(copySpec(spec));
    this.past = [];
    this.future = [];
    this.revision = 0;
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  #assertShape(spec) {
    if (!spec || typeof spec !== "object") {
      throw new BoundaryEditError(`expected a boundary specification, got ${spec}`);
    }
    for (const side of SIDES) {
      const entry = spec[side];
      if (entry === undefined) {
        throw new BoundaryEditError(`the specification has no "${side}" side`);
      }
      const segments = Array.isArray(entry) ? entry : [entry];
      for (const condition of segments) {
        if (!isKnownType(condition?.type)) {
          throw new BoundaryEditError(
            `${side}: unknown boundary type "${condition?.type}". ` +
            `Known types: ${Object.keys(BOUNDARY_TYPES).join(", ")}`
          );
        }
      }
    }
  }

  // Every change goes through here: validated once, recorded once, and handed
  // back frozen so the caller cannot edit it into disagreement with the plan
  // the solver compiled from it.
  #commit(next) {
    this.#assertShape(next);
    if (this.validate) this.validate(next);
    this.past.push(this.spec);
    this.future.length = 0;
    this.spec = freezeSpec(next);
    this.revision++;
    return this;
  }

  // Replaces one whole side. Segments are a later feature of the same call:
  // pass an array and it is a segmented side, exactly as the compiler reads it.
  setSide(side, condition) {
    if (!SIDES.includes(side)) {
      throw new BoundaryEditError(`unknown side "${side}". Sides: ${SIDES.join(", ")}`);
    }
    const next = copySpec(this.spec);
    next[side] = Array.isArray(condition)
      ? condition.map((segment) => ({ ...segment }))
      : { ...condition };
    return this.#commit(next);
  }

  undo() {
    if (!this.canUndo) return false;
    this.future.push(this.spec);
    this.spec = this.past.pop();
    this.revision++;
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.past.push(this.spec);
    this.spec = this.future.pop();
    this.revision++;
    return true;
  }
}

// The fields a side's condition needs, so a UI can ask for exactly those rather
// than showing every parameter for every type. Derived from the type table, so
// a new type or a new parameter appears here without anyone remembering to add
// it - the M4 dedup key's lesson applied to the form.
export function fieldsFor(type, side) {
  const spec = BOUNDARY_TYPES[type];
  if (!spec) throw new BoundaryEditError(`unknown boundary type "${type}"`);
  return {
    required: spec.required?.(side) ?? [],
    optional: spec.optional?.(side) ?? [],
    label: spec.label,
    family: spec.family,
    summary: spec.summary,
  };
}
