// The validation panel: what is actually known about the scenario on screen.
//
// VISION 4.3 requires a viewer to be able to tell a visual demonstration from a
// validated numerical result. Until now the harness showed the lid-driven
// cavity and the 90-degree bend identically, and they are not the same kind of
// claim: the cavity is checked against published measurements, while the bend's
// separation length is checked against physical reasoning and its own
// convergence, because no published number for it exists. Presenting them the
// same way misleads by omission.
//
// Two rules this panel follows:
//
//   1. Show the measured error, not a badge. "benchmarked" on its own is a
//      reassurance; "max|u - Ghia| = 0.0179 against a 0.035 tolerance" is a
//      fact the reader can argue with. The numbers come from an actual
//      validation run via docs/validation-results.json, written by the same
//      run that produces docs/VALIDATION.md.
//   2. Say when it does not know. If the results file is missing or stale the
//      panel says so plainly. It never falls back to the registry's
//      classification alone, because a classification without measurements
//      behind it is the badge this is meant to replace.
//
// M5 adds a third case, and it is the sharpest one. Once geometry can be drawn,
// the domain on screen need not be the domain anything was measured on - and a
// recorded wake length shown beside a cylinder the viewer has just erased is
// the exact failure this panel exists to prevent, wearing the panel's own
// clothes. So when the mask no longer matches the scenario's own, the
// measurements are WITHDRAWN rather than annotated. A caveat under a table of
// numbers is read after the numbers; removing them is read first.

import { validationForScenario } from "../validation/registry.js";
import { exponential, fixed } from "./format.js";

const RESULTS_URL = "./docs/validation-results.json";

const CLASSIFICATION_SUMMARY = {
  benchmarked: "checked against an external reference",
  "self-validated": "exact invariants and self-convergence only",
  demonstration: "not validated",
};

export class ValidationPanel {
  constructor(root) {
    this.root = root;
    this.results = null;
    this.loadError = null;
    this.loaded = false;
  }

