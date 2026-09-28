// The preconditioned pressure solve (docs/pressure-preconditioner.md).
//
// A solver change is held to two standards at once. The new solve must be a
// solve of the SAME equations - so, taken to a tight tolerance, it must land
// on the same pressure as plain CG in every geometry the app has, including
// the awkward ones: prescribed pressures, drawn bodies, a sealed chamber that
// makes a second singular region. And the reference solve must be untouched -
// which the original golden fields, still pinned to "cg", check byte for byte
// in tests/test10 and tests/test13. The preconditioner itself is checked
// directly: an incomplete factorisation is only a valid PCG preconditioner if
// it is symmetric and positive definite, and that is asserted, not assumed.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { StaggeredGrid } from "../geometry/grid.js";
import { applyDocument } from "../geometry/document.js";
import { TOOLS } from "../geometry/editor.js";
import { step, boundaryPlanFor, computeContinuityError, __testing } from "../solver/ns2d.js";
import { sourcePlanFor } from "../sources/compile.js";
import { SimulationSession } from "../ui/session.js";
import { SCENARIOS } from "../scenarios/index.js";
import { fluidRegions } from "../geometry/regions.js";
import { FIXTURE_CASES, measureFixtureCase } from "./support/boundaryFixtures.js";

const { scratchFor, micPreconditioner, applyMic } = __testing;

// Every session here asks for the preconditioned solve by name, so these
// tests keep testing it whatever the default becomes.
function pcg(session) {
  session.scenario.params = { ...session.scenario.params, pressureSolver: "mic-pcg" };
  return session;
}

// Deterministic pseudo-random numbers, so a failure reproduces.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

// A cavity with a sealed square chamber drawn inside it: two fluid regions,
// each with its own constant null space.
function chamberSession() {
  const session = new SimulationSession("cavity");
  session.applyEdit(TOOLS.rectangle(0.3, 0.3, 0.7, 0.7));
  session.applyEdit({ op: "subtract", region: { kind: "rect", x0: 0.35, y0: 0.35, x1: 0.65, y1: 0.65 } });
  return session;
}

function geometries() {
  const list = SCENARIOS.map(({ id }) => ({ id, session: new SimulationSession(id) }));
  list.push({ id: "cavity + sealed chamber", session: chamberSession() });
  const drawn = new SimulationSession("jet");
  drawn.applyEdit(TOOLS.circle(2, 0.5, 0.2));
  list.push({ id: "jet + drawn body", session: drawn });
  return list;
}

test("the default is the preconditioned solve, CG is selectable, and an unknown one is refused", () => {
  const session = new SimulationSession("cavity");
  session.advance();
  assert.equal(session.lastStep.pressureSolver, "mic-pcg");
  assert.equal(session.lastStep.preconditionerFallback, false);
  const reference = new SimulationSession("cavity");
  reference.scenario.params = { ...reference.scenario.params, pressureSolver: "cg" };
  reference.advance();
  assert.equal(reference.lastStep.pressureSolver, "cg");
  const grid = new StaggeredGrid(4, 4, 0.25);
  const bc = { left: { type: "wall" }, right: { type: "wall" }, top: { type: "wall", u: 1 }, bottom: { type: "wall" } };
  assert.throws(() => step(grid, bc, { nu: 0.1, rho: 1, dt: 0.01, pressureSolver: "multigrid" }), /unknown pressure solver/);
});

test("the MIC(0) factor is finite, positive and symmetric in every geometry", () => {
  for (const { id, session } of geometries()) {
    const { grid, bc } = session;
    const { cells } = scratchFor(grid, boundaryPlanFor(grid, bc));
    const precon = micPreconditioner(grid, cells);
    const size = grid.u.length;
    for (const k of cells.fluid) {
      if (cells.counts[k] === 0) continue;
      assert.ok(Number.isFinite(precon[k]) && precon[k] > 0, `${id}: pivot at ${k} is ${precon[k]}`);
    }
    const rnd = random(7);
    const vector = () => {
      const v = new Float64Array(size);
      for (const k of cells.fluid) v[k] = rnd();
      return v;
    };
    const solve = (v) => {
      const out = new Float64Array(size);
      applyMic(grid, cells, precon, v, out, new Float64Array(size));
      return out;
    };
    const dot = (a, b) => cells.fluid.reduce((t, k) => t + a[k] * b[k], 0);
    for (let trial = 0; trial < 5; trial++) {
      const x = vector();
      const y = vector();
      const Mx = solve(x);
      const My = solve(y);
      assert.ok(dot(x, Mx) > 0, `${id}: x.M^-1 x must be positive`);
      const a = dot(y, Mx);
      const b = dot(x, My);
      assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b), 1), `${id}: M^-1 not symmetric (${a} vs ${b})`);
    }
  }
});

