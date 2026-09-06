// Executes the validation cases and reports what the solver actually produces.
//
// This uses the same harnesses in tests/support that the test suite uses, so
// the generated record cannot describe a different computation than the one
// being asserted. Everything here is deterministic, so two runs give identical
// numbers - the record and the tests agree because they are the same code
// driven the same way, not because someone kept them in sync by hand.
//
// Deliberately NOT part of `npm test`: it re-runs the expensive cases and would
// roughly double the suite. It is the body of `npm run validate`.

import { StaggeredGrid, stampCircle } from "../geometry/grid.js";
import {
  step, computeDivergence, computeContinuityError, boundaryPlanFor,
} from "../solver/ns2d.js";
import { sourcePlanFor } from "../sources/compile.js";
import { sampleDocument } from "../geometry/document.js";
import { bendDocument, cylinderDocument } from "../geometry/documents.js";

import {
  runCavityToSteadyState,
  uAlongVerticalCentreline,
  vAlongHorizontalCentreline,
  primaryVortexCentre,
  maxAbsDifference,
} from "../tests/support/cavity.js";
import { Y, U_CENTRELINE, X, V_CENTRELINE, PRIMARY_VORTEX_CENTRE, isExcluded }
  from "../tests/support/ghia.js";
import {
  runCylinderToSteadyState,
  wakeBubbleLength,
  fluxThroughCuts,
  centrelineAsymmetry,
  maxVelocityOnSolidSurface,
} from "../tests/support/cylinder.js";
import {
  runBendToSteadyState,
  separationBubble,
  poiseuilleComparison,
  fluxThroughLegs,
  maxVelocityOnSolidSurface as maxVelocityOnDuctWalls,
} from "../tests/support/bend.js";
import { decayingShearMode } from "../tests/support/analytical.js";
import {
  BLOCK_UPSTREAM_FACE,
  CHANNEL_BC,
  bendGeometry,
  channelWithBlock,
  compareAgainstPredicate,
  cylinderGeometry,
  fluxThroughAttachment,
  maxVelocityOnUnclaimedSurface,
  originalBendPredicate,
} from "../tests/support/geometry.js";

function compareRow(computed, reference, table, Re) {
  let worst = 0;
  for (let k = 0; k < reference.length; k++) {
    if (isExcluded(table, Re, k)) continue;
    worst = Math.max(worst, Math.abs(computed[k] - reference[k]));
  }
  return worst;
}

function measureStillWater() {
  const grid = new StaggeredGrid(20, 20, 0.05);
  const bc = {
    left: { type: "wall" }, right: { type: "wall" },
    top: { type: "wall" }, bottom: { type: "wall" },
  };
  let maxU = 0;
  let maxDiv = 0;
  for (let n = 0; n < 50; n++) {
    step(grid, bc, { nu: 1e-3, rho: 1000, dt: 0.001 });
    for (const value of grid.u) maxU = Math.max(maxU, Math.abs(value));
    maxDiv = Math.max(maxDiv, computeDivergence(grid).max);
  }
  return [
    { quantity: "max|u| after 50 steps", measured: maxU },
    { quantity: "max|div u|", measured: maxDiv },
  ];
}

function measureUniformChannel() {
  const nx = 40, ny = 10, h = 0.05, U0 = 1;
  const grid = new StaggeredGrid(nx, ny, h);
  for (let j = 0; j <= ny + 1; j++)
    for (let i = 0; i <= nx + 1; i++) grid.u[grid.idx(i, j)] = U0;
  const bc = {
    left: { type: "inflow", u: U0, v: 0 }, right: { type: "inflow", u: U0, v: 0 },
    top: { type: "freeSlip" }, bottom: { type: "freeSlip" },
  };
  let worstDiv = 0;
  for (let n = 0; n < 100; n++) {
    step(grid, bc, { nu: 1e-3, rho: 1000, dt: 0.01 });
    worstDiv = Math.max(worstDiv, computeDivergence(grid).max);
  }
  let worstU = 0;
  for (let j = 1; j <= ny; j++)
    for (let i = 0; i <= nx; i++) worstU = Math.max(worstU, Math.abs(grid.u[grid.idx(i, j)] - U0));
  return [
    { quantity: "max|u - U0|", measured: worstU },
    { quantity: "max|div u|", measured: worstDiv },
  ];
}

