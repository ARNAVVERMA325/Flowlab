// M3 - visualization: pressure view, dye tracer, mode switching.
//
// The milestone's real risk is not that a colour map looks wrong. It is that a
// display feature quietly becomes part of the physics - VISION 4.2's "never
// fake physics" failing not by inventing turbulence but by letting the dye,
// which exists only to be looked at, alter the flow it is drawn on. So the
// load-bearing test in this file is not a numerical one: it runs the same
// scenario with and without the tracer and requires the velocity and pressure
// fields to come out BIT-IDENTICAL. Not close. Identical.
//
// The rest divides into two groups:
//
//   - The tracer's own numerics: conservation, constant preservation,
//     boundedness, containment by solid boundaries, and an accuracy comparison
//     against an exact solution that measures what the van Leer limiter buys
//     over first-order donor cell rather than asserting it.
//   - The display layer: that a broken field cannot produce a healthy-looking
//     picture in any of the three views, that pressure is shown against a
//     stated gauge, and that switching views mutates nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { StaggeredGrid } from "../geometry/grid.js";
import { step } from "../solver/ns2d.js";
import { computeStableTimestep } from "../solver/stability.js";
import { buildScenario, SCENARIOS } from "../scenarios/index.js";
import { PassiveTracer, vanLeer, donorCell } from "../tracer/passiveScalar.js";
import { tracerConfigFor } from "../tracer/seeds.js";
import { prepareView, fieldSourceAvailable } from "../visualization/fieldSources.js";
import {
  NON_FINITE_COLOUR, SOLID_COLOUR, sampleDiverging, sampleDye, sampleRamp,
} from "../visualization/colormap.js";

// Drives a scenario for n steps exactly as the harness does, optionally with a
// tracer attached. Returns the grid so the caller can compare fields.
function run(scenarioId, steps, { tracer = null, inject = {} } = {}) {
  const scenario = buildScenario(scenarioId);
  const { grid, bc, params, timestep } = scenario;
  let previousTimestep = null;
  for (let n = 0; n < steps; n++) {
    const selection = computeStableTimestep(grid, {
      nu: params.nu,
      safety: timestep.safety,
      previousTimestep,
    });
    previousTimestep = selection.dt;
    step(grid, bc, { ...params, dt: selection.dt });
    if (tracer) tracer.advect(grid, bc, selection.dt, { inject });
  }
  return { scenario, grid };
}

function bytesOf(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

// ---------------------------------------------------------------------------
// The separation guarantee
// ---------------------------------------------------------------------------

test("M3 - a run with the tracer is bit-identical to a run without it", () => {
  const STEPS = 40;

  const plain = run("cavity", STEPS);
  const scenario = buildScenario("cavity");
  const tracer = new PassiveTracer(scenario.grid);
  tracer.seed(scenario.grid, tracerConfigFor("cavity").seed);
  const dyed = run("cavity", STEPS, { tracer });

  // Byte comparison, not a tolerance. Any coupling at all - a shared scratch
  // buffer, a stray write through the grid, a timestep the tracer influenced -
  // changes at least one bit, and a tolerance would hide exactly the small
  // perturbation that is hardest to notice and most likely to be real.
  for (const field of ["u", "v", "p"]) {
    assert.ok(
      bytesOf(plain.grid[field]).equals(bytesOf(dyed.grid[field])),
      `grid.${field} differs between a run with the tracer and a run without it`
    );
  }
  assert.ok(tracer.total(dyed.grid).total > 0, "the tracer must actually have been carrying dye");
  console.log(`[M3 separation] u, v and p bit-identical over ${STEPS} steps with dye present`);
});

test("M3 - advecting the tracer does not write to any solver field", () => {
  const { scenario, grid } = run("cavity", 12);
  const tracer = new PassiveTracer(grid);
  tracer.seed(grid, tracerConfigFor("cavity").seed);

  const before = { u: bytesOf(grid.u), v: bytesOf(grid.v), p: bytesOf(grid.p) };
  const snapshot = { u: Buffer.from(before.u), v: Buffer.from(before.v), p: Buffer.from(before.p) };
  tracer.advect(grid, scenario.bc, 1e-3, {});
  for (const field of ["u", "v", "p"]) {
    assert.ok(bytesOf(grid[field]).equals(snapshot[field]), `advect() wrote to grid.${field}`);
  }
});

// Removes line and block comments so the seal below is checked against code.
// Deliberately simple: these files contain no regex literals and no string
// holding "//", so a character scan is exact for them, and a parser would be a
// dependency bought to answer a question this already answers.
function stripComments(source) {
  let out = "";
  let inLine = false;
  let inBlock = false;
  let inString = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      if (c === "\\") { out += c + (next ?? ""); i++; continue; }
      if (c === inString) inString = null;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") inString = c;
    out += c;
  }
  return out;
}