test("taken to a tight tolerance, both solves land on the same flow in every geometry", () => {
  // Same state, one step each, with the continuity bound tightened to 1e-12
  // so both solves are forced far past where their paths differ. What is left
  // is the difference between the SOLUTIONS - which must be rounding.
  for (const { id, session } of geometries()) {
    for (let n = 0; n < 5; n++) session.advance();
    const results = {};
    for (const solver of ["cg", "mic-pcg"]) {
      const grid = new StaggeredGrid(session.grid.nx, session.grid.ny, session.grid.h);
      grid.solid.set(session.grid.solid);
      grid.maskVersion = session.grid.maskVersion;
      grid.u.set(session.grid.u);
      grid.v.set(session.grid.v);
      grid.p.set(session.grid.p);
      const report = step(grid, session.bc, {
        ...session.scenario.params,
        dt: session.lastTimestep,
        sources: session.sources,
        divergenceTol: 1e-12,
        poissonMaxIterations: 100000,
        pressureSolver: solver,
      });
      assert.equal(report.poissonConverged, true, `${id} ${solver} converged`);
      results[solver] = { grid, iterations: report.poissonIterations };
    }
    let du = 0;
    let peak = 0;
    const a = results.cg.grid;
    const b = results["mic-pcg"].grid;
    for (let k = 0; k < a.u.length; k++) {
      du = Math.max(du, Math.abs(a.u[k] - b.u[k]), Math.abs(a.v[k] - b.v[k]));
      peak = Math.max(peak, Math.abs(a.u[k]), Math.abs(a.v[k]));
    }
    assert.ok(du <= 1e-9 * Math.max(peak, 1), `${id}: the two solves differ by ${du} against a peak of ${peak}`);
    assert.ok(results["mic-pcg"].iterations < results.cg.iterations, `${id}: ${results["mic-pcg"].iterations} vs ${results.cg.iterations} iterations`);
  }
});

test("at the app's own tolerance the fields differ only at the level the bound allows", () => {
  // One step from an identical state: two solves that both stop below the
  // same residual bound give pressures that differ within that bound.
  for (const id of ["cavity", "cylinder", "bend-sharp"]) {
    const a = new SimulationSession(id);
    const b = new SimulationSession(id);
    for (let n = 0; n < 10; n++) {
      a.advance();
      b.advance();
    }
    pcg(b);
    a.advance();
    b.advance();
    let du = 0;
    let peak = 0;
    for (let k = 0; k < a.grid.u.length; k++) {
      du = Math.max(du, Math.abs(a.grid.u[k] - b.grid.u[k]));
      peak = Math.max(peak, Math.abs(a.grid.u[k]));
    }
    assert.ok(du / peak < 1e-6, `${id}: ${du / peak} relative after one step`);
    assert.ok(a.lastStep.continuityError <= 1e-7 && b.lastStep.continuityError <= 1e-7);
  }
});