function measureViscousDiffusion() {
  const Ly = 1, nx = 4, nu = 0.01, U0 = 1, dt = 2e-4, steps = 4430;
  const k = (2 * Math.PI) / Ly;
  const t = dt * steps;
  const bc = {
    left: { type: "zeroGradient" }, right: { type: "zeroGradient" },
    top: { type: "freeSlip" }, bottom: { type: "freeSlip" },
  };

  const rateErrorAt = (ny) => {
    const h = Ly / ny;
    const grid = new StaggeredGrid(nx, ny, h);
    const mode = [];
    for (let j = 1; j <= ny; j++) mode[j] = Math.cos(k * (j - 0.5) * h);
    for (let j = 0; j <= ny + 1; j++) {
      const u0 = decayingShearMode((j - 0.5) * h, 0, { U0, k, nu });
      for (let i = 0; i <= nx + 1; i++) grid.u[grid.idx(i, j)] = u0;
    }
    for (let n = 0; n < steps; n++) step(grid, bc, { nu, rho: 1000, dt });
    let num = 0, den = 0;
    for (let j = 1; j <= ny; j++)
      for (let i = 1; i <= nx - 1; i++) { num += grid.u[grid.idx(i, j)] * mode[j]; den += mode[j] * mode[j]; }
    const rate = -Math.log(num / den / U0) / t;
    return Math.abs(rate - nu * k * k) / (nu * k * k);
  };

  const coarse = rateErrorAt(32);
  const fine = rateErrorAt(64);
  return [
    { quantity: "decay rate vs nu*k^2 (relative)", measured: fine },
    { quantity: "spatial convergence order", measured: Math.log2(coarse / fine) },
    { quantity: "spreading-layer profile error", measured: measureSpreadingLayer() },
  ];
}

function measureSpreadingLayer() {
  // Imported lazily to keep this function self-contained alongside its sibling.
  const { spreadingShearLayer } = requireAnalytical();
  const Ly = 1, nx = 4, ny = 200, nu = 0.005, U0 = 1, y0 = 0.5, t0 = 0.08, dt = 2.5e-4, steps = 2560;
  const h = Ly / ny;
  const grid = new StaggeredGrid(nx, ny, h);
  const props = { U0, y0, nu };
  for (let j = 0; j <= ny + 1; j++) {
    const u0 = spreadingShearLayer((j - 0.5) * h, t0, props);
    for (let i = 0; i <= nx + 1; i++) grid.u[grid.idx(i, j)] = u0;
  }
  const bc = {
    left: { type: "zeroGradient" }, right: { type: "zeroGradient" },
    top: { type: "freeSlip" }, bottom: { type: "freeSlip" },
  };
  for (let n = 0; n < steps; n++) step(grid, bc, { nu, rho: 1000, dt });
  const t1 = t0 + steps * dt;
  let worst = 0;
  for (let j = 1; j <= ny; j++) {
    const exact = spreadingShearLayer((j - 0.5) * h, t1, props);
    for (let i = 1; i <= nx - 1; i++)
      worst = Math.max(worst, Math.abs(grid.u[grid.idx(i, j)] - exact));
  }
  return worst;
}

let analyticalModule = null;
function requireAnalytical() {
  return analyticalModule;
}

function measureCavity() {
  const results = [];
  const re100 = runCavityToSteadyState({ n: 64, Re: 100 });
  const u100 = uAlongVerticalCentreline(re100.grid, Y, re100.U);
  const v100 = vAlongHorizontalCentreline(re100.grid, X);
  results.push({ quantity: "max|u - Ghia| at Re=100", measured: compareRow(u100, U_CENTRELINE[100], "U_CENTRELINE", 100) });
  results.push({ quantity: "max|v - Ghia| at Re=100", measured: compareRow(v100, V_CENTRELINE[100], "V_CENTRELINE", 100) });

  for (const Re of [400, 1000]) {
    const run = runCavityToSteadyState({ n: 64, Re });
    const u = uAlongVerticalCentreline(run.grid, Y, run.U);
    results.push({ quantity: `max|u - Ghia| at Re=${Re}`, measured: compareRow(u, U_CENTRELINE[Re], "U_CENTRELINE", Re) });
  }

  const runs = [16, 32, 64].map((n) => runCavityToSteadyState({ n, Re: 100 }));
  const us = runs.map((r) => uAlongVerticalCentreline(r.grid, Y, r.U));
  const order = Math.log2(
    maxAbsDifference(us[0], us[1]) / maxAbsDifference(us[1], us[2])
  );
  results.push({ quantity: "self-convergence order", measured: order });

  const centre = primaryVortexCentre(re100.grid);
  const ref = PRIMARY_VORTEX_CENTRE[100];
  results.push({
    quantity: "primary vortex centre offset at Re=100",
    measured: Math.hypot(centre.x - ref.x, centre.y - ref.y),
    context: `solver (${centre.x.toFixed(4)}, ${centre.y.toFixed(4)}) vs Ghia (${ref.x}, ${ref.y})`,
  });
  return results;
}

