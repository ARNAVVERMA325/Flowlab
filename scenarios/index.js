// Simulation configurations for the harness.
//
// This is the "simulation configuration" layer: it turns a named scenario into
// a grid, a boundary-condition descriptor and solver parameters. It sits
// between the UI and the geometry/solver layers so that neither the UI knows
// how to build a grid nor the solver knows what a "bend" is.
//
// These mirror the validated cases in /tests. They are written out here rather
// than imported from the test suite because a harness depending on test
// support code is the wrong direction - but that does mean the two can drift.
// Anything changed here is no longer the configuration that was validated.

import { StaggeredGrid } from "../geometry/grid.js";
import { applyDocument } from "../geometry/document.js";
import { bendDocument, cylinderDocument, emptyDocument } from "../geometry/documents.js";

// Scenarios no longer carry a timestep. The driver calls
// solver/stability.js computeStableTimestep every step and sizes dt from the
// field as it actually is, which is what M1 replaced the hand-picked values
// with. What a scenario supplies instead is the safety factor - the fraction
// of the hard stability limit it is willing to use.
//
// 0.4 is the default and is measured, not guessed. Walking the factor up until
// each scenario diverges: the cavity and the cylinder both survive 0.95, and
// the sharp bend is stable to 0.6 and blows up at 0.8, 0.9 and 0.95 alike -
// not on a CFL violation, but locally at the mitre corner, which the
// linearised limit does not describe. The bend is the binding constraint, and
// 0.4 leaves 1.5x margin below its reproducible boundary.
const DEFAULT_SAFETY = 0.4;

function lidDrivenCavity(override) {
  const n = 64;
  const U = 1;
  const Re = 1000;
  const h = 1 / n;
  const nu = U / Re;
  const grid = new StaggeredGrid(n, n, h);
  const geometry = override ?? emptyDocument();
  applyDocument(grid, geometry);
  return {
    id: "cavity",
    label: "Lid-driven cavity (Re 1000)",
    note: "Test 4 - the benchmark gate. Top lid slides right; three no-slip walls.",
    grid,
    geometry,
    bc: {
      left: { type: "wall" },
      right: { type: "wall" },
      bottom: { type: "wall" },
      top: { type: "wall", u: U },
    },
    params: { nu, rho: 1, divergenceTol: 1e-7 },
    timestep: { safety: DEFAULT_SAFETY },
    Re,
    reference: { U, L: 1, speed: "lid speed", length: "cavity side" },
  };
}

function cylinderInChannel(override) {
  const D = 1;
  const cpd = 12;
  const h = D / cpd;
  const U = 1;
  const Re = 100;
  const nu = (U * D) / Re;
  let ny = Math.round(6 * cpd);
  if (ny % 2 === 0) ny += 1;
  const nx = Math.round(14 * cpd);
  const grid = new StaggeredGrid(nx, ny, h);
  const jc = (ny + 1) / 2;
  // The override, when given, replaces the scenario's own geometry - and is
  // applied BEFORE the initial condition is seeded below. Seeding first would
  // leave cells that the override exposes holding whatever their slots
  // happened to contain, which is the stale-state hazard the whole restart
  // rule exists to avoid.
  const geometry = override ?? cylinderDocument({
    cx: (Math.round(3.5 / h + 0.5) - 0.5) * h,
    cy: (jc - 0.5) * h,
    radius: D / 2,
  });
  applyDocument(grid, geometry);
  for (let j = 0; j <= ny + 1; j++) {
    for (let i = 0; i <= nx + 1; i++) {
      if (!grid.solid[grid.idx(i, j)]) grid.u[grid.idx(i, j)] = U;
    }
  }
  return {
    id: "cylinder",
    label: "Flow past a cylinder (Re 100)",
    note: "Test 5 - uniform inflow, free-slip channel walls, open outflow.",
    grid,
    geometry,
    bc: {
      left: { type: "inflow", u: U, v: 0 },
      right: { type: "outflow" },
      top: { type: "freeSlip" },
      bottom: { type: "freeSlip" },
    },
    params: { nu, rho: 1, divergenceTol: 1e-7 },
    timestep: { safety: DEFAULT_SAFETY },
    Re,
    reference: { U, L: D, speed: "inlet speed", length: "cylinder diameter" },
  };
}

function channelBend({ innerRadius, id, label, note, Re = 200 }, override) {
  const w = 1;
  const cpw = 12;
  const legLen = 6;
  const h = w / cpw;
  const U = 1;
  const nu = (U * w) / Re;
  const Lx = legLen * w + w;
  const Ly = Lx;
  const nx = Math.round(Lx / h);
  const ny = Math.round(Ly / h);
  const grid = new StaggeredGrid(nx, ny, h);

  const geometry = override ?? bendDocument({ Lx, Ly, w, innerRadius });
  applyDocument(grid, geometry);

  return {
    id,
    label,
    note,
    grid,
    geometry,
    bc: {
      left: { type: "inflow", u: U, v: 0 },
      right: { type: "wall" },
      top: { type: "wall" },
      bottom: { type: "outflow" },
    },
    // The old fixed value here had to guess the peak speed through the bend and
    // got it wrong: sizing against 2*U0 put CFL at 0.86 once the corner jet
    // formed and the run diverged, because the flow reaches about 2.9*U0.
    // Nothing is guessed now - the driver measures it every step.
    params: { nu, rho: 1, divergenceTol: 1e-7 },
    timestep: { safety: DEFAULT_SAFETY },
    Re,
    reference: { U, L: w, speed: "inlet speed", length: "duct width" },
  };
}