  // Failure to load is recorded, not swallowed: the panel has to be able to
  // say "I do not have the measurements" rather than quietly showing less.
  async load() {
    try {
      const response = await fetch(RESULTS_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.results = await response.json();
    } catch (error) {
      this.loadError = error.message;
    } finally {
      this.loaded = true;
    }
  }

  // `geometryEdited` comes from the session's comparison of the sampled mask
  // against the scenario's own, not from an edit counter. `scenarioRe` is the
  // Reynolds number the scenario is actually running at, so a case benchmarked
  // at a different one can say so.
  render(scenarioId, { geometryEdited = false, scenarioRe = null } = {}) {
    const info = validationForScenario(scenarioId);
    const set = (id, text, cls) => {
      const node = this.root.querySelector(id);
      if (!node) return;
      node.textContent = text;
      node.className = cls ?? "";
    };

    if (geometryEdited) {
      set("#vclass", "does not apply", "bad");
      set("#vmeans", "the domain on screen is not the one that was validated");
      set("#vref", "—");
      set("#vrefstatus", "—");
      const withdrawn = this.root.querySelector("#vdetail");
      withdrawn.innerHTML = "";
      withdrawn.className = "vnote bad";
      withdrawn.textContent =
        `The geometry has been edited, so the recorded measurements for ` +
        `"${scenarioId}" describe a different domain and are not shown. The solver ` +
        `is the same solver and its own invariants - divergence, flux balance, ` +
        `finiteness - still hold and are still reported above. What is gone is the ` +
        `comparison against a reference, because there is no reference for a shape ` +
        `you just drew. Undo back to the scenario's own geometry to get it back.`;
      return;
    }

    const tone =
      info.classification === "benchmarked" ? "good"
      : info.classification === "self-validated" ? "partial"
      : "bad";
    set("#vclass", info.classification, tone);
    set("#vmeans", CLASSIFICATION_SUMMARY[info.classification] ?? "");

    const reference = info.reference;
    if (reference) {
      set("#vref", reference.id);
      set(
        "#vrefstatus",
        reference.verification,
        reference.verification === "unverified" ? "bad" : ""
      );
    } else {
      set("#vref", "invariants only");
      set("#vrefstatus", "—");
    }

    const detail = this.root.querySelector("#vdetail");
    detail.innerHTML = "";
    detail.className = "";

    if (!this.loaded) {
      detail.textContent = "loading validation record…";
      return;
    }
    if (this.loadError) {
      detail.textContent =
        `No validation record loaded (${this.loadError}). Run "npm run validate" to ` +
        `generate it. Without it this panel can name the classification but cannot ` +
        `show what was actually measured.`;
      detail.className = "vnote bad";
      return;
    }

    const record = info.caseId ? this.results.cases?.[info.caseId] : null;
    if (!record) {
      detail.textContent = `The validation record contains no case for this scenario.`;
      detail.className = "vnote bad";
      return;
    }

    const table = document.createElement("table");
    table.className = "vtable";
    const head = document.createElement("tr");
    head.innerHTML = "<th>measured</th><th>value</th><th>target</th><th>tol</th><th></th>";
    table.appendChild(head);

    for (const claim of record.claims) {
      const row = document.createElement("tr");
      const measured = claim.measured === null ? "—" : formatValue(claim.measured);
      const tolerance =
        claim.tolerance === null ? "—"
        : claim.relative ? `${(claim.tolerance * 100).toFixed(0)}%`
        : formatValue(claim.tolerance);
      const failed = claim.result === "FAIL";
      // The target is shown alongside the tolerance because a tolerance on its
      // own is unreadable: "1.9324 within 0.3" only means something once you
      // can see it is 0.3 around an expected value of 2.
      const target = claim.reference === null || claim.reference === undefined
        ? "—" : formatValue(claim.reference);
      row.innerHTML =
        `<td>${escapeHtml(claim.quantity)}</td>` +
        `<td class="num">${measured}</td>` +
        `<td class="num dim">${target}</td>` +
        `<td class="num dim">${tolerance === "—" ? "—" : "±" + tolerance}</td>` +
        `<td class="${failed ? "bad" : "dim"}">${claim.result}</td>`;
      table.appendChild(row);
    }
    detail.appendChild(table);

    // The operating point, when the benchmark was measured at a different one.
    //
    // This is the same failure as showing a validated number beside an edited
    // geometry, in a different variable: the record describes a configuration
    // that is not the one on screen. The geometry version is handled by
    // withdrawing the numbers, which would be too blunt here - the case IS
    // about this scenario, just at another condition - so it is stated instead,
    // above the caveat, where it is read before the numbers rather than after.
    const benchmarkRe = info.benchmarkedAt?.Re;
    if (
      Number.isFinite(benchmarkRe) && Number.isFinite(scenarioRe)
      && Math.abs(benchmarkRe - scenarioRe) > 1e-9
    ) {
      const mismatch = document.createElement("p");
      mismatch.className = "vnote bad";
      mismatch.textContent =
        `Different operating point: this scenario runs at Re = ${fixed(scenarioRe, 0)}, ` +
        `and the comparison above was measured at Re = ${fixed(benchmarkRe, 0)}. The ` +
        `numbers describe the solver, not the flow currently on screen - the two ` +
        `Reynolds numbers can be in genuinely different regimes.`;
      detail.appendChild(mismatch);
    }

    if (record.caveat) {
      const caveat = document.createElement("p");
      caveat.className = "vnote bad";
      caveat.textContent = `Caveat: ${record.caveat}`;
      detail.appendChild(caveat);
    }

    const provenance = document.createElement("p");
    provenance.className = "vnote";
    provenance.textContent =
      `Measured ${this.results.generatedAt} by ${record.measuredBy}. ` +
      `These are recorded results for the validated configuration, not a ` +
      `measurement of the run on screen.`;
    detail.appendChild(provenance);
  }
}

function formatValue(value) {
  if (typeof value !== "number") return String(value);
  if (value === 0) return "0";
  if (Math.abs(value) >= 0.01 && Math.abs(value) < 1000) return fixed(value, 4);
  return exponential(value, 2);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