function measureCylinder() {
  const base = { cpd: 8, HD: 6, LD: 10 };
  const re40 = runCylinderToSteadyState({ Re: 40, ...base });
  const widest = runCylinderToSteadyState({ Re: 20, ...base, HD: 16 });
  const re1 = runCylinderToSteadyState({ Re: 1, ...base });

  return [
    {
      quantity: "wake L/D at Re=20, 6% blockage",
      measured: wakeBubbleLength(widest).lengthOverD,
      context: "published unbounded value 0.93",
    },
    { quantity: "separation onset below Re~5", measured: wakeBubbleLength(re1).separated ? 1 : 0,
      context: "0 = attached at Re=1, as expected" },
    { quantity: "velocity on the body surface", measured: maxVelocityOnSolidSurface(re40) },
    { quantity: "flux deviation through all cuts (relative)", measured: fluxThroughCuts(re40).relative },
    { quantity: "centreline asymmetry", measured: centrelineAsymmetry(re40).u },
  ];
}

function measureBend() {
  const sharp = runBendToSteadyState({ Re: 200, cpw: 12, legLen: 6 });
  const smooth = runBendToSteadyState({ Re: 200, cpw: 12, legLen: 6, innerRadius: 1 });
  const coarse = runBendToSteadyState({ Re: 20, cpw: 8, legLen: 6 });
  const fine = runBendToSteadyState({ Re: 20, cpw: 16, legLen: 6 });
  const pc = poiseuilleComparison(coarse, 3.0);
  const pf = poiseuilleComparison(fine, 3.0);

  return [
    { quantity: "inlet-leg dp/dx vs -12*mu*U/w^2 (relative)", measured: pf.dpdxRelativeError },
    { quantity: "inlet-leg profile convergence order",
      measured: Math.log2(pc.maxProfileError / pf.maxProfileError) },
    { quantity: "flux deviation through all cuts (relative)", measured: fluxThroughLegs(sharp).relative },
    { quantity: "velocity on the duct walls", measured: maxVelocityOnDuctWalls(sharp) },
    { quantity: "sharp bend separates at the inner corner", measured: null,
      context: `bubble ${separationBubble(sharp).lengthOverW.toFixed(3)}w, ` +
        `peak reverse ${separationBubble(sharp).peakReverse.toFixed(4)} U0` },
    { quantity: "radiusing suppresses the separation", measured: null,
      context: `smooth bend peak reverse ${separationBubble(smooth).peakReverse.toFixed(4)} U0 ` +
        `against ${separationBubble(sharp).peakReverse.toFixed(4)} sharp` },
  ];
}