// M4 - a channel driven by a pressure difference rather than a prescribed
// velocity. Nothing sets the flow rate here: the projection works it out from
// the pressure drop, and the steady answer is the one plane Poiseuille
// predicts. This is the configuration validated in tests/test10 and recorded
// in the validation registry.
function pressureChannel(override) {
  const w = 1;
  const cpw = 24;
  const L = 6;
  const h = w / cpw;
  const nu = 0.05;
  const dp = 3.6;
  const grid = new StaggeredGrid(Math.round(L / h), cpw, h);
  const geometry = override ?? emptyDocument();
  applyDocument(grid, geometry);
  // U_mean = dp*w^2/(12*mu*L), which is 1 for these numbers.
  const U = (dp * w * w) / (12 * nu * L);
  return {
    id: "pressure-channel",
    label: "Pressure-driven channel",
    note:
      "M4 - pressure prescribed at both ends, no-slip walls. The flow rate is an " +
      "output, not an input: it settles at the plane Poiseuille value for this " +
      "pressure drop.",
    grid,
    geometry,
    bc: {
      left: { type: "pressure", p: dp },
      right: { type: "pressure", p: 0 },
      top: { type: "wall" },
      bottom: { type: "wall" },
    },
    params: { nu, rho: 1, divergenceTol: 1e-7, poissonMaxIterations: 20000 },
    timestep: { safety: DEFAULT_SAFETY },
    Re: Math.round((U * w) / nu),
    // The speed here is an OUTPUT - it is set by the viscosity through the
    // formula above - so this scenario cannot be re-run at another Reynolds
    // number by changing nu alone: U moves with it and Re goes as 1/nu^2.
    // SimulationSession.setReynolds() reads this flag and refuses.
    reference: { U, L: w, speed: "mean speed from the pressure drop", length: "channel width", speedSetByViscosity: true },
  };
}

// M4 - a segmented boundary: the left wall is mostly solid with a flow-rate
// inlet across its middle third. There is no way to say this with one condition
// per side, which is what segments are for.
function segmentedJet(override) {
  const w = 1;
  const cpw = 20;
  const h = w / cpw;
  const nx = Math.round(5 / h);
  const ny = cpw;
  const nu = 0.004;
  const Q = 0.3;
  const grid = new StaggeredGrid(nx, ny, h);
  const geometry = override ?? emptyDocument();
  applyDocument(grid, geometry);
  return {
    id: "jet",
    label: "Jet from a segmented inlet",
    note:
      "M4 - the left boundary is wall, then a parabolic flow-rate inlet across " +
      "its middle third, then wall again. The inlet delivers exactly its stated " +
      "rate through the open part.",
    grid,
    geometry,
    bc: {
      left: [
        { from: 0, to: w / 3, type: "wall" },
        { from: w / 3, to: (2 * w) / 3, type: "flowInlet", flowRate: Q, profile: "parabolic" },
        { from: (2 * w) / 3, to: w, type: "wall" },
      ],
      right: { type: "outflow" },
      top: { type: "wall" },
      bottom: { type: "wall" },
    },
    params: { nu, rho: 1, divergenceTol: 1e-7, poissonMaxIterations: 20000 },
    timestep: { safety: DEFAULT_SAFETY },
    Re: Math.round((((Q / (w / 3)) * w) / 3) / nu),
    reference: { U: Q / (w / 3), L: w / 3, speed: "mean speed through the open inlet", length: "inlet width" },
  };
}

// Labels are carried on the entry rather than read out of a built scenario, so
// listing the menu does not mean allocating four grids and stamping four masks.
export const SCENARIOS = [
  {
    id: "bend-sharp",
    label: "Sharp 90 degree bend (Re 200)",
    build: (geometry) =>
      channelBend({
        innerRadius: null,
        id: "bend-sharp",
        label: "Sharp 90 degree bend (Re 200)",
        note: "Test 6 - mitre bend. Separates off the inner corner.",
      }, geometry),
  },
  {
    id: "bend-smooth",
    label: "Smooth 90 degree bend (Re 200)",
    build: (geometry) =>
      channelBend({
        innerRadius: 1,
        id: "bend-smooth",
        label: "Smooth 90 degree bend (Re 200)",
        note: "Test 6 - same duct width, inner corner radiused. Separation suppressed.",
      }, geometry),
  },
  { id: "cylinder", label: "Flow past a cylinder (Re 100)", build: cylinderInChannel },
  { id: "cavity", label: "Lid-driven cavity (Re 1000)", build: lidDrivenCavity },
  { id: "pressure-channel", label: "Pressure-driven channel", build: pressureChannel },
  { id: "jet", label: "Jet from a segmented inlet", build: segmentedJet },
];

export const DEFAULT_SCENARIO = "bend-sharp";

// `geometry` replaces the scenario's own document when given, which is how a
// session rebuilds a scenario carrying user edits. Applied before the scenario
// seeds its initial condition, so cells the edit exposes are seeded like any
// other fluid cell.
export function buildScenario(id, geometry) {
  const entry = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
  return entry.build(geometry);
}