test("every region keeps its own gauge, and a sealed pocket stays exactly still", () => {
  // The first version projected out one global constant, as plain CG does. It
  // failed the M5 region tests: MIC(0) does not map a constant to a constant,
  // so each sealed region's own constant drifted (a region mean of -0.209) and
  // a pocket that must be exactly still moved at 2.9e-18. Kept here for the
  // preconditioned solve specifically, including the mixed case M5 does not
  // cover: a region with a prescribed pressure beside one without.
  const regionMeans = (session) => {
    const { label, count } = fluidRegions(session.grid);
    const sums = new Float64Array(count);
    const sizes = new Float64Array(count);
    for (let k = 0; k < label.length; k++) {
      if (label[k] < 0) continue;
      sums[label[k]] += session.grid.p[k];
      sizes[label[k]]++;
    }
    return { means: Array.from(sums, (x, r) => x / sizes[r]), label, sizes };
  };

  const chamber = pcg(chamberSession());
  for (let n = 0; n < 60; n++) chamber.advance();
  const { means } = regionMeans(chamber);
  assert.equal(means.length, 2);
  for (const mean of means) assert.ok(Math.abs(mean) < 1e-9, `region mean pressure ${mean}`);

  // Pressure-driven channel with a sealed pocket cut into a drawn block: the
  // channel's pressure is absolute (prescribed at both ends), the pocket's is
  // a gauge of its own.
  const mixed = new SimulationSession("pressure-channel");
  mixed.applyEdit(TOOLS.rectangle(2, 0.25, 3, 0.75));
  mixed.applyEdit({ op: "subtract", region: { kind: "rect", x0: 2.2, y0: 0.35, x1: 2.8, y1: 0.65 } });
  pcg(mixed);
  for (let n = 0; n < 60; n++) mixed.advance();
  const regions = regionMeans(mixed);
  assert.equal(regions.means.length, 2);
  const pocket = regions.sizes[0] < regions.sizes[1] ? 0 : 1;
  assert.ok(Math.abs(regions.means[pocket]) < 1e-9, `pocket mean pressure ${regions.means[pocket]}`);
  let still = 0;
  for (let k = 0; k < regions.label.length; k++) {
    if (regions.label[k] !== pocket) continue;
    still = Math.max(still, Math.abs(mixed.grid.u[k]), Math.abs(mixed.grid.v[k]));
  }
  assert.equal(still, 0, "the sealed pocket carries no velocity at all");
  assert.equal(mixed.lastStep.pressureSolver, "mic-pcg");

  // And a pocket in a domain whose pressure is a gauge everywhere (inlet,
  // outlet, no prescribed pressure): here the global residual projection DOES
  // put a rounding-level constant into the pocket, and only the exact-constant
  // rule keeps it at exactly zero (2.0e-33 without it). The M5 pocket test
  // covers this for plain CG.
  const gauged = new SimulationSession("jet");
  gauged.applyEdit(TOOLS.rectangle(2, 0.2, 3, 0.8));
  gauged.applyEdit({ op: "subtract", region: { kind: "rect", x0: 2.2, y0: 0.35, x1: 2.8, y1: 0.65 } });
  pcg(gauged);
  for (let n = 0; n < 60; n++) gauged.advance();
  const inJet = regionMeans(gauged);
  assert.equal(inJet.means.length, 2);
  const jetPocket = inJet.sizes[0] < inJet.sizes[1] ? 0 : 1;
  let jetStill = 0;
  for (let k = 0; k < inJet.label.length; k++) {
    if (inJet.label[k] !== jetPocket) continue;
    jetStill = Math.max(jetStill, Math.abs(gauged.grid.u[k]), Math.abs(gauged.grid.v[k]));
  }
  assert.equal(jetStill, 0, "a pocket in a gauge domain carries no velocity at all");
});

test("a NaN pressure fails the step under either solver - it is never repaired", () => {
  // The preconditioned solve's first exact-constant rule set a region of NaN
  // to zero: the step returned normally with a clean field. Both solvers must
  // throw, exactly as plain CG always has.
  for (const solver of ["cg", "mic-pcg"]) {
    for (const make of [() => new SimulationSession("cavity"), chamberSession]) {
      const session = make();
      session.scenario.params = { ...session.scenario.params, pressureSolver: solver };
      for (let n = 0; n < 3; n++) session.advance();
      session.grid.p.fill(NaN);
      assert.throws(() => session.advance(), /non-finite/, `${solver}: a NaN pressure must stop the step`);
    }
  }
});

