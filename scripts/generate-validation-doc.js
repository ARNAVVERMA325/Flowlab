// Generates docs/VALIDATION.md by running the validation cases.
//
//   npm run validate
//
// The document is generated rather than written because a validation record
// that can silently disagree with the code is worse than no record: it reads
// as authority while being wrong. Everything in the output is either declared
// in validation/registry.js or measured by validation/measure.js, which drives
// the same harnesses the test suite drives.

import { writeFile } from "node:fs/promises";
import { CASES, REFERENCES, referenceFor } from "../validation/registry.js";
import { measureCase, hasMeasurement } from "../validation/measure.js";

const OUT = new URL("../docs/VALIDATION.md", import.meta.url).pathname;
// Machine-readable twin of the document, consumed by the harness panel so it
// can show real measured errors instead of a reassuring label. Written from the
// same run, so the two cannot disagree.
const OUT_JSON = new URL("../docs/validation-results.json", import.meta.url).pathname;

// Quantity names contain pipes ("max|div u|"), which would otherwise be read
// as column separators and shred the table.
function cell(text) {
  return String(text).replace(/\|/g, "\\|");
}

function fmt(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "number") return String(value);
  if (Number.isNaN(value)) return "**NaN**";
  if (!Number.isFinite(value)) return value > 0 ? "**+Infinity**" : "**-Infinity**";
  if (value === 0) return "0";
  if (Math.abs(value) >= 0.01 && Math.abs(value) < 1000) return value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return value.toExponential(3);
}

function verdict(claim, measured) {
  if (claim.tolerance === null || measured === null) return "reported";
  const target = claim.reference ?? 0;
  const error = Math.abs(measured - target);
  const bound = claim.relative ? Math.abs(target) * claim.tolerance : claim.tolerance;
  return error <= bound ? "pass" : "**FAIL**";
}

const VERIFICATION_BADGE = {
  derived: "reproducible from the equations",
  verified: "cross-referenced against an independent source",
  unverified: "**recalled, not checked**",
};

const CLASSIFICATION_MEANING = {
  benchmarked:
    "checked against a reference external to this project, so being wrong is " +
    "detectable from outside",
  "self-validated":
    "checked against exact invariants and its own grid convergence; nothing " +
    "external says the answer is right",
  demonstration: "neither — runs and looks plausible",
};

