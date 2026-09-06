// Compiles a source specification into what the solver reads every step.
//
// Same shape as boundaries/compile.js, deliberately: per-face and per-cell
// Int32Arrays holding an index into a deduplicated table, so the inner loop
// does one array read rather than a scan over a list, and the UI draws from the
// same arrays the solver reads instead of re-deriving them.
//
// ---------------------------------------------------------------------------
// WHERE A SOURCE IS SAMPLED
// ---------------------------------------------------------------------------
//
// Not everywhere at cell centres. On a staggered grid the three quantities live
// in three different places, and a source has to be sampled where the thing it
// drives actually lives:
//
//   momentum, x   u faces:  x = i*h,        y = (j-0.5)*h
//   momentum, y   v faces:  x = (i-0.5)*h,  y = j*h
//   mass          cells:    x = (i-0.5)*h,  y = (j-0.5)*h
//
// M5 step 4 found this the hard way on surface selectors: a narrow band drawn
// around a cell boundary selects faces of one orientation and none of the
// other, because the two face families are offset by half a cell in different
// directions. A source sampled at cell centres and applied to faces would be
// half a cell out everywhere, which looks like slightly sloppy placement rather
// than like a bug.
//
// ---------------------------------------------------------------------------
// A SELECTION THAT CATCHES NOTHING IS AN ERROR
// ---------------------------------------------------------------------------
//
// Counted over the faces and cells the solver would ACTUALLY update - interior,
// not adjacent to solid - rather than over everything the region covers. Those
// differ: a region drawn inside a wall covers plenty of cells and drives none
// of them.
//
// This project has now produced four separate bugs whose shape is "a thing that
// silently does nothing because a filter and the property of interest came
// apart". A source is a particularly bad place for a fifth, because the user's
// only evidence is that the flow did not change - indistinguishable from a
// source that is too weak. So it is rejected, loudly, with the count that was
// found and where to look.

import { testRegion } from "../geometry/document.js";
import { SOURCE_KINDS, SourceSpecError, validateSource } from "./kinds.js";

// Interns a condition so identical sources share one table row and the UI lists
// each distinct one once.
//
// The key is built from EVERY property, sorted. It was a hand-written field
// list in M4's boundary compiler, and when `pressure` arrived carrying its own
// `p` the list did not know about it: both ends of a channel hashed to the same
// key, merged into one condition, and the run settled at exactly zero flow
// having converged in four iterations with nothing that looked wrong. A key
// that has to be updated whenever a parameter is added will eventually not be.
function internKey(entry) {
  return JSON.stringify(
    Object.keys(entry).sort().map((field) => [field, entry[field]])
  );
}

class Table {
  constructor() {
    this.rows = [];
    this.byKey = new Map();
  }
  intern(entry) {
    const key = internKey(entry);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const index = this.rows.length;
    this.rows.push(entry);
    this.byKey.set(key, index);
    return index;
  }
}

// The u faces the momentum equation actually solves: interior in x, and with
// fluid on both sides. Exactly the guard computeIntermediateVelocities uses, so
// "selected" and "updated" cannot come apart.
function eachSolvedUFace(grid, visit) {
  const { nx, ny, h, solid } = grid;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx - 1; i++) {
      const k = grid.idx(i, j);
      if (solid[k] || solid[grid.idx(i + 1, j)]) continue;
      visit(k, i * h, (j - 0.5) * h);
    }
  }
}

function eachSolvedVFace(grid, visit) {
  const { nx, ny, h, solid } = grid;
  for (let i = 1; i <= nx; i++) {
    for (let j = 1; j <= ny - 1; j++) {
      const k = grid.idx(i, j);
      if (solid[k] || solid[grid.idx(i, j + 1)]) continue;
      visit(k, (i - 0.5) * h, j * h);
    }
  }
}

function eachFluidCell(grid, visit) {
  const { nx, ny, h, solid } = grid;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = grid.idx(i, j);
      if (solid[k]) continue;
      visit(k, (i - 0.5) * h, (j - 0.5) * h);
    }
  }
}

function emptySelection(where, what, hint) {
  throw new SourceSpecError(
    `${where}: this source selects no ${what} at all. Its region does not cover ` +
    `any part of the domain the solver would update, so it would sit in the ` +
    `specification doing nothing - which is far harder to notice than being ` +
    `told. ${hint}`,
    { reason: "empty-selection" }
  );
}