test("M3 - the solver source tree does not reference the tracer", () => {
  // The structural half of the same guarantee: deleting tracer/ must not break
  // anything below the display layer. A grep is a blunt instrument but it
  // fails loudly the moment someone reaches for the dye from inside the
  // physics, which is the mistake worth catching early.
  // sources/ and boundaries/ joined this list when M4 and M6 moved physics
  // configuration out of scenarios/ - they are read by the solver every step,
  // so a dye reference in either would be exactly the coupling this forbids.
  // The dye a source carries is therefore read in tracer/, not where the source
  // is compiled.
  const sealed = ["solver", "geometry", "physics", "scenarios", "sources", "boundaries"];
  const offenders = [];
  for (const dir of sealed) {
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      if (!statSync(path).isFile() || !file.endsWith(".js")) continue;
      const source = readFileSync(path, "utf8");
      // Comments are stripped first. The check was a bare grep over the whole
      // file, and it caught a COMMENT in sources/kinds.js that explains why a
      // source's dye is deliberately invisible here - a false positive on the
      // prose that documents the very rule being enforced. A test that fires on
      // its own explanation gets loosened, so it is made precise instead: what
      // is forbidden is code that reaches for the dye, not writing down that it
      // must not.
      if (/\btracer\b/i.test(stripComments(source))) offenders.push(path);
    }
  }
  assert.deepEqual(offenders, [], `these files reference the tracer and must not: ${offenders}`);
  console.log(`[M3 separation] ${sealed.join(", ")} contain no reference to the tracer`);
});

// ---------------------------------------------------------------------------
// Tracer numerics
// ---------------------------------------------------------------------------

test("M3 - total dye is conserved in a closed domain", () => {
  // The flux form telescopes: every interior face appears once with each sign,
  // so the only way dye leaves is through a boundary face. The cavity has
  // none, so this holds to roundoff INDEPENDENTLY of how divergence-free the
  // velocity field is - which is what makes it a different test from the
  // constant-preservation one below rather than a duplicate of it.
  const scenario = buildScenario("cavity");
  const tracer = new PassiveTracer(scenario.grid);
  tracer.seed(scenario.grid, tracerConfigFor("cavity").seed);
  const initial = tracer.total(scenario.grid).total;

  const { grid } = run("cavity", 150, { tracer });
  const final = tracer.total(grid).total;

  const drift = Math.abs(final - initial) / initial;
  assert.ok(drift < 1e-12, `total dye drifted by ${drift.toExponential(3)} relative`);
  console.log(
    `[M3 tracer] total dye ${initial.toFixed(6)} -> ${final.toFixed(6)}, ` +
    `relative drift ${drift.toExponential(2)} over 150 steps`
  );
});