async function main() {
  const generatedAt = new Date().toISOString().replace("T", " ").replace(/\..*/, " UTC");
  const lines = [];
  const record = { generatedAt, cases: {} };
  let failures = 0;

  lines.push("# Validation record");
  lines.push("");
  lines.push("**This file is generated. Do not edit it by hand — run `npm run validate`.**");
  lines.push("");
  lines.push(
    "Every number below was measured by running the solver through the same " +
    "harnesses the test suite uses (`validation/measure.js`), and compared " +
    "against references declared in `validation/registry.js`. A hand-maintained " +
    "validation record can drift from the code while still reading as " +
    "authority, which is the one failure mode a document like this must not have."
  );
  lines.push("");
  lines.push(`Generated ${generatedAt}.`);
  lines.push("");

  lines.push("## How to read this");
  lines.push("");
  lines.push("**Classification** — what a case's agreement actually establishes:");
  lines.push("");
  for (const [name, meaning] of Object.entries(CLASSIFICATION_MEANING)) {
    lines.push(`- \`${name}\` — ${meaning}`);
  }
  lines.push("");
  lines.push(
    "The distinction carries real weight. A cavity agreeing with published " +
    "measurements and a bend separating where physical reasoning says it should " +
    "are not the same kind of claim, and presenting them identically would " +
    "mislead by omission."
  );
  lines.push("");
  lines.push(
    "**Every number below describes that case's own geometry.** The harness can " +
    "now draw into a domain, and a measurement made on one domain says nothing " +
    "about another. When the geometry on screen differs from the scenario's own, " +
    "the panel withdraws these numbers rather than annotating them. What still " +
    "holds on any domain the solver accepts are its own invariants — divergence, " +
    "flux balance, finiteness — which the harness reports live."
  );
  lines.push("");
  lines.push(
    "**A number here is about the flow the solver computed, not about how " +
    "realistic the configuration is.** M6 added sources that inject momentum or " +
    "mass into the interior. A source delivers exactly what it is asked for and " +
    "the projection still meets its bound around one — both measured below — but " +
    "nothing here says a source resembles a pump, a nozzle or a hand in water. " +
    "It is a boundary condition applied in the middle of the domain."
  );
  lines.push("");
  lines.push("**Reference verification** — how far the reference itself can be trusted:");
  lines.push("");
  for (const [name, meaning] of Object.entries(VERIFICATION_BADGE)) {
    lines.push(`- \`${name}\` — ${meaning}`);
  }
  lines.push("");

  // Summary table first, so the shape of the evidence is visible immediately.
  lines.push("## Summary");
  lines.push("");
  lines.push("| case | classification | reference | verification |");
  lines.push("|---|---|---|---|");
  for (const entry of CASES) {
    const reference = referenceFor(entry.id);
    lines.push(
      `| ${entry.label} | \`${entry.classification}\` | ` +
      `${reference ? reference.id : "invariants only"} | ` +
      `${reference ? `\`${reference.verification}\`` : "—"} |`
    );
  }
  lines.push("");

  for (const entry of CASES) {
    lines.push(`## ${entry.label}`);
    lines.push("");
    lines.push(`**Classification:** \`${entry.classification}\` — ${CLASSIFICATION_MEANING[entry.classification]}`);
    lines.push("");
    lines.push(`**Asserted by:** \`${entry.measuredBy}\``);
    lines.push("");
    lines.push(entry.rationale);
    lines.push("");

    const reference = referenceFor(entry.id);
    if (reference) {
      lines.push(`**Reference:** ${reference.citation}`);
      lines.push("");
      lines.push(`**Verification:** ${VERIFICATION_BADGE[reference.verification]}`);
      lines.push("");
      lines.push(`> ${reference.verificationNote}`);
      lines.push("");
    }
    if (entry.caveat) {
      lines.push(`> ⚠️ **Caveat.** ${entry.caveat}`);
      lines.push("");
    }

    if (!hasMeasurement(entry.id)) {
      lines.push("_No measurement defined for this case._");
      lines.push("");
      continue;
    }

    process.stderr.write(`measuring ${entry.id} ...\n`);
    const started = Date.now();
    const measured = await measureCase(entry.id);
    process.stderr.write(`  done in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    const byQuantity = new Map(measured.map((m) => [m.quantity, m]));
    const reference2 = referenceFor(entry.id);
    record.cases[entry.id] = {
      label: entry.label,
      classification: entry.classification,
      reference: reference2 ? { id: reference2.id, citation: reference2.citation, verification: reference2.verification } : null,
      caveat: entry.caveat ?? null,
      measuredBy: entry.measuredBy,
      claims: [],
    };

    lines.push("| quantity | reference | measured | tolerance | result |");
    lines.push("|---|---|---|---|---|");
    for (const claim of entry.claims) {
      const found = byQuantity.get(claim.quantity);
      const value = found ? found.measured : null;
      const result = verdict(claim, value);
      if (result.includes("FAIL")) failures++;
      record.cases[entry.id].claims.push({
        quantity: claim.quantity,
        reference: claim.reference,
        measured: value,
        tolerance: claim.tolerance,
        relative: Boolean(claim.relative),
        referenceType: claim.referenceType,
        result: result.replace(/\*/g, ""),
      });
      const tolerance = claim.tolerance === null
        ? "—"
        : claim.relative ? `${(claim.tolerance * 100).toFixed(0)}% relative` : fmt(claim.tolerance);
      lines.push(
        `| ${cell(claim.quantity)} | ${fmt(claim.reference)} | ${fmt(value)}` +
        `${found?.context ? `<br><sub>${cell(found.context)}</sub>` : ""} | ${tolerance} | ${result} |`
      );
    }
    lines.push("");

    const extra = measured.filter((m) => !entry.claims.some((c) => c.quantity === m.quantity));
    if (extra.length) {
      lines.push("Also measured, not asserted:");
      lines.push("");
      for (const m of extra) {
        lines.push(`- ${cell(m.quantity)}: ${fmt(m.measured)}${m.context ? ` (${cell(m.context)})` : ""}`);
      }
      lines.push("");
    }
  }

  lines.push("## Known limitations");
  lines.push("");
  lines.push(
    "Carried forward from `docs/M1-solver-hardening.md`, which has the detail:"
  );
  lines.push("");
  lines.push("- Symmetry costs convergence under the CG pressure solve; it was structurally free under SOR.");
  lines.push("- No upwinding: cell Reynolds numbers above ~2 are outside formal validity.");
  lines.push("- A CFL-respecting timestep is not sufficient near a geometric singularity.");
  lines.push("- Obstacles are staircase-resolved to about one cell.");
  lines.push("- The explicit viscous limit scales as h², so refinement gets expensive quickly.");
  lines.push(
    "- The first step of a run from rest is taken outside the stability limit the " +
    "driver believes it is enforcing: dt is sized from the field before the step, " +
    "which is motionless, so the viscous limit sets it and the flow that exists " +
    "afterwards is moving. Measured at an effective convective CFL near 5 on the " +
    "sharp bend. It survives — dt drops by 13x on the next step and no validation " +
    "case is affected — and is recorded rather than fixed. See " +
    "`docs/M3-visualization.md` §2."
  );
  lines.push("");
  lines.push(
    "From `docs/M3-visualization.md`, and bearing on what this document does NOT " +
    "cover: the dye tracer added in M3 is a visualization aid, not a result. No " +
    "case below validates it, nothing external says a dye pattern is right, and " +
    "the harness labels it accordingly. The pressure view shows the first-order " +
    "Chorin projection pressure, which is not the true pressure near walls."
  );
  lines.push("");
  lines.push(
    "From `docs/M4-boundary-conditions.md`: the outlet condition is zero-gradient " +
    "with a per-region flux rescale, which reflects vortices back into the domain - " +
    "adequate for the steady cases validated here, and a real limitation for " +
    "unsteady wakes. A convective outflow was deferred rather than adopted, " +
    "because changing it would perturb the cylinder benchmark."
  );
  lines.push("");
  lines.push(
    "From `docs/M6-sources.md`: with a mass source running the flow is " +
    "non-solenoidal ON PURPOSE at the cells it covers, so `max|div u|` there is " +
    "q by design and the quantity that says whether the projection is working " +
    "is the CONTINUITY ERROR, `max|div u - q|`. The two are the same number " +
    "whenever no mass source is active, which is every case below. A momentum " +
    "source cannot carry a face past its target in one step, which is what lets " +
    "the timestep be sized against it; a boundary inlet has no such bound, so " +
    "the first step of an impulsively started scenario is still taken outside " +
    "the limit the driver believes it is enforcing - measured at CFL 5.145 on " +
    "the sharp bend, and left recorded rather than fixed."
  );
  lines.push("");
  lines.push(
    "From `docs/M5-interactive-geometry.md`: drawn shapes are SAMPLED onto the " +
    "existing uniform grid - cell centres tested against a region - not meshed, so " +
    "the staircase limitation above applies to anything drawn as much as to the " +
    "cylinder. Solid surfaces can now carry the full condition set where they are " +
    "axis-aligned; on a staircase surface, which has no single normal, only wall " +
    "and free-slip are allowed and a flux-prescribing condition is refused rather " +
    "than approximated. A domain whose fluid splits into regions is solved when " +
    "every region's flux can be absorbed and REJECTED WITH A REASON when it " +
    "cannot, rather than reported as converged; the pre-M5 solver reported 8.1e-8 " +
    "for a field whose actual max|div u| was 2.950e-1 in one such case. The outer " +
    "domain stays a rectangle and per-region pressure solving is deferred."
  );
  lines.push("");
  const unverified = Object.values(REFERENCES).filter((r) => r.verification === "unverified");
  if (unverified.length) {
    lines.push(
      `**${unverified.length} reference${unverified.length === 1 ? " is" : "s are"} still unverified** ` +
      `(${unverified.map((r) => r.id).join(", ")}). Any claim resting on ${unverified.length === 1 ? "it" : "them"} ` +
      "is weaker than the rest of this document, and should be read that way. " +
      "Each one records what closing it would take, so it stays a piece of open " +
      "work rather than a permanent disclaimer:"
    );
    lines.push("");
    for (const reference of unverified) {
      lines.push(`- **${reference.id}** — ${reference.blocker ?? "no blocker recorded."}`);
    }
    lines.push("");
  }

  await writeFile(OUT, lines.join("\n"), "utf8");
  await writeFile(OUT_JSON, JSON.stringify(record, null, 2) + "\n", "utf8");
  process.stderr.write(`\nwrote ${OUT}\n       ${OUT_JSON}\n`);
  if (failures > 0) {
    process.stderr.write(`${failures} claim(s) FAILED — see the document.\n`);
    process.exitCode = 1;
  }
}

await main();
