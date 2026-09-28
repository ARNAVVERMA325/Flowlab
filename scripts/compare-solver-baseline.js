// Sets two captures from capture-solver-baseline.js side by side, claim by
// claim, and judges each against the SAME criterion the project already uses
// for it - the registry's tolerance for a validation claim, the experiment's
// own verdict for an experiment row. Nothing is re-judged with a new, looser
// bound. Output is a Markdown report.
//
//   node scripts/compare-solver-baseline.js before.json after.json > report.md

import { readFileSync } from "node:fs";
import { CASES } from "../validation/registry.js";

const [before, after] = process.argv.slice(2, 4).map((path) => JSON.parse(readFileSync(path, "utf8")));
const lines = [];
const out = (text = "") => lines.push(text);
let failures = 0;

const num = (x) => {
  if (x === null || x === undefined) return "—";
  if (typeof x !== "number") return String(x);
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return "0";
  const a = Math.abs(x);
  return a >= 1e-3 && a < 1e4 ? x.toPrecision(6) : x.toExponential(4);
};
const change = (a, b) => {
  if (typeof a !== "number" || typeof b !== "number") return a === b ? "same" : "differs";
  if (a === b) return "identical";
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return `${(Math.abs(b - a) / (scale || 1)).toExponential(1)} rel`;
};
const verdict = (claim, measured) => {
  if (claim.tolerance === null || claim.tolerance === undefined || typeof measured !== "number") return "reported";
  const target = claim.reference ?? 0;
  const bound = claim.relative ? Math.abs(target) * claim.tolerance : claim.tolerance;
  return Math.abs(measured - target) <= bound ? "pass" : "FAIL";
};

out("## Validation registry — every claim, before and after");
out();
out("| case | quantity | before | after | change | verdict before → after |");
out("|---|---|---|---|---|---|");
for (const entry of CASES) {
  const b = before.validation[entry.id];
  const a = after.validation[entry.id];
  if (!b || !a) continue;
  for (const measuredBefore of b) {
    const measuredAfter = a.find((m) => m.quantity === measuredBefore.quantity);
    const claim = entry.claims.find((c) => c.quantity === measuredBefore.quantity) ?? {};
    const vb = verdict(claim, measuredBefore.measured);
    const va = verdict(claim, measuredAfter?.measured);
    if (vb === "pass" && va !== "pass") failures++;
    out(`| ${entry.id} | ${measuredBefore.quantity} | ${num(measuredBefore.measured)} | ${num(measuredAfter?.measured)} | ${change(measuredBefore.measured, measuredAfter?.measured)} | ${vb} → ${va === "FAIL" ? "**FAIL**" : va} |`);
  }
}

out();
out("## Experiments (M10) — every row, before and after");
out();
out("| experiment | quantity | before | after | verdict before → after |");
out("|---|---|---|---|---|");
for (const id of Object.keys(before.experiments)) {
  const b = before.experiments[id];
  const a = after.experiments[id];
  b.conclusion.rows.forEach((row, n) => {
    const other = a.conclusion.rows[n];
    if (row.status === "agrees" && other.status !== "agrees") failures++;
    out(`| ${id} | ${row.quantity} | ${num(row.measured)} | ${num(other.measured)} | ${row.status} → ${other.status === row.status ? other.status : `**${other.status}**`} |`);
  });
  b.results.forEach((run, n) => {
    const other = a.results[n];
    // The KIND of ending is the claim (steady, NOT steady, averaged). An
    // averaged run's sample count follows the timestep history, which a solver
    // change legitimately moves; it is shown, not judged.
    const kind = (r) => (r.steady === undefined ? "averaged" : r.steady ? "steady" : "NOT steady");
    const detail = (r) => (r.steady === undefined ? `${r.sampleCount} samples, ` : "") + `${r.steps} steps`;
    if (kind(run) !== kind(other)) failures++;
    out(`| ${id} | run "${run.label}" ending | ${kind(run)}, ${detail(run)} | ${kind(other)}, ${detail(other)} | ${kind(run) === kind(other) ? "same kind" : "**changed**"} |`);
  });
  const summarySame = b.conclusion.summary === a.conclusion.summary;
  out(`| ${id} | summary sentence | | | ${summarySame ? "identical" : "differs (numbers only — see below)"} |`);
}

out();
out("## Solver, per scenario over 400 steps");
out();
out("| scenario | CG iterations/step before → after | worst continuity error before → after (bound 1e-7) | field after 400 steps |");
out("|---|---|---|---|");
for (const id of Object.keys(before.scenarios)) {
  const b = before.scenarios[id];
  const a = after.scenarios[id];
  if (a.worstContinuity > 1e-7) failures++;
  const same = b.hash.u === a.hash.u && b.hash.v === a.hash.v && b.hash.p === a.hash.p;
  out(`| ${id} | ${b.meanIterations.toFixed(1)} → ${a.meanIterations.toFixed(1)} (max ${b.maxIterations} → ${a.maxIterations}) | ${num(b.worstContinuity)} → ${num(a.worstContinuity)} | ${same ? "byte-identical" : `differs; peak speed ${num(b.peakFaceSpeed)} → ${num(a.peakFaceSpeed)} (${change(b.peakFaceSpeed, a.peakFaceSpeed)})`} |`);
}

out();
out("## Other claims");
out();
out("| claim | before | after |");
out("|---|---|---|");
for (const id of Object.keys(before.budget)) {
  if (!(after.budget[id] < 1e-11)) failures++;
  out(`| M11 budget closes (${id}), relative | ${num(before.budget[id])} | ${num(after.budget[id])} |`);
}
out(`| M12 velocity depends only on nu (rel. difference at 10x density) | ${num(before.materials.nuOnlyRelativeDifference)} | ${num(after.materials.nuOnlyRelativeDifference)} |`);
out(`| M12 air/water flux (predicted mu ratio ${num(before.materials.muRatio)}) | ${num(before.materials.airOverWaterFlux)} | ${num(after.materials.airOverWaterFlux)} |`);
if (Math.abs(after.materials.airOverWaterFlux / after.materials.muRatio - 1) > 0.01) failures++;
if (after.materials.nuOnlyRelativeDifference > 1e-9) failures++;

out();
out(`**Claims that held before and do not hold after: ${failures}.**`);
console.log(lines.join("\n"));
process.exitCode = failures === 0 ? 0 : 1;
