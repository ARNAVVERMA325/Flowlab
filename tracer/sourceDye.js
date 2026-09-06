// Dye released by a source.
//
// This lives in tracer/ and nowhere else, and that placement is the whole
// point. A source may carry a `dye` value; sources/compile.js reads `op`,
// `where` and the physical parameters and never looks at it, so the compiled
// plan the solver reads cannot contain it. tests/test9 enforces that
// structurally - solver/, geometry/, physics/, scenarios/, sources/ and
// boundaries/ are checked for any reference to the dye at all - which is why
// the cell selection below is computed here rather than added to the source
// compiler where it would have been convenient.
//
// The rule it protects: deleting tracer/ must leave the simulation bit for bit
// unchanged. A source with dye and the same source without it must produce the
// same flow, and tests/test13 asserts exactly that.
//
// ---------------------------------------------------------------------------
// WHAT INJECTION MEANS HERE
// ---------------------------------------------------------------------------
//
// A boundary injector sets a ghost concentration and lets advection carry it
// in. A source is in the interior, so there is no ghost to set: the dye is
// added to the cells the source covers, at a rate, after the flow has been
// advected. `dye` is a concentration per unit time, so what a cell receives in
// a step is dye*dt and the result is independent of the timestep.
//
// Clamped to the tracer's own ceiling rather than accumulating without bound.
// Dye is a visualization aid with a fixed colour scale; a cell allowed to run
// to 10^6 would flatten the scale for everything else and show nothing.

import { testRegion } from "../geometry/document.js";

// The cells each dye-carrying source covers. Cached against the source array
// and the mask version, the same way the compiled plans are: the selection is a
// function of the geometry, so a wall that moves moves it.
const cache = new WeakMap();

export function dyeSourcesFor(grid, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const cached = cache.get(sources);
  if (cached && cached.maskVersion === grid.maskVersion
      && cached.nx === grid.nx && cached.ny === grid.ny) {
    return cached.entries.length === 0 ? null : cached;
  }

  const entries = [];
  for (const source of sources) {
    if (!Number.isFinite(source?.dye) || source.dye === 0) continue;
    const cells = [];
    for (let j = 1; j <= grid.ny; j++) {
      for (let i = 1; i <= grid.nx; i++) {
        const k = grid.idx(i, j);
        if (grid.solid[k]) continue;
        const { x, y } = grid.cellCentre(i, j);
        if (testRegion(source.where, x, y)) cells.push(k);
      }
    }
    // A dye source covering no fluid is not an error the way a momentum source
    // is - it releases dye nowhere, which is visible as nothing happening and
    // costs no correctness. It is simply skipped.
    if (cells.length > 0) entries.push({ dye: source.dye, cells });
  }

  const record = {
    entries, maskVersion: grid.maskVersion, nx: grid.nx, ny: grid.ny,
  };
  cache.set(sources, record);
  return entries.length === 0 ? null : record;
}

// Adds dye*dt to every cell the dye-carrying sources cover, clamped.
// Returns what was added, so the panel can report it rather than implying dye
// appears from nowhere.
export function injectSourceDye(tracer, grid, sources, dt, ceiling) {
  const record = dyeSourcesFor(grid, sources);
  if (record === null) return { added: 0, cells: 0 };

  let added = 0;
  let touched = 0;
  for (const entry of record.entries) {
    const amount = entry.dye * dt;
    for (const k of entry.cells) {
      const before = tracer.c[k];
      const after = Math.min(ceiling, before + amount);
      added += after - before;
      touched++;
      tracer.c[k] = after;
    }
  }
  return { added, cells: touched };
}