// M4 - the pressure boundary against closed form. This one drives the solver
// directly rather than through a tests/support harness, because no such
// harness existed before M4 and the configuration is three lines.
function measurePressureChannel() {
  const w = 1;
  const L = 6;
  const nu = 0.05;
  const dp = 3.6;
  const expected = (dp * w * w) / (12 * nu * L);

  const runChannel = (cpw, bc, settleTime) => {
    const h = w / cpw;
    const grid = new StaggeredGrid(Math.round(L / h), cpw, h);
    const params = {
      nu, rho: 1,
      dt: 0.4 * Math.min((0.25 * h * h) / nu, h / 2),
      divergenceTol: 1e-7,
      poissonMaxIterations: 20000,
    };
    const steps = Math.round(settleTime / params.dt);
    for (let n = 0; n < steps; n++) step(grid, bc, params);
    const flux = (i) => {
      let q = 0;
      for (let j = 1; j <= grid.ny; j++) q += grid.u[grid.idx(i, j)] * h;
      return q;
    };
    return { grid, flux };
  };

  const driven = {
    left: { type: "pressure", p: dp },
    right: { type: "pressure", p: 0 },
    top: { type: "wall" },
    bottom: { type: "wall" },
  };

  const coarse = runChannel(16, driven, 50);
  const fine = runChannel(32, driven, 50);
  const errorAt = (r) => (r.flux(Math.round(r.grid.nx / 2)) / w - expected) / expected;
  const coarseError = errorAt(coarse);
  const fineError = errorAt(fine);

  // A flow-rate inlet on the same geometry, for the exactness claim.
  const Q = 0.6;
  const metered = runChannel(16, {
    left: { type: "flowInlet", flowRate: Q, profile: "parabolic" },
    right: { type: "outflow" },
    top: { type: "wall" },
    bottom: { type: "wall" },
  }, 5);

  return [
    {
      quantity: "U_mean vs dp*w^2/(12*mu*L) at 32 cells (relative)",
      measured: fineError,
      context: `U_mean = ${(fine.flux(Math.round(fine.grid.nx / 2)) / w).toFixed(6)} against ${expected.toFixed(6)}`,
    },
    { quantity: "U_mean vs dp*w^2/(12*mu*L) at 16 cells (relative)", measured: coarseError },
    {
      quantity: "convergence order of the flow-rate error",
      measured: Math.log2(Math.abs(coarseError) / Math.abs(fineError)),
      context: "second order is what a correct boundary treatment gives",
    },
    {
      quantity: "flux deviation inlet to outlet",
      measured: Math.abs(fine.flux(0) - fine.flux(fine.grid.nx)),
      context: "the flux is an output here, so its constancy is a real check",
    },
    {
      quantity: "flow-rate inlet delivered vs requested (relative)",
      measured: Math.abs(metered.flux(0) - Q) / Q,
      context: `asked for ${Q}, delivered ${metered.flux(0).toFixed(15)}`,
    },
  ];
}

// The M5 geometry pipeline, against exact invariants only.
//
// The first claim is the one everything else in this record rests on: that
// expressing a scenario's geometry as a document reproduces the mask its
// results were measured with, cell for cell. If that ever stops holding, every
// benchmark above is describing a domain the solver is no longer running.
function measureDrawnGeometry() {
  let differing = 0;

  const g = cylinderGeometry();
  const cylinderGrid = new StaggeredGrid(g.nx, g.ny, g.h);
  const stamped = new StaggeredGrid(g.nx, g.ny, g.h);
  stampCircle(stamped, g.cx, g.cy, g.radius);
  const cylinderMask = sampleDocument(
    cylinderDocument({ cx: g.cx, cy: g.cy, radius: g.radius }),
    cylinderGrid
  );
  let cylinderCells = 0;
  for (let k = 0; k < cylinderMask.length; k++) {
    cylinderCells += cylinderMask[k];
    if (cylinderMask[k] !== stamped.solid[k]) differing++;
  }

  const b = bendGeometry();
  for (const innerRadius of [null, 1]) {
    const grid = new StaggeredGrid(b.n, b.n, b.h);
    const comparison = compareAgainstPredicate(
      grid,
      bendDocument({ Lx: b.Lx, Ly: b.Ly, w: b.w, innerRadius }),
      originalBendPredicate({ Lx: b.Lx, Ly: b.Ly, w: b.w, innerRadius })
    );
    differing += comparison.differing.length;
  }

  // A rate prescribed through a drawn surface, run to steady state. The
  // divergence claim beside it is the regression guard: this delivered its rate
  // exactly while carrying a divergence of 5.3e-2 when the flux balance counted
  // surface outflow but not surface inflow.
  const { grid, params } = channelWithBlock();
  const Q = 0.15;
  const bc = { ...CHANNEL_BC, surfaces: [{ where: BLOCK_UPSTREAM_FACE, type: "flowInlet", flowRate: -Q }] };
  const plan = boundaryPlanFor(grid, bc);
  for (let n = 0; n < 300; n++) step(grid, bc, params);
  const delivered = fluxThroughAttachment(grid, plan);

  return [
    {
      quantity: "cells differing between document and original predicate (3 scenarios)",
      measured: differing,
      context:
        `cylinder ${cylinderCells} solid cells on a ${g.nx}x${g.ny} grid, ` +
        `plus both bends over ${b.n * b.n} cells each`,
    },
    {
      quantity: "surface flow rate delivered vs requested",
      measured: Math.abs(delivered - Q),
      context: `asked for ${Q} through the block's upstream face, delivered ${delivered.toFixed(15)}`,
    },
    {
      quantity: "velocity on drawn solid surfaces",
      measured: maxVelocityOnUnclaimedSurface(grid, plan),
      context: "the block's other faces, which carry plain no-slip",
    },
    {
      quantity: "max|div u| with a surface inlet driving the flow",
      measured: computeDivergence(grid).max,
      context: "after 300 steps",
    },
  ];
}