test("M3 - a uniform dye field stays uniform", () => {
  // This one DOES depend on the velocity field being divergence-free: with
  // c constant every face value is c, and the update reduces to
  // c -= dt * (div u). So the drift measures the projection's residual
  // divergence, and its tolerance is set by that, not by the advection scheme.
  const scenario = buildScenario("cavity");
  const tracer = new PassiveTracer(scenario.grid);
  tracer.seed(scenario.grid, () => 1);

  const STEPS = 150;
  const { grid } = run("cavity", STEPS, { tracer });

  let worst = 0;
  let nonFinite = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      if (grid.solid[k]) continue;
      const value = tracer.c[k];
      if (!Number.isFinite(value)) {
        nonFinite++;
        continue;
      }
      const error = Math.abs(value - 1);
      if (error > worst) worst = error;
    }
  }
  assert.equal(nonFinite, 0);
  assert.ok(worst < 1e-7, `uniform field drifted by ${worst.toExponential(3)}`);
  console.log(
    `[M3 tracer] uniform field held to ${worst.toExponential(2)} over ${STEPS} steps ` +
    `(bounded by the accumulated divergence residual, not the scheme)`
  );
});

test("M3 - dye stays out of solid cells", () => {
  const scenario = buildScenario("cylinder");
  const tracer = new PassiveTracer(scenario.grid);
  const config = tracerConfigFor("cylinder");
  const { grid } = run("cylinder", 60, { tracer, inject: config.inject });

  let insideSolid = 0;
  let solidCells = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      if (!grid.solid[k]) continue;
      solidCells++;
      if (tracer.c[k] !== 0) insideSolid++;
    }
  }
  assert.ok(solidCells > 0, "the cylinder scenario must actually contain solid cells");
  assert.equal(insideSolid, 0, `${insideSolid} solid cells hold dye`);
  assert.ok(tracer.total(grid).total > 0, "dye must have been injected at the inlet");
  console.log(`[M3 tracer] ${solidCells} solid cells, all exactly zero after injection`);
});

test("M3 - overshoot and undershoot are measured, not assumed", () => {
  // TVD is a one-dimensional result; in 2D unsplit with forward Euler it is
  // not proven. So this records what actually happens to a sharp step under a
  // strongly sheared flow rather than asserting c stays in [0, 1].
  const scenario = buildScenario("cavity");
  const tracer = new PassiveTracer(scenario.grid);
  tracer.seed(scenario.grid, (x, y) => (y > 0.5 ? 1 : 0));

  const { grid } = run("cavity", 200, { tracer });

  let high = -Infinity;
  let low = Infinity;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      if (grid.solid[k]) continue;
      const value = tracer.c[k];
      assert.ok(Number.isFinite(value), `non-finite dye at (${i}, ${j})`);
      if (value > high) high = value;
      if (value < low) low = value;
    }
  }
  const over = high - 1;
  const under = -low;
  console.log(
    `[M3 tracer] sharp step after 200 steps: max ${high.toFixed(9)}, min ${low.toFixed(9)} ` +
    `(overshoot ${over.toExponential(2)}, undershoot ${under.toExponential(2)})`
  );
  // Tolerances set from the measurement, with headroom - not from what TVD
  // promises. The observed excursion tracks the accumulated divergence
  // residual (the same 1e-8 the uniform-field test measures) rather than the
  // limiter: the discrete field is divergence-free only to the Poisson
  // tolerance, so no exact maximum principle is available to appeal to.
  assert.ok(over < 1e-6, `overshoot ${over.toExponential(3)} above the injected concentration`);
  assert.ok(under < 1e-6, `undershoot ${under.toExponential(3)} below zero`);
});