export function compileSources(grid, sources) {
  const list = sources ?? [];
  if (!Array.isArray(list)) {
    throw new SourceSpecError(
      `sources must be an array, got ${typeof list}. One array in specification ` +
      `order, because later sources are meant to be listed after earlier ones ` +
      `and an object would not preserve that.`
    );
  }

  const size = (grid.nx + 2) * (grid.ny + 2);
  const momentumU = new Int32Array(size).fill(-1);
  const momentumV = new Int32Array(size).fill(-1);
  const massCells = new Int32Array(size).fill(-1);
  const momentumTable = new Table();
  const massTable = new Table();

  let momentumCount = 0;
  let massCount = 0;
  let maxTargetSpeed = 0;
  const attachments = [];

  list.forEach((source, index) => {
    const where = `sources[${index}]`;
    validateSource(source, where);
    const kind = SOURCE_KINDS[source.kind];

    if (source.kind === "momentum") {
      const row = momentumTable.intern({
        u: source.u,
        v: source.v,
        relaxationTime: source.relaxationTime,
      });
      let uFaces = 0;
      let vFaces = 0;
      eachSolvedUFace(grid, (k, x, y) => {
        if (!testRegion(source.where, x, y)) return;
        momentumU[k] = row;
        uFaces++;
      });
      eachSolvedVFace(grid, (k, x, y) => {
        if (!testRegion(source.where, x, y)) return;
        momentumV[k] = row;
        vFaces++;
      });

      // Both families are required, not just a non-zero total. A momentum
      // source states both components, so a region catching u faces and no v
      // faces would drive one component and quietly abandon the other - the
      // same shape of half-applied condition, one level down.
      if (uFaces === 0 || vFaces === 0) {
        emptySelection(
          where,
          uFaces === 0 && vFaces === 0 ? "velocity faces"
            : uFaces === 0 ? "x-velocity faces" : "y-velocity faces",
          `Found ${uFaces} x-faces and ${vFaces} y-faces. On a staggered grid the ` +
          `two families are offset by half a cell in different directions, so a ` +
          `region thinner than a cell can catch one and miss the other - widen it, ` +
          `or move it off the solid it is sitting in.`
        );
      }
      momentumCount++;
      maxTargetSpeed = Math.max(maxTargetSpeed, kind.targetSpeed(source));
      attachments.push({
        index, kind: source.kind, label: source.label ?? null,
        uFaces, vFaces, cells: 0, targetSpeed: kind.targetSpeed(source),
      });
      return;
    }

    // Mass. `rate` is the TOTAL volumetric rate over the selection, spread
    // evenly across the cells it caught - the same convention flowInlet uses
    // for a total flow rate spread over faces, so the two read alike. The
    // per-cell divergence it forces is therefore rate / (cells * h^2), which
    // needs the count and so is computed in a second pass.
    const cells = [];
    eachFluidCell(grid, (k, x, y) => {
      if (testRegion(source.where, x, y)) cells.push(k);
    });
    if (cells.length === 0) {
      emptySelection(
        where, "fluid cells",
        `The region covers no fluid - it may be entirely inside a solid, or ` +
        `outside the domain.`
      );
    }
    const row = massTable.intern({
      // Stored as the per-cell divergence the solver will impose, so the
      // conversion from a total rate happens once here rather than every step.
      q: source.rate / (cells.length * grid.h * grid.h),
      rate: source.rate,
      cells: cells.length,
    });
    for (const k of cells) massCells[k] = row;
    massCount++;
    attachments.push({
      index, kind: source.kind, label: source.label ?? null,
      uFaces: 0, vFaces: 0, cells: cells.length, targetSpeed: 0,
    });
  });

  return {
    // Null rather than an empty structure when a kind is unused, so the solver
    // can branch once instead of reading a table of zeros per face. The
    // no-sources case has to cost nothing and change nothing.
    momentum: momentumCount === 0
      ? null
      : { u: momentumU, v: momentumV, table: momentumTable.rows },
    mass: massCount === 0
      ? null
      : { cells: massCells, table: massTable.rows },
    count: list.length,
    momentumCount,
    massCount,
    maxTargetSpeed,
    attachments,
    nx: grid.nx,
    ny: grid.ny,
    h: grid.h,
    maskVersion: grid.maskVersion,
  };
}

export function isSourcePlan(value) {
  return Boolean(value) && typeof value === "object"
    && "momentum" in value && "mass" in value && "attachments" in value;
}

function planMatchesGrid(plan, grid) {
  return plan.nx === grid.nx && plan.ny === grid.ny
    && plan.h === grid.h && plan.maskVersion === grid.maskVersion;
}

// Cached against the specification object, and against the mask version too: a
// source's selection is a function of the geometry, so an edit that moves a
// wall moves which faces the source drives.
const planCache = new WeakMap();

export function sourcePlanFor(grid, sources) {
  if (sources === undefined || sources === null) return compileSources(grid, []);
  if (isSourcePlan(sources)) {
    if (!planMatchesGrid(sources, grid)) {
      throw new SourceSpecError(
        `this source plan was compiled for a ${sources.nx}x${sources.ny} grid at ` +
        `mask version ${sources.maskVersion}, not ${grid.nx}x${grid.ny} at ` +
        `${grid.maskVersion}`
      );
    }
    return sources;
  }
  const cached = planCache.get(sources);
  if (cached && planMatchesGrid(cached, grid)) return cached;
  const plan = compileSources(grid, sources);
  planCache.set(sources, plan);
  return plan;
}

// What the UI lists. Derived from the compiled plan rather than from the
// specification, so what is shown is what is applied.
export function sourceLegend(plan, sources) {
  return plan.attachments.map((a) => ({
    ...a,
    source: sources[a.index],
  }));
}