test("the reported continuity error stays the true one, even in a region that cannot balance", () => {
  // The first per-region version projected the RESIDUAL per region, which
  // strips out exactly the part an unsolvable region cannot lose: it reported
  // convergence and let the M6 split-chamber source run. The residual is now
  // projected as plain CG projects it; this checks the consequence directly.
  const n = 24;
  const h = 1 / n;
  const nu = 0.01;
  const box = { left: { type: "wall" }, right: { type: "wall" }, top: { type: "wall" }, bottom: { type: "wall" } };
  const sources = [
    { kind: "mass", where: { kind: "rect", x0: 0.1, y0: 0.4, x1: 0.25, y1: 0.6 }, rate: 0.05 },
    { kind: "mass", where: { kind: "rect", x0: 0.75, y0: 0.4, x1: 0.9, y1: 0.6 }, rate: -0.05 },
  ];
  const chambers = () => {
    const grid = new StaggeredGrid(n, n, h);
    applyDocument(grid, { operations: [{ op: "add", region: { kind: "rect", x0: 0.46, y0: 0, x1: 0.54, y1: 1 } }] });
    return grid;
  };
  const params = { nu, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / nu, h / 4), poissonMaxIterations: 20000, sources, pressureSolver: "mic-pcg" };

  // A meaningful bound - tighter than the 1.091e-1 the configuration forces -
  // is refused, as it always was.
  assert.throws(() => step(chambers(), box, { ...params, divergenceTol: 1e-7 }));

  // At a bound looser than that, the step runs, and what it REPORTS is what
  // the field has: the reported continuity error against one measured from
  // the velocities, and both at the level the imbalance forces.
  const grid = chambers();
  const report = step(grid, box, { ...params, divergenceTol: 1 });
  const measured = computeContinuityError(grid, sourcePlanFor(grid, sources)).max;
  assert.ok(Math.abs(report.continuityError - measured) <= 1e-9 * measured,
    `reported ${report.continuityError} against measured ${measured}`);
  assert.ok(measured > 0.1, `the imbalance is visible in the report: ${measured}`);
});

test("the preconditioned solve cuts the iterations it exists to cut", () => {
  // A performance guard, not a correctness one: measured 4.8-6.3x fewer on
  // every scenario with a real solve. Asserted at 3x so it flags a regression
  // rather than noise.
  for (const id of ["cavity", "cylinder", "bend-sharp", "bend-smooth", "jet"]) {
    const counts = {};
    for (const solver of ["cg", "mic-pcg"]) {
      const s = new SimulationSession(id);
      s.scenario.params = { ...s.scenario.params, pressureSolver: solver };
      let total = 0;
      for (let n = 0; n < 20; n++) {
        s.advance();
        total += s.lastStep.poissonIterations;
      }
      counts[solver] = total;
    }
    assert.ok(counts.cg >= 3 * counts["mic-pcg"], `${id}: ${counts.cg} -> ${counts["mic-pcg"]}`);
  }
});

test("a broken preconditioner falls back to plain CG, says so, and still meets the bound", () => {
  const session = pcg(new SimulationSession("cavity"));
  session.advance();
  const { cells } = scratchFor(session.grid, boundaryPlanFor(session.grid, session.bc));
  cells.work.precon.fill(NaN);
  session.advance();
  assert.equal(session.lastStep.preconditionerFallback, true);
  assert.equal(session.lastStep.poissonConverged, true);
  assert.ok(session.lastStep.continuityError <= 1e-7);
  // Rebuilt on the next mask change; here, restore it for any later user.
  cells.work.precon = null;
});

test("the preconditioned solve has its own golden record, byte for byte", () => {
  const golden = JSON.parse(readFileSync(new URL("./fixtures/golden-fields-mic-pcg.json", import.meta.url), "utf8"));
  assert.equal(golden.solver, "mic-pcg");
  const changed = [];
  let compared = 0;
  for (const entry of FIXTURE_CASES) {
    if (entry.invalid) continue;
    const expected = golden.cases[entry.id];
    assert.ok(expected, `no mic-pcg golden record for ${entry.id}`);
    const actual = measureFixtureCase(entry, { pressureSolver: "mic-pcg" });
    compared++;
    for (const field of ["u", "v", "p"]) {
      if (actual[field] !== expected[field]) changed.push(`${entry.id}.${field}`);
    }
  }
  assert.deepEqual(changed, []);
  console.log(`[preconditioner] ${compared} golden cases byte-identical under mic-pcg; the cg record is checked by test10 and test13`);
});