test("M3 - the limiter beats donor cell against an exact solution", () => {
  // Pure translation at constant speed, which has an exact solution: the
  // initial profile shifted by U*T. No solver involved - this isolates the
  // advection scheme from everything else.
  //
  // The point is the claim made in tracer/passiveScalar.js, that first-order
  // upwinding is too diffusive to show what dye is for. That claim is measured
  // here on the same code path, with only the limiter swapped.
  const nx = 400;
  const ny = 3;
  const h = 1 / nx;
  const U = 1;
  const T = 0.5;
  const dt = (0.4 * h) / U;
  const steps = Math.round(T / dt);

  const sigma = 0.05;
  const x0 = 0.2;
  const exact = (x) => Math.exp(-((x - x0 - U * T) ** 2) / (2 * sigma * sigma));
  const initial = (x) => Math.exp(-((x - x0) ** 2) / (2 * sigma * sigma));

  const bc = { left: { type: "inflow", u: U, v: 0 }, right: { type: "outflow" } };

  function transport(limiter) {
    const grid = new StaggeredGrid(nx, ny, h);
    grid.u.fill(U);
    const tracer = new PassiveTracer(grid, { limiter });
    tracer.seed(grid, (x) => initial(x));
    for (let n = 0; n < steps; n++) tracer.advect(grid, bc, dt, { inject: { left: () => 0 } });

    let peak = 0;
    let l1 = 0;
    for (let i = 1; i <= nx; i++) {
      const { x } = grid.cellCentre(i, 1);
      const error = Math.abs(tracer.c[grid.idx(i, 1)] - exact(x));
      l1 += error * h;
      if (error > peak) peak = error;
    }
    let height = 0;
    for (let i = 1; i <= nx; i++) height = Math.max(height, tracer.c[grid.idx(i, 1)]);
    return { l1, peak, height };
  }

  const limited = transport(vanLeer);
  const donor = transport(donorCell);
  const ratio = donor.l1 / limited.l1;

  console.log(
    `[M3 scheme] translating a Gaussian ${(U * T).toFixed(2)} over ${steps} steps:\n` +
    `            van Leer   L1 ${limited.l1.toExponential(3)}  peak err ${limited.peak.toExponential(3)}  crest ${limited.height.toFixed(4)}\n` +
    `            donor cell L1 ${donor.l1.toExponential(3)}  peak err ${donor.peak.toExponential(3)}  crest ${donor.height.toFixed(4)}\n` +
    `            limiter is ${ratio.toFixed(1)}x more accurate in L1`
  );

  assert.ok(ratio > 20, `the limiter is only ${ratio.toFixed(2)}x better than donor cell`);
  // Peak error is the guard on the Courant factor in the antidiffusive flux.
  // Dropping it leaves the crest at 0.9996 - nothing looks wrong - while the
  // profile lags and the peak error goes to 1.4e-1. The L1 ratio catches it
  // too, but this is the measurement that names the failure.
  assert.ok(limited.peak < 0.02, `peak error ${limited.peak.toExponential(3)} suggests a phase lag`);
  // The crest is the honest measure of smearing: the exact solution still
  // peaks at 1, and how far a scheme falls short of that is how much structure
  // it has thrown away.
  assert.ok(limited.height > 0.97, `limited crest decayed to ${limited.height.toFixed(4)}`);
  assert.ok(donor.height < 0.9, `donor cell was expected to smear the crest, got ${donor.height.toFixed(4)}`);
});

test("M3 - the tracer substeps rather than asking for a smaller timestep", () => {
  // Hand it a step far beyond its own CFL bound. It must subdivide, stay
  // bounded, and - the part that matters - report the same dt it was given.
  const nx = 40;
  const h = 1 / nx;
  const U = 1;
  const grid = new StaggeredGrid(nx, 3, h);
  grid.u.fill(U);
  const tracer = new PassiveTracer(grid);
  tracer.seed(grid, (x) => (x > 0.2 && x < 0.4 ? 1 : 0));

  const dt = (4 * h) / U; // CFL 4, eight times the tracer's own bound
  const bc = { left: { type: "inflow", u: U, v: 0 }, right: { type: "outflow" } };
  const result = tracer.advect(grid, bc, dt, { inject: { left: () => 0 } });

  assert.equal(result.dt, dt, "the tracer must consume the timestep it was given");
  assert.ok(result.substeps > 1, `expected substepping at CFL ${result.cfl.toFixed(2)}`);
  assert.ok(result.cfl / result.substeps <= tracer.maxCFL + 1e-12);

  let worst = 0;
  for (let i = 1; i <= nx; i++) {
    const value = tracer.c[grid.idx(i, 1)];
    assert.ok(Number.isFinite(value));
    worst = Math.max(worst, value - 1, -value);
  }
  assert.ok(worst < 1e-9, `substepped result left the range by ${worst.toExponential(3)}`);
  console.log(
    `[M3 tracer] CFL ${result.cfl.toFixed(2)} -> ${result.substeps} substeps ` +
    `at ${(result.cfl / result.substeps).toFixed(3)} each, dt unchanged`
  );
});

