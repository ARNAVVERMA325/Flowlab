// Data out of FlowLab: fields, probe histories, residuals and experiment
// results as CSV.
//
// Two rules, both the same rule the readouts follow:
//
//   NUMBERS ARE WRITTEN AT FULL PRECISION. String(x) is the shortest text that
//   reads back as the identical double, so a field exported and re-read is the
//   field, not a rounded picture of it - a test round-trips every value.
//
//   A BAD VALUE IS WRITTEN AS WHAT IT IS. NaN is "NaN", not an empty cell or a
//   zero; a solid cell's velocity is written as the solver holds it, and the
//   row says it is solid. A spreadsheet that silently averaged a zero into a
//   wall would be the flattering picture this project is not allowed to draw.
//
// Every file opens with '#' comment lines saying what it is: the scenario, the
// time, the units and the fluid. A CSV without them is a column of numbers
// nobody can interpret a week later.

import { speedAtCell } from "../physics/fieldStats.js";
import { vorticityAtCell } from "../physics/probe.js";
import { PROBE_QUANTITIES } from "../ui/probes.js";
import { boundaryPlanFor, pressureIsGauge } from "../solver/ns2d.js";

export function number(value) {
  if (typeof value !== "number") return "not a number";
  return String(value);
}

function header(lines) {
  return lines.map((line) => `# ${line}`).join("\n") + "\n";
}

// Provenance for every export: which flow, at what time, in which units.
export function describeRun(session) {
  const { scenario } = session;
  const material = scenario.material ?? null;
  return [
    `FlowLab export - ${scenario.label}`,
    `scenario ${session.scenarioId}, Re ${number(scenario.Re)}, step ${session.iteration}, t = ${number(session.simulatedTime)}`,
    material
      ? `fluid ${material.fluid.name}: rho ${number(material.fluid.rho)} kg/m^3, mu ${number(material.fluid.mu)} Pa s; ` +
        `1 length unit = ${number(material.physical.lengthUnit)} m, 1 speed unit = ${number(material.physical.speedUnit)} m/s`
      : `scenario units (dimensionless): nu ${number(scenario.params.nu)}, rho ${number(scenario.params.rho)}`,
  ];
}

// One row per cell, at cell centres. u and v are the averages of the two
// faces either side, as the velocity view draws them; p is the cell value,
// which is a GAUGE unless a pressure is prescribed somewhere.
export function fieldCsv(session) {
  const { grid } = session;
  const lines = [
    ...describeRun(session),
    "one row per cell; x, y are cell centres; u, v averaged from the staggered faces",
    `pressure: ${pressureIsGauge(boundaryPlanFor(grid, session.bc)) ? "gauge - only differences are meaningful" : "absolute (a pressure is prescribed)"}`,
  ];
  const rows = ["i,j,x,y,solid,u,v,speed,p,vorticity"];
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      const u = (grid.u[k] + grid.u[grid.idx(i - 1, j)]) / 2;
      const v = (grid.v[k] + grid.v[grid.idx(i, j - 1)]) / 2;
      const { x, y } = grid.cellCentre(i, j);
      rows.push([
        i, j, number(x), number(y), grid.solid[k],
        number(u), number(v), number(speedAtCell(grid, i, j)), number(grid.p[k]),
        number(vorticityAtCell(grid, i, j)),
      ].join(","));
    }
  }
  return header(lines) + rows.join("\n") + "\n";
}

// Every pinned probe's history, one row per sample, one column per probe and
// quantity. Probes are sampled together, once per solver step, so their time
// columns agree; that is checked rather than assumed.
export function probesCsv(session) {
  const probes = session.probes.probes;
  const lines = [...describeRun(session), "one row per solver step; probes sampled together"];
  if (probes.length === 0) return header([...lines, "no probes pinned"]) + "time\n";
  const quantities = Object.keys(PROBE_QUANTITIES);
  const columns = [];
  let time = null;
  for (const probe of probes) {
    lines.push(`${probe.label} at x = ${number(probe.x)}, y = ${number(probe.y)}`);
    for (const quantity of quantities) {
      const series = probe.history.series(quantity);
      if (time === null) time = series.time;
      else if (series.time.length !== time.length || series.time.some((t, n) => t !== time[n])) {
        throw new Error(`${probe.label} was not sampled at the same times as the others`);
      }
      columns.push({ name: `${probe.label}_${quantity}`, values: series.value });
    }
  }
  const rows = [["time", ...columns.map((c) => c.name)].join(",")];
  for (let n = 0; n < time.length; n++) {
    rows.push([number(time[n]), ...columns.map((c) => number(c.values[n]))].join(","));
  }
  return header(lines) + rows.join("\n") + "\n";
}

export function residualsCsv(session) {
  const continuity = session.residuals.series("continuity");
  const poisson = session.residuals.series("poisson");
  const lines = [
    ...describeRun(session),
    "continuity_error: max |div u - q| after each step; poisson_residual: the pressure solve's final residual",
    `bound on continuity_error: ${number(session.scenario.params.divergenceTol)}`,
  ];
  const rows = ["step,continuity_error,poisson_residual"];
  for (let n = 0; n < continuity.time.length; n++) {
    rows.push([continuity.time[n], number(continuity.value[n]), number(poisson.value[n])].join(","));
  }
  return header(lines) + rows.join("\n") + "\n";
}

// A finished experiment: its comparison rows, then how each run ended.
export function experimentCsv(experiment, runner) {
  const csvText = (value) => {
    const text = typeof value === "number" ? number(value) : String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [`FlowLab experiment - ${experiment.title}`, `reference: ${experiment.reference}`];
  const rows = ["quantity,measured,reference,status,note"];
  for (const row of runner.conclusion?.rows ?? []) {
    rows.push([row.quantity, row.measured, row.reference, row.status, row.note].map(csvText).join(","));
  }
  rows.push("");
  rows.push("run,scenario,Re,steps,time,change_rate,ending");
  for (const run of runner.results) {
    const ending = run.steady === undefined ? `averaged over ${run.sampleCount} samples` : run.steady ? "steady" : "NOT steady (capped)";
    rows.push([run.label, run.scenario, run.Re, run.steps, run.time, run.changeRate, ending].map(csvText).join(","));
  }
  if (runner.conclusion?.summary) lines.push(`summary: ${runner.conclusion.summary}`);
  return header(lines) + rows.join("\n") + "\n";
}

// Reads a CSV written above back into its header lines and rows of text. Used
// by the tests to prove the round trip, and small enough to trust.
export function parseCsv(text) {
  const comments = [];
  const rows = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# ")) comments.push(line.slice(2));
    else rows.push(line.split(","));
  }
  return { comments, header: rows[0], rows: rows.slice(1) };
}
