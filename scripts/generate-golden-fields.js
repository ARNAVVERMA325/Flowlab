// Records the boundary-condition golden fields.
//
//   npm run golden          write tests/fixtures/golden-fields.json
//   npm run golden -- --diff <caseId>   show where a failing case diverges
//
// This is deliberately NOT run as part of the test suite. The fixture is a
// record of what the solver produced at a known-good commit; regenerating it
// because a test went red would erase the only evidence that a refactor
// changed the physics. Regenerate it only when a change to the fields is
// intended, understood, and described in the commit that does it.

import { readFile, writeFile } from "node:fs/promises";
import { FIXTURE_CASES, measureFixtureCase, runFixtureCase } from "../tests/support/boundaryFixtures.js";

// `--solver mic-pcg` records the preconditioned pressure solve into its own
// file; the default record stays the reference "cg" solve.
const SOLVER = process.argv.includes("--solver") ? process.argv[process.argv.indexOf("--solver") + 1] : "cg";
const OUT = new URL(
  SOLVER === "cg" ? "../tests/fixtures/golden-fields.json" : `../tests/fixtures/golden-fields-${SOLVER}.json`,
  import.meta.url,
).pathname;

// A hash mismatch says the field changed but not where. This prints the first
// cells that differ against the current code, so a failure is diagnosable
// rather than merely red. It needs a second field to compare against, which
// only exists once someone has a suspect build - so it takes the case id and
// reports the field's own structure: where the extremes sit, and what the
// boundary rows look like, which is where a boundary bug shows first.
function describe(caseId) {
  const entry = FIXTURE_CASES.find((c) => c.id === caseId);
  if (!entry) {
    process.stderr.write(`no such case: ${caseId}\nknown: ${FIXTURE_CASES.map((c) => c.id).join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  const grid = runFixtureCase(entry, { pressureSolver: SOLVER });
  const line = (label, values) =>
    `${label.padEnd(18)} ${values.map((v) => (Number.isFinite(v) ? v.toFixed(6).padStart(11) : "        NaN")).join(" ")}`;

  process.stdout.write(`case ${entry.id} - ${entry.description}\n`);
  process.stdout.write(`grid ${grid.nx}x${grid.ny}\n\n`);
  process.stdout.write("Boundary rows and columns, where a misplaced wall shows first:\n");
  const mid = Math.max(1, Math.round(grid.ny / 2));
  const midX = Math.max(1, Math.round(grid.nx / 2));
  const sample = (n) => Array.from({ length: Math.min(6, n) }, (_, k) => k + 1);
  process.stdout.write(line("u ghost i=0", sample(grid.ny).map((j) => grid.u[grid.idx(0, j)])) + "\n");
  process.stdout.write(line("u face i=1", sample(grid.ny).map((j) => grid.u[grid.idx(1, j)])) + "\n");
  process.stdout.write(line(`u face i=nx`, sample(grid.ny).map((j) => grid.u[grid.idx(grid.nx, j)])) + "\n");
  process.stdout.write(line(`v ghost j=0`, sample(grid.nx).map((i) => grid.v[grid.idx(i, 0)])) + "\n");
  process.stdout.write(line(`v face j=ny`, sample(grid.nx).map((i) => grid.v[grid.idx(i, grid.ny)])) + "\n");
  process.stdout.write(line(`u ghost j=ny+1`, sample(grid.nx).map((i) => grid.u[grid.idx(i, grid.ny + 1)])) + "\n");
  process.stdout.write(line(`p row j=mid`, sample(grid.nx).map((i) => grid.p[grid.idx(i, mid)])) + "\n");
  process.stdout.write(line(`p col i=mid`, sample(grid.ny).map((j) => grid.p[grid.idx(midX, j)])) + "\n");
}

async function main() {
  const diffAt = process.argv.indexOf("--diff");
  if (diffAt !== -1) {
    describe(process.argv[diffAt + 1]);
    return;
  }

  // Entries for cases demonstrated to specify an ill-posed problem are carried
  // forward verbatim rather than re-measured. Their recorded hashes are hashes
  // of a broken field, and that is the point: they are the record of what was
  // being asserted before the problem was found. Re-measuring would either
  // throw or quietly replace the evidence.
  let previous = {};
  try {
    previous = JSON.parse(await readFile(OUT, "utf8")).cases ?? {};
  } catch {
    // No existing record; every case gets measured.
  }

  const cases = {};
  for (const entry of FIXTURE_CASES) {
    if (entry.invalid) {
      if (previous[entry.id]) {
        cases[entry.id] = { ...previous[entry.id], invalid: entry.invalid };
        process.stderr.write(`${entry.id.padEnd(28)} preserved (${entry.invalid})\n`);
      } else {
        process.stderr.write(`${entry.id.padEnd(28)} skipped, no prior record\n`);
      }
      continue;
    }
    const measured = measureFixtureCase(entry, { pressureSolver: SOLVER });
    cases[entry.id] = measured;
    process.stderr.write(
      `${entry.id.padEnd(28)} u=${measured.u.slice(0, 16)} ` +
      `peak |u|=${measured.peakU === null ? "NaN" : measured.peakU.toFixed(6)}\n`
    );
  }

  const record = SOLVER !== "cg" ? {
    note:
      `Golden fields for the "${SOLVER}" pressure solve, the same fixtures as ` +
      "golden-fields.json. That file keeps pinning the reference CG solve; this " +
      "one pins the preconditioned solve the app runs. A mismatch means a change " +
      "moved the physics; regenerate only when that is intended and say so.",
    solver: SOLVER,
    generatedAt: new Date().toISOString().replace("T", " ").replace(/\..*/, " UTC"),
    cases,
  } : {
    note:
      "Golden boundary-condition fields. Generated BEFORE the M4 refactor, from " +
      "the solver as it stood at that commit. A mismatch means a change moved the " +
      "physics; regenerate only when that is intended and say so in the commit. " +
      "Run `npm run golden -- --diff <caseId>` to inspect a failing case.",
    generatedAt: new Date().toISOString().replace("T", " ").replace(/\..*/, " UTC"),
    cases,
  };
  await writeFile(OUT, JSON.stringify(record, null, 2) + "\n", "utf8");
  process.stderr.write(`\nwrote ${OUT}\n`);
}

await main();