test("M3 - a non-finite velocity makes the tracer CFL non-finite", () => {
  // The masking bug this project has now hit twice: a reduction that skips
  // non-finite entries reports a healthy number for a broken field. A CFL is
  // exactly such a reduction.
  const grid = new StaggeredGrid(8, 8, 0.1);
  grid.u.fill(1);
  const tracer = new PassiveTracer(grid);
  assert.ok(Number.isFinite(tracer.courantNumber(grid, 0.01)));
  grid.u[grid.idx(4, 4)] = NaN;
  assert.ok(Number.isNaN(tracer.courantNumber(grid, 0.01)), "a NaN velocity must poison the CFL");
});

// ---------------------------------------------------------------------------
// Display layer
// ---------------------------------------------------------------------------

test("M3 - every view paints a broken field as broken", () => {
  // One NaN anywhere in the field the view reads must reach the picture. The
  // failure being guarded is a scale that skips the NaN, leaving every other
  // cell to paint normally and the broken one to clamp to an end of the ramp.
  const grid = new StaggeredGrid(8, 8, 0.1);
  grid.u.fill(0.5);
  grid.p.fill(1);
  const tracer = new PassiveTracer(grid);
  tracer.seed(grid, () => 0.5);
  const context = { grid, tracer };

  // The expected counts differ by field layout, which is worth being explicit
  // about: pressure and dye live at cell centres, so one bad entry poisons one
  // cell, while u lives on a face shared by two cells and poisons both.
  const broken = {
    velocity: { breakIt: () => (grid.u[grid.idx(3, 3)] = NaN), cells: 2 },
    pressure: { breakIt: () => (grid.p[grid.idx(3, 3)] = NaN), cells: 1 },
    dye: { breakIt: () => (tracer.c[grid.idx(3, 3)] = NaN), cells: 1 },
  };

  for (const [id, { breakIt, cells }] of Object.entries(broken)) {
    const healthy = prepareView(id, context);
    assert.equal(healthy.summary.nonFiniteCells, 0, `${id}: fixture starts healthy`);
    assert.notDeepEqual(
      healthy.ramp(healthy.normalise(healthy.valueAt(3, 3))),
      NON_FINITE_COLOUR,
      `${id}: a healthy cell must not already paint as broken`
    );

    breakIt();
    const view = prepareView(id, context);
    assert.equal(view.summary.nonFiniteCells, cells, `${id}: the broken cells must be counted`);
    assert.deepEqual(
      view.ramp(view.normalise(view.valueAt(3, 3))),
      NON_FINITE_COLOUR,
      `${id}: the broken cell painted as if it held data`
    );
  }
  console.log("[M3 views] velocity, pressure and dye all surface a single NaN cell");
});

test("M3 - a wholly broken velocity or pressure field withholds its scale", () => {
  const grid = new StaggeredGrid(6, 6, 0.1);
  grid.u.fill(NaN);
  grid.p.fill(NaN);
  for (const id of ["velocity", "pressure"]) {
    const view = prepareView(id, { grid });
    assert.ok(Number.isNaN(view.scale.hi), `${id}: scale survived a fully broken field`);
    assert.deepEqual(view.ramp(view.normalise(view.valueAt(3, 3))), NON_FINITE_COLOUR);
  }
});

