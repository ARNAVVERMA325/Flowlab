// Captures every number the project claims, so a solver change can be judged
// against them claim by claim (see docs/pressure-preconditioner.md).
//
//   node scripts/capture-solver-baseline.js <out.json>
//
// Records, with whatever pressure solver step() currently defaults to:
//   - every validation case's measured claims (validation/registry.js),
//   - all four M10 experiments' results and verdicts,
//   - per scenario over 400 steps: pressure-solve iterations, step time,
//     worst continuity error, and a hash of the final field,
//   - the M11 momentum-budget closure and the M12 material laws.

import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { CASES } from "../validation/registry.js";
import { measureCase, hasMeasurement } from "../validation/measure.js";
import { EXPERIMENTS } from "../experiments/definitions.js";
import { ExperimentRunner } from "../experiments/runner.js";
import { SimulationSession } from "../ui/session.js";
import { SCENARIOS } from "../scenarios/index.js";
import { WATER, fluidById } from "../materials/fluids.js";

const out = process.argv[2];
if (!out) throw new Error("usage: capture-solver-baseline.js <out.json>");
const result = { capturedAt: new Date().toISOString(), validation: {}, experiments: {}, scenarios: {}, budget: {}, materials: {} };
const log = (...a) => console.error(...a);

const hash = (array) => createHash("sha256").update(Buffer.from(array.buffer, array.byteOffset, array.byteLength)).digest("hex").slice(0, 16);

for (const entry of CASES) {
  if (!hasMeasurement(entry.id)) continue;
  const t = Date.now();
  result.validation[entry.id] = await measureCase(entry.id);
  log(`validation ${entry.id} ${((Date.now() - t) / 1000).toFixed(0)} s`);
}

for (const { id } of SCENARIOS) {
  const s = new SimulationSession(id);
  const iterations = [];
  const times = [];
  let worstContinuity = 0;
  for (let n = 0; n < 400; n++) {
    const t = performance.now();
    s.advance();
    times.push(performance.now() - t);
    iterations.push(s.lastStep.poissonIterations);
    worstContinuity = Math.max(worstContinuity, s.lastStep.continuityError);
  }
  const sorted = [...times].sort((a, b) => a - b);
  let peak = 0;
  for (let k = 0; k < s.grid.u.length; k++) peak = Math.max(peak, Math.hypot(s.grid.u[k], s.grid.v[k]));
  result.scenarios[id] = {
    meanIterations: iterations.reduce((a, b) => a + b, 0) / iterations.length,
    maxIterations: Math.max(...iterations),
    medianStepMs: sorted[Math.floor(sorted.length / 2)],
    worstContinuity,
    time: s.simulatedTime,
    peakFaceSpeed: peak,
    hash: { u: hash(s.grid.u), v: hash(s.grid.v), p: hash(s.grid.p) },
  };
  const b = s.momentumBudget();
  result.budget[id] = b.relativeClosure;
  log(`scenario ${id}: ${result.scenarios[id].meanIterations.toFixed(0)} it, ${result.scenarios[id].medianStepMs.toFixed(1)} ms`);
}

{
  const advance = (s, n) => { for (let k = 0; k < n; k++) s.advance(); return s; };
  const w = advance(new SimulationSession("cylinder").setMaterial(WATER), 60);
  const h = advance(new SimulationSession("cylinder").setMaterial({ name: "x", rho: 10 * WATER.rho, mu: 10 * WATER.mu }), 60);
  let du = 0, mu = 0;
  for (let k = 0; k < w.grid.u.length; k++) { du = Math.max(du, Math.abs(w.grid.u[k] - h.grid.u[k])); mu = Math.max(mu, Math.abs(w.grid.u[k])); }
  result.materials.nuOnlyRelativeDifference = du / mu;
  const developed = (fluid) => {
    const s = new SimulationSession("pressure-channel");
    s.setMaterial(fluid);
    while (s.changeRate > 1e-9 * s.scenario.material.speed && s.simulatedTime < 200) s.advance();
    let q = 0;
    for (let j = 1; j <= s.grid.ny; j++) q += s.grid.u[s.grid.idx(s.grid.nx / 2, j)] * s.grid.h;
    return q;
  };
  result.materials.airOverWaterFlux = developed(fluidById("air")) / developed(WATER);
  result.materials.muRatio = WATER.mu / fluidById("air").mu;
  log("materials done");
}

for (const experiment of EXPERIMENTS) {
  const t = Date.now();
  const runner = new ExperimentRunner(experiment, new SimulationSession("cavity")).start();
  while (runner.state === "running") { runner.session.advance(); runner.afterStep(); }
  result.experiments[experiment.id] = { state: runner.state, results: runner.results, conclusion: runner.conclusion, seconds: (Date.now() - t) / 1000 };
  log(`experiment ${experiment.id} ${((Date.now() - t) / 1000).toFixed(0)} s`);
}

await writeFile(out, JSON.stringify(result, null, 1));
log(`wrote ${out}`);
