// M13 - saving, loading and exporting.
//
// A saved project is only as good as what comes back from it, so the central
// test is the strongest one available: save a project mid-work, load it into a
// fresh session, run both the same number of steps from rest, and require the
// fields to be byte-identical. The solver is deterministic, which is what makes
// that a fair demand - and what lets a project leave the field out.
//
// Exports are held to the readouts' rule: full precision, and a bad value
// written as what it is.

import test from "node:test";
import assert from "node:assert/strict";

import { SimulationSession } from "../ui/session.js";
import { fluidById } from "../materials/fluids.js";
import { PROJECT_FORMAT, ProjectError, checkProject, parseProject, projectFrom } from "../io/project.js";
import { experimentCsv, fieldCsv, number, parseCsv, probesCsv, residualsCsv } from "../io/export.js";
import { experimentById } from "../experiments/definitions.js";
import { ExperimentRunner } from "../experiments/runner.js";
import { TOOLS } from "../geometry/editor.js";

function advance(session, steps) {
  for (let n = 0; n < steps; n++) session.advance();
  return session;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
  return true;
}

// A session with something of everything a project carries.
function workedSession() {
  const session = new SimulationSession("jet");
  session.applyEdit(TOOLS.circle(2, 0.5, 0.15));
  session.setBoundary("top", { type: "freeSlip" });
  session.addSource({
    kind: "momentum", where: { kind: "rect", x0: 3, y0: 0.2, x1: 3.3, y1: 0.4 }, u: 0, v: 0.5, relaxationTime: 0.1,
  });
  session.addProbe(1.0, 0.5);
  session.addProbe(3.5, 0.3);
  session.setMaterial(fluidById("air"));
  return session;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

test("a loaded project runs to the same field, byte for byte", () => {
  const original = workedSession();
  const text = JSON.stringify(projectFrom(original, { mode: "vorticity" }));
  advance(original, 40);

  const restored = new SimulationSession("cavity");
  const view = restored.importProject(parseProject(text));
  assert.deepEqual(view, { mode: "vorticity" }, "the view comes back for the app to apply");
  advance(restored, 40);

  for (const field of ["u", "v", "p"]) {
    assert.ok(sameBytes(original.grid[field], restored.grid[field]), `${field} differs after 40 steps`);
  }
  assert.equal(restored.scenarioId, "jet");
  assert.deepEqual(restored.document, original.document);
  assert.deepEqual(restored.bc, original.bc);
  assert.equal(restored.scenario.material.fluid.id, "air");
  assert.deepEqual(restored.probes.probes.map(({ x, y }) => [x, y]), [[1.0, 0.5], [3.5, 0.3]]);
  assert.equal(restored.probes.probes[0].history.length, 40, "probes restored record like any other");
});

test("a project with a Reynolds number and no fluid comes back with it", () => {
  const session = new SimulationSession("cavity");
  session.setReynolds(400);
  const project = projectFrom(session);
  assert.equal(project.Re, 400);
  assert.equal(project.fluid, null);
  const restored = new SimulationSession("jet");
  restored.importProject(checkProject(JSON.parse(JSON.stringify(project))));
  assert.equal(restored.scenario.Re, 400);
  assert.equal(restored.scenario.params.nu, session.scenario.params.nu);
});

test("a malformed project is refused with its reason, and the session is untouched", () => {
  const session = advance(workedSession(), 5);
  const before = JSON.stringify(projectFrom(session));
  const iteration = session.iteration;
  const good = projectFrom(new SimulationSession("cavity"));
  const cases = [
    ["not json at all", /not valid JSON/],
    [JSON.stringify({ ...good, format: "something-else" }), /not a FlowLab project/],
    [JSON.stringify({ ...good, version: 99 }), /version 99/],
    [JSON.stringify({ ...good, scenario: "tokamak" }), /unknown scenario/],
    [JSON.stringify({ ...good, probes: [{ x: "a" }] }), /probes/],
    [JSON.stringify({ ...good, Re: 100, fluid: fluidById("water") }), /not both/],
  ];
  for (const [text, reason] of cases) {
    assert.throws(() => session.importProject(parseProject(text)), (error) => error instanceof ProjectError && reason.test(error.message), text.slice(0, 40));
  }
  // These pass the shape check and are refused by the session's own rules -
  // the same ones an edit in the app meets.
  const deep = [
    [{ ...good, geometry: { operations: [{ op: "add", region: { kind: "hexagon" } }] } }, /./],
    [{ ...good, boundaries: { ...good.boundaries, left: { type: "wormhole" } } }, /unknown boundary type/],
    [{ ...good, sources: [{ kind: "momentum", where: { kind: "rect", x0: 5, y0: 5, x1: 6, y1: 6 }, u: 1, v: 0, relaxationTime: 0.1 }] }, /./],
    [{ ...good, fluid: fluidById("mercury") }, /cell Reynolds/],
  ];
  for (const [project, reason] of deep) {
    assert.throws(() => session.importProject(project), reason);
  }
  assert.equal(JSON.stringify(projectFrom(session)), before, "every refusal left the session as it was");
  assert.equal(session.iteration, iteration, "and did not even reset it");
});

test("a project records the setup, not the history of edits or the field", () => {
  const session = workedSession();
  advance(session, 10);
  const project = projectFrom(session);
  assert.equal(project.format, PROJECT_FORMAT);
  assert.deepEqual(Object.keys(project).sort(),
    ["Re", "boundaries", "fluid", "format", "geometry", "probes", "scenario", "sources", "version", "view"]);
  assert.ok(JSON.stringify(project).length < 5000, "small: the field is left out");
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test("the field CSV holds every cell at full precision, and says what it is", () => {
  const session = advance(new SimulationSession("cylinder"), 30);
  const { comments, header, rows } = parseCsv(fieldCsv(session));
  assert.deepEqual(header, ["i", "j", "x", "y", "solid", "u", "v", "speed", "p", "vorticity"]);
  assert.equal(rows.length, session.grid.nx * session.grid.ny);
  assert.match(comments.join("\n"), /cylinder.*step 30/s);
  assert.match(comments.join("\n"), /pressure: gauge/);
  // Every pressure read back is the identical double.
  for (const row of rows) {
    const i = Number(row[0]);
    const j = Number(row[1]);
    assert.equal(Number(row[8]), session.grid.p[session.grid.idx(i, j)]);
  }
  const solid = rows.filter((row) => row[4] === "1").length;
  assert.ok(solid > 50, "the cylinder's cells are there and marked solid");
});

test("a NaN is exported as NaN, never as a blank or a zero", () => {
  assert.equal(number(NaN), "NaN");
  assert.equal(number(-Infinity), "-Infinity");
  assert.equal(number(0.1 + 0.2), "0.30000000000000004");
  const session = advance(new SimulationSession("cavity"), 2);
  session.grid.p[session.grid.idx(5, 5)] = NaN;
  const { rows } = parseCsv(fieldCsv(session));
  const row = rows.find((r) => r[0] === "5" && r[1] === "5");
  assert.equal(row[8], "NaN");
});

test("the probe CSV has one row per step and a column per probe and quantity", () => {
  const session = new SimulationSession("cavity");
  assert.match(probesCsv(session), /no probes pinned/);
  session.addProbe(0.5, 0.5);
  session.addProbe(0.2, 0.8);
  advance(session, 12);
  const { header, rows, comments } = parseCsv(probesCsv(session));
  assert.equal(rows.length, 12);
  assert.equal(header[0], "time");
  assert.ok(header.includes("P1_speed") && header.includes("P2_vorticity"));
  assert.equal(header.length, 1 + 2 * 6);
  assert.match(comments.join("\n"), /P2 at x = 0.2, y = 0.8/);
  const series = session.probes.probes[0].history.series("u");
  assert.equal(Number(rows[11][header.indexOf("P1_u")]), series.value[11]);
  assert.equal(Number(rows[11][0]), session.simulatedTime);
});

test("the residual CSV is the chart's data", () => {
  const session = advance(new SimulationSession("bend-smooth"), 15);
  const { header, rows, comments } = parseCsv(residualsCsv(session));
  assert.deepEqual(header, ["step", "continuity_error", "poisson_residual"]);
  assert.equal(rows.length, 15);
  assert.deepEqual(rows.map((r) => Number(r[0])), Array.from({ length: 15 }, (_, n) => n + 1));
  assert.equal(Number(rows[14][1]), session.lastStep.continuityError);
  assert.match(comments.join("\n"), /bound on continuity_error: 1e-7/);
});

test("an experiment's results export with their verdicts and how each run ended", () => {
  const experiment = experimentById("pipe");
  const runner = new ExperimentRunner(experiment, new SimulationSession("cavity")).start();
  while (runner.state === "running") {
    runner.session.advance();
    runner.afterStep();
  }
  const text = experimentCsv(experiment, runner);
  // Full precision: the exact reference is written as the double it is,
  // 0.9999999999999999, not tidied to 1.
  assert.match(text, /mean velocity \(flow rate \/ width\),1\.003\d*,0\.9999999999999999,agrees/);
  // A field containing a comma is quoted, so the columns stay aligned.
  assert.match(text, /,"6\*mu\*U\/w, from M9's per-face wall shear"\n/);
  assert.match(text, /\n"channel, from rest to steady",pressure-channel,20,\d+,[\d.]+,[\d.e-]+,steady\n/);
});