test("M3 - pressure is shown against a stated gauge", () => {
  // Every scenario uses Neumann pressure boundaries, so p is fixed only up to
  // an additive constant. Adding a constant to the whole field must therefore
  // change nothing about the picture; if it did, the view would be inviting
  // people to read absolute values that carry no meaning.
  const grid = new StaggeredGrid(10, 10, 0.1);
  for (let k = 0; k < grid.p.length; k++) grid.p[k] = Math.sin(k * 0.3);
  const before = prepareView("pressure", { grid });
  const sampled = [];
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) sampled.push(before.normalise(before.valueAt(i, j)));
  }

  for (let k = 0; k < grid.p.length; k++) grid.p[k] += 1000;
  const after = prepareView("pressure", { grid });

  let worst = 0;
  let n = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      worst = Math.max(worst, Math.abs(after.normalise(after.valueAt(i, j)) - sampled[n++]));
    }
  }
  assert.ok(worst < 1e-9, `a constant pressure offset moved the picture by ${worst.toExponential(3)}`);
  assert.equal(after.scale.centre, 0);
  assert.ok(after.scale.lo < 0 && after.scale.hi > 0, "a signed field needs a signed scale");
  assert.ok(/only up to an additive constant/.test(after.note), "the gauge must be stated in the view");
  console.log(`[M3 views] pressure invariant under a +1000 gauge shift to ${worst.toExponential(2)}`);
});

test("M3 - the dye scale is fixed, not fitted to the dye present", () => {
  // An auto-scaled dye view repaints a nearly empty domain as a full one. The
  // brightness has to mean concentration, not "the most there is right now".
  const grid = new StaggeredGrid(8, 8, 0.1);
  const tracer = new PassiveTracer(grid);
  tracer.seed(grid, () => 0.02);
  const faint = prepareView("dye", { grid, tracer });
  assert.deepEqual([faint.scale.lo, faint.scale.hi], [0, 1]);
  const faintColour = faint.ramp(faint.normalise(faint.valueAt(4, 4)));

  tracer.seed(grid, () => 1);
  const full = prepareView("dye", { grid, tracer });
  assert.deepEqual([full.scale.lo, full.scale.hi], [0, 1]);
  const fullColour = full.ramp(full.normalise(full.valueAt(4, 4)));

  assert.notDeepEqual(faintColour, fullColour, "faint dye must not paint like full dye");
  console.log(
    `[M3 views] dye scale fixed at 0..1: c=0.02 paints ${faintColour}, c=1 paints ${fullColour}`
  );
});

test("M3 - switching view mutates nothing", () => {
  // The milestone requirement: changing what is displayed is a pure display
  // change. prepareView reads and returns.
  const scenario = buildScenario("cavity");
  const tracer = new PassiveTracer(scenario.grid);
  tracer.seed(scenario.grid, tracerConfigFor("cavity").seed);
  const { grid } = run("cavity", 20, { tracer });
  const context = { grid, tracer };

  const snapshot = {
    u: Buffer.from(bytesOf(grid.u)),
    v: Buffer.from(bytesOf(grid.v)),
    p: Buffer.from(bytesOf(grid.p)),
    c: Buffer.from(bytesOf(tracer.c)),
  };

  for (const id of ["velocity", "pressure", "dye", "velocity", "dye", "pressure"]) {
    const view = prepareView(id, context);
    assert.equal(view.id, id);
    for (let j = 1; j <= grid.ny; j++) {
      for (let i = 1; i <= grid.nx; i++) view.normalise(view.valueAt(i, j));
    }
  }

  assert.ok(bytesOf(grid.u).equals(snapshot.u), "u changed while switching views");
  assert.ok(bytesOf(grid.v).equals(snapshot.v), "v changed while switching views");
  assert.ok(bytesOf(grid.p).equals(snapshot.p), "p changed while switching views");
  assert.ok(bytesOf(tracer.c).equals(snapshot.c), "dye changed while switching views");
  console.log("[M3 views] six switches across all three views left every field byte-identical");
});