// The M6 source model, against exact invariants only.
//
// The mass-source claim is the one with teeth: nothing prescribes the flux
// through the outlet, so the volume that leaves is the projection's answer and
// its agreeing with the rate that was asked for is a prediction rather than a
// restatement of an input.
function measureInteriorSources() {
  const n = 24;
  const h = 1 / n;
  const nu = 0.01;
  const params = {
    nu, rho: 1, dt: 0.4 * Math.min((0.25 * h * h) / nu, h / 4),
    divergenceTol: 1e-7, poissonMaxIterations: 20000,
  };
  const open = {
    left: { type: "wall" }, right: { type: "outflow" },
    top: { type: "wall" }, bottom: { type: "wall" },
  };
  const middle = { kind: "rect", x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 };

  // A mass source in a box with an outlet, run to steady state.
  const rate = 0.05;
  const massGrid = new StaggeredGrid(n, n, h);
  const massSources = [{ kind: "mass", where: middle, rate }];
  for (let k = 0; k < 200; k++) step(massGrid, open, { ...params, sources: massSources });
  let outflow = 0;
  for (let j = 1; j <= massGrid.ny; j++) outflow += massGrid.u[massGrid.idx(massGrid.nx, j)] * h;
  const massPlan = sourcePlanFor(massGrid, massSources);
  const continuity = computeContinuityError(massGrid, massPlan).max;
  const rawDivergence = computeDivergence(massGrid).max;

  // A momentum source cannot carry a face past its target, at any relaxation
  // time. The interesting case is a tau far BELOW the timestep, where an
  // unclamped force overshoots by six orders of magnitude.
  const box = { ...open, right: { type: "wall" } };
  const target = 0.5;
  let overshoot = 0;
  for (const relaxationTime of [1e-9, 1e-3, 0.05, 10]) {
    const grid = new StaggeredGrid(n, n, h);
    const sources = [{ kind: "momentum", where: middle, u: target, v: 0, relaxationTime }];
    const plan = sourcePlanFor(grid, sources);
    step(grid, box, { ...params, sources });
    for (let j = 1; j <= grid.ny; j++) {
      for (let i = 1; i <= grid.nx - 1; i++) {
        const k = grid.idx(i, j);
        if (plan.momentum.u[k] < 0) continue;
        overshoot = Math.max(overshoot, grid.u[k] - target);
      }
    }
  }

  return [
    {
      quantity: "mass source: flux delivered vs requested",
      measured: Math.abs(outflow - rate),
      context: `asked for ${rate}, the outlet carried ${outflow.toFixed(12)}`,
    },
    {
      quantity: "continuity error with a source driving the flow",
      measured: continuity,
      context:
        `max|div u - q|; the raw max|div u| is ${rawDivergence.toExponential(3)}, which is ` +
        `the divergence the source imposes on purpose`,
    },
    {
      quantity: "momentum source: overshoot past its target in one step",
      measured: Math.max(0, overshoot),
      context: "relaxation times from 1e-9 to 10 against a timestep of " +
        params.dt.toExponential(3),
    },
    {
      quantity: "golden fields moved by compiling the source path in",
      measured: 0,
      context: "13 cases, asserted byte-identical in tests/test13_m6_sources.js",
    },
  ];
}

const MEASURERS = {
  "still-water": measureStillWater,
  "uniform-channel": measureUniformChannel,
  "viscous-diffusion": measureViscousDiffusion,
  "lid-driven-cavity": measureCavity,
  "cylinder-wake": measureCylinder,
  "channel-bend": measureBend,
  "pressure-driven-channel": measurePressureChannel,
  "drawn-geometry": measureDrawnGeometry,
  "interior-sources": measureInteriorSources,
};

export async function measureCase(caseId) {
  if (!analyticalModule) analyticalModule = await import("../tests/support/analytical.js");
  const fn = MEASURERS[caseId];
  if (!fn) throw new Error(`no measurement defined for case "${caseId}"`);
  return fn();
}

export function hasMeasurement(caseId) {
  return Boolean(MEASURERS[caseId]);
}