test("M3 - the dye view is unavailable without a tracer, and says so", () => {
  // Falling back to an empty field would read as "no dye here", which is a
  // different and false statement.
  const grid = new StaggeredGrid(4, 4, 0.25);
  assert.equal(fieldSourceAvailable("dye", { grid }), false);
  assert.equal(prepareView("dye", { grid }), null);
  assert.ok(fieldSourceAvailable("velocity", { grid }));
  assert.ok(fieldSourceAvailable("pressure", { grid }));
});

test("M3 - the first step from rest is where the tracer's own bound binds", () => {
  // The case the substepping mechanism exists for, pinned because it is not
  // hypothetical: computeStableTimestep sizes dt from the field before the
  // step, and before the first step the bend is at rest, so dt comes from the
  // viscous limit and is far larger than the flow that exists a moment later
  // can carry. The tracer advects with that post-step field and sees it.
  //
  // What must hold is that the tracer absorbs this itself. If it ever came to
  // influence dt instead, the fluid solution would change - so the bit-
  // identical test above and this one are two halves of one guarantee.
  const scenario = buildScenario("bend-sharp");
  const { grid, bc, params, timestep } = scenario;
  const tracer = new PassiveTracer(grid);

  const first = computeStableTimestep(grid, { nu: params.nu, safety: timestep.safety });
  assert.equal(first.limitedBy, "viscous", "a domain at rest has no convective limit");
  step(grid, bc, { ...params, dt: first.dt });
  const advection = tracer.advect(grid, bc, first.dt, {});

  assert.ok(advection.cfl > 1, `expected the first step to exceed the tracer's bound, got ${advection.cfl}`);
  assert.ok(advection.substeps > 1);
  assert.equal(advection.dt, first.dt, "the tracer must not have altered the timestep");

  // And it settles immediately afterwards.
  let previousTimestep = first.dt;
  let worst = 0;
  for (let n = 0; n < 40; n++) {
    const selection = computeStableTimestep(grid, {
      nu: params.nu,
      safety: timestep.safety,
      previousTimestep,
    });
    previousTimestep = selection.dt;
    step(grid, bc, { ...params, dt: selection.dt });
    worst = Math.max(worst, tracer.advect(grid, bc, selection.dt, {}).cfl);
  }
  assert.ok(worst < tracer.maxCFL, `steady-state CFL reached ${worst.toFixed(3)}`);
  console.log(
    `[M3 tracer] first step from rest: dt ${first.dt.toExponential(2)} (viscous-limited), ` +
    `tracer CFL ${advection.cfl.toFixed(2)} -> ${advection.substeps} substeps; ` +
    `settles to ${worst.toFixed(3)} over the next 40 steps`
  );
});

test("M3 - the seeded flag matches what each scenario's seed actually produces", () => {
  // The flag drives whether the Reseed control is offered, so a stale one puts
  // a button on screen that clears the dye and looks like it did nothing.
  // Checking the declaration against the behaviour keeps them from drifting.
  for (const entry of SCENARIOS) {
    const config = tracerConfigFor(entry.id);
    const scenario = buildScenario(entry.id);
    const tracer = new PassiveTracer(scenario.grid);
    tracer.seed(scenario.grid, config.seed);
    const produced = tracer.total(scenario.grid).total > 0;
    assert.equal(
      config.seeded,
      produced,
      `${entry.id}: declares seeded=${config.seeded} but its seed produces ${produced ? "dye" : "nothing"}`
    );
    assert.ok(config.note?.length > 20, `${entry.id}: needs a note explaining how dye gets in`);
  }
  const seeded = SCENARIOS.filter((s) => tracerConfigFor(s.id).seeded).map((s) => s.id);
  console.log(
    `[M3 tracer] seeded scenarios: ${seeded.join(", ") || "none"}; ` +
    `the rest are injection-only and offer no reseed`
  );
});

// ---------------------------------------------------------------------------
// The pressure scale, and the wall being visible
// ---------------------------------------------------------------------------
//
// Both of these were found by looking at a screenshot, which is worth recording
// because no assertion in this file would have caught either. The pictures were
// wrong in ways that only a person looking at them can see - and once seen,
// both reduce to numbers that can be pinned.

test("M3 - the pressure scale is fitted to the field, not to a singularity", () => {
  // The mitre bend's sharp corner reaches many times the rms of the field
  // around it. A scale drawn from the maximum spends nearly the whole ramp on
  // two cells, and the duct - the thing the picture exists to show - collapses
  // to the centre stop, which is also what a wall is drawn as.
  const grid = new StaggeredGrid(40, 40, 1 / 40);
  // A smooth field, plus one cell holding a value ten times anything else.
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      grid.p[grid.idx(i, j)] = Math.sin((i / grid.nx) * Math.PI) * 0.5;
    }
  }
  grid.p[grid.idx(20, 20)] = 40;

  const view = prepareView("pressure", { grid, tracer: null });
  assert.notEqual(view.scale.clipped, null, "a singular cell must be reported as clipped");
  assert.ok(
    view.scale.hi < 5,
    `the scale should follow the field, not the spike; it reads ${view.scale.hi}`
  );
  assert.ok(view.scale.clipped.trueHi > 39, "and the true range must still be reported");
  assert.equal(view.scale.clipped.cells >= 1, true);

  // The spike is clamped ONTO the end of the ramp, not past it into a colour
  // the legend does not describe.
  const t = view.normalise(view.valueAt(20, 20));
  assert.equal(t, 1, `a clipped cell must land exactly at the end of the ramp, got ${t}`);
  assert.ok(view.normalise(view.valueAt(1, 1)) >= 0);
  assert.ok(view.normalise(-1e9) === 0, "and clamped at the low end too");
  console.log(
    `[M3 pressure scale] one cell at 40 against a field of +-0.5: scale fitted to ` +
    `+-${view.scale.hi.toFixed(3)}, ${view.scale.clipped.cells} cell(s) clipped, ` +
    `true range reported as ${view.scale.clipped.trueLo.toFixed(2)} to ${view.scale.clipped.trueHi.toFixed(2)}`
  );
});

test("M3 - a uniform pressure field is not clipped and does not divide by zero", () => {
  const grid = new StaggeredGrid(16, 16, 1 / 16);
  const view = prepareView("pressure", { grid, tracer: null });
  assert.equal(view.scale.clipped, null, "nothing to clip in a flat field");
  assert.equal(view.normalise(view.valueAt(4, 4)), 0.5, "still water lands on the centre stop");
});

test("M3 - a solid cell is distinguishable from every ramp it sits beside", () => {
  // It was not: at [0x33,0x33,0x31] a wall was 10.0 RGB units from the
  // diverging ramp's centre and 16.9 from the dye ramp's low end, out of a
  // possible 441. In the pressure view you could not see where the geometry
  // was, and in the dye view a wall looked like clean fluid.
  //
  // The threshold is stated as a property rather than as the current value, so
  // this catches a future ramp being added or extended into the wall's colour
  // just as much as it catches the wall being moved.
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const ramps = { velocity: sampleRamp, pressure: sampleDiverging, dye: sampleDye };
  const measured = {};
  for (const [name, ramp] of Object.entries(ramps)) {
    let closest = Infinity;
    for (let k = 0; k <= 400; k++) {
      closest = Math.min(closest, distance(SOLID_COLOUR, ramp(k / 400)));
    }
    measured[name] = closest;
    assert.ok(
      closest > 40,
      `a solid cell is only ${closest.toFixed(1)} from the ${name} ramp - too close to tell apart`
    );
  }
  // And it must not collide with the not-finite marker either, which is the one
  // colour that has to stay unmistakable.
  assert.ok(distance(SOLID_COLOUR, NON_FINITE_COLOUR) > 100);
  console.log(
    `[M3 solid colour] nearest approach of each ramp: ` +
    Object.entries(measured).map(([n, d]) => `${n} ${d.toFixed(1)}`).join(", ") +
    ` (was 69.4, 10.0, 16.9)`
  );
});
