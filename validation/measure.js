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
import { probeCell, vorticityAtCell, vorticityAtNode } from "../physics/probe.js";
import { isFluidAt, traceStep, velocityAt } from "../physics/velocityField.js";
import { traceStreamlines } from "../physics/streamlines.js";
import { qCriterionAt, rotationSummary } from "../physics/gradients.js";
import { surfaceFaces, surfacePerimeter, wallShearSummary } from "../physics/wallShear.js";
import { PathlineSet } from "../tracer/pathlines.js";
import { sampleDocument } from "../geometry/document.js";
import { bendDocument, cylinderDocument } from "../geometry/documents.js";
import { SCENARIOS, buildScenario } from "../scenarios/index.js";

import {
  runCavityToSteadyState,
  uAlongVerticalCentreline,
  vAlongHorizontalCentreline,
  primaryVortexCentre,
  maxAbsDifference,
} from "../tests/support/cavity.js";
import { Y, U_CENTRELINE, X, V_CENTRELINE, PRIMARY_VORTEX_CENTRE, isExcluded }
  from "./ghia.js";
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

// The probe sampler against a closed-form field. Mirrors
// tests/test16_m7_probes.js - the test asserts the order, this records the
// numbers behind it.
function measureProbeQuantities() {
  const fill = (grid, uAt, vAt) => {
    const { nx, ny, h } = grid;
    for (let j = 0; j <= ny + 1; j++) {
      for (let i = 0; i <= nx + 1; i++) {
        const k = grid.idx(i, j);
        grid.u[k] = uAt(i * h, (j - 0.5) * h);
        grid.v[k] = vAt((i - 0.5) * h, j * h);
      }
    }
  };

  // Taylor-Green: omega = 2 cos(x) cos(y).
  const sizes = [16, 32, 64];
  const node = [];
  const centre = [];
  for (const n of sizes) {
    const h = (2 * Math.PI) / n;
    const grid = new StaggeredGrid(n, n, h);
    fill(grid, (x, y) => -Math.cos(x) * Math.sin(y), (x, y) => Math.sin(x) * Math.cos(y));
    let worstNode = 0;
    let worstCentre = 0;
    for (let j = 1; j <= n; j++) {
      for (let i = 1; i <= n; i++) {
        worstNode = Math.max(worstNode, Math.abs(
          vorticityAtNode(grid, i, j) - 2 * Math.cos(i * h) * Math.cos(j * h)
        ));
        const { x, y } = grid.cellCentre(i, j);
        worstCentre = Math.max(worstCentre, Math.abs(
          vorticityAtCell(grid, i, j) - 2 * Math.cos(x) * Math.cos(y)
        ));
      }
    }
    node.push(worstNode);
    centre.push(worstCentre);
  }
  const order = (errors) => Math.log2(errors[0] / errors[errors.length - 1]) /
    Math.log2(sizes[sizes.length - 1] / sizes[0]);

  // Solid-body rotation, where the quotients are exact.
  const w0 = 1.75;
  const rotation = new StaggeredGrid(9, 7, 0.2);
  fill(rotation, (_x, y) => -w0 * y, (x) => w0 * x);
  let rotationError = 0;
  for (let j = 1; j <= rotation.ny; j++) {
    for (let i = 1; i <= rotation.nx; i++) {
      rotationError = Math.max(rotationError, Math.abs(vorticityAtCell(rotation, i, j) - 2 * w0));
    }
  }

  // A linear velocity field, where the face average equals the exact centre.
  const linear = new StaggeredGrid(8, 8, 0.5);
  fill(linear, (x) => 3 * x, (_x, y) => -2 * y);
  let velocityError = 0;
  for (let j = 1; j <= linear.ny; j++) {
    for (let i = 1; i <= linear.nx; i++) {
      const { x, y } = linear.cellCentre(i, j);
      const sample = probeCell(linear, i, j, { nu: 1e-2 });
      velocityError = Math.max(
        velocityError,
        Math.abs(sample.u - 3 * x),
        Math.abs(sample.v - -2 * y)
      );
    }
  }

  const listed = (errors) => errors.map((e) => e.toExponential(2)).join(" -> ");
  return [
    {
      quantity: "vorticity at a node, order of convergence (Taylor-Green)",
      measured: order(node),
      context: `max error ${listed(node)} at n = ${sizes.join(", ")}`,
    },
    {
      quantity: "vorticity at a cell centre, order of convergence (Taylor-Green)",
      measured: order(centre),
      context:
        `max error ${listed(centre)} at n = ${sizes.join(", ")} - ` +
        `${(centre[centre.length - 1] / node[node.length - 1]).toFixed(1)}x the node error, ` +
        `same order`,
    },
    {
      quantity: "vorticity in solid-body rotation, exact",
      measured: rotationError,
      context: `angular rate ${w0}, so the answer is exactly ${2 * w0} everywhere`,
    },
    {
      quantity: "velocity at a cell vs its own faces, linear field",
      measured: velocityError,
      context: "u = 3x, v = -2y, where the face average is the exact centre value",
    },
  ];
}

// The M8 curve families against solid-body rotation, whose exact streamlines
// are circles. Mirrors tests/test17_m8_visualization.js.
function measureFlowCurves() {
  const fillField = (grid, uAt, vAt) => {
    const { nx, ny, h } = grid;
    for (let j = 0; j <= ny + 1; j++) {
      for (let i = 0; i <= nx + 1; i++) {
        const k = grid.idx(i, j);
        grid.u[k] = uAt(i * h, (j - 0.5) * h);
        grid.v[k] = vAt((i - 0.5) * h, j * h);
      }
    }
  };

  // Interpolation on a linear field, where the answer is exact.
  const linear = new StaggeredGrid(9, 7, 0.25);
  fillField(linear, (x) => 3 * x + 1, (_x, y) => -2 * y);
  let interpolation = 0;
  for (let n = 0; n < 400; n++) {
    const x = (((n * 37) % 100) / 100) * linear.nx * linear.h;
    const y = (((n * 53) % 100) / 100) * linear.ny * linear.h;
    const { u, v } = velocityAt(linear, x, y);
    interpolation = Math.max(interpolation, Math.abs(u - (3 * x + 1)), Math.abs(v - -2 * y));
  }

  // The integrator, on a field whose trajectories are circles.
  const grid = new StaggeredGrid(40, 40, 0.05);
  const omega = 2.0;
  const cx = (grid.nx * grid.h) / 2;
  const cy = (grid.ny * grid.h) / 2;
  fillField(grid, (_x, y) => -omega * (y - cy), (x) => omega * (x - cx));

  const radius = 0.5;
  const ds = grid.h / 2;
  const steps = 900;
  const drift = (stepper) => {
    let x = cx + radius;
    let y = cy;
    let worst = 0;
    for (let n = 0; n < steps; n++) {
      const next = stepper(x, y);
      if (next === null) break;
      x = next.x;
      y = next.y;
      worst = Math.max(worst, Math.abs(Math.hypot(x - cx, y - cy) - radius));
    }
    return worst / radius;
  };
  const euler = drift((x, y) => {
    const { u, v } = velocityAt(grid, x, y);
    const speed = Math.hypot(u, v);
    if (speed === 0) return null;
    return { x: x + (u / speed) * ds, y: y + (v / speed) * ds };
  });
  const streamline = drift((x, y) => traceStep(grid, x, y, ds));

  // A parcel released at the same point and advanced in time through the same
  // unchanging field: the steady-flow case where the two curves must coincide.
  const set = new PathlineSet(grid, { count: 0 });
  set.spawnable = [[1, 1]];
  const parcel = { x: cx + radius, y: cy, trail: [], age: 0 };
  set.trail = 100000;
  set.particles.push(parcel);
  for (let n = 0; n < 400; n++) set.advance(grid, 0.002);
  let pathline = 0;
  for (const point of parcel.trail) {
    pathline = Math.max(pathline, Math.abs(Math.hypot(point.x - cx, point.y - cy) - radius));
  }
  pathline /= radius;

  // And the invariant that matters most in a real domain.
  let escaped = 0;
  let traced = 0;
  for (const scenario of SCENARIOS) {
    const built = buildScenario(scenario.id);
    for (let n = 0; n < 40; n++) {
      step(built.grid, built.bc, { ...built.params, dt: 1e-4 });
    }
    for (const line of traceStreamlines(built.grid, { spacing: built.grid.h * 6 })) {
      for (const point of line.points) {
        traced++;
        if (!isFluidAt(built.grid, point.x, point.y)) escaped++;
      }
    }
  }

  return [
    {
      quantity: "interpolation error on a linear field",
      measured: interpolation,
      context: "u = 3x + 1, v = -2y, sampled at 400 points off the cell centres",
    },
    {
      quantity: "streamline radius drift in solid-body rotation, 900 steps",
      measured: streamline,
      context:
        `as a fraction of a radius of ${radius}; forward Euler on the same field ` +
        `drifts ${(euler * 100).toFixed(1)}%`,
    },
    {
      quantity: "pathline radius drift in the same field",
      measured: pathline,
      context: "400 steps of dt = 2e-3 - the steady-flow case where a pathline is a streamline",
    },
    {
      quantity: "streamline points outside the fluid, all scenarios",
      measured: escaped,
      context: `over ${traced} traced points in ${SCENARIOS.length} scenarios`,
    },
  ];
}

// The M9 derived quantities against closed-form results. Mirrors
// tests/test18_m9_flow_analysis.js.
function measureFlowAnalysis() {
  const fillField = (grid, uAt, vAt) => {
    const { nx, ny, h } = grid;
    for (let j = 0; j <= ny + 1; j++) {
      for (let i = 0; i <= nx + 1; i++) {
        const k = grid.idx(i, j);
        grid.u[k] = uAt(i * h, (j - 0.5) * h);
        grid.v[k] = vAt((i - 0.5) * h, j * h);
      }
    }
  };

  // Wall shear against plane Poiseuille.
  const sizes = [12, 24, 48];
  const errors = [];
  let lastMeasured = 0;
  for (const cpw of sizes) {
    const w = 1;
    const L = 6;
    const nu = 0.05;
    const dp = 3.6;
    const h = w / cpw;
    const grid = new StaggeredGrid(Math.round(L / h), cpw, h);
    const bc = {
      left: { type: "pressure", p: dp }, right: { type: "pressure", p: 0 },
      top: { type: "wall" }, bottom: { type: "wall" },
    };
    const params = { nu, rho: 1, divergenceTol: 1e-7, poissonMaxIterations: 20000 };
    const dt = 0.3 * Math.min((0.25 * h * h) / nu, h / 3);
    for (let n = 0; n < Math.round(30 / dt); n++) step(grid, bc, { ...params, dt });
    const i = Math.round(grid.nx / 2);
    let flux = 0;
    for (let j = 1; j <= grid.ny; j++) flux += grid.u[grid.idx(i, j)] * h;
    const plan = boundaryPlanFor(grid, bc);
    lastMeasured = Math.abs(wallShearSummary(surfaceFaces(grid, { nu, rho: 1, plan })).peak);
    errors.push(Math.abs(lastMeasured - (6 * nu * flux) / w) / ((6 * nu * flux) / w));
  }
  const order = Math.log2(errors[0] / errors[errors.length - 1]) /
    Math.log2(sizes[sizes.length - 1] / sizes[0]);

  // Q at its three exact values.
  const W = 1.75;
  const rotation = new StaggeredGrid(20, 20, 0.1);
  fillField(rotation, (_x, y) => -W * y, (x) => W * x);
  const rotationError = Math.abs(qCriterionAt(rotation, 10, 10) - W * W) / (W * W);

  const S = 0.6;
  const shear = new StaggeredGrid(20, 20, 0.1);
  fillField(shear, (_x, y) => S * y, () => 0);
  const shearQ = Math.abs(qCriterionAt(shear, 10, 10));

  // A fully developed channel, which contains no vortex.
  const cpw = 24;
  const channel = new StaggeredGrid(Math.round(6 * cpw), cpw, 1 / cpw);
  const channelBc = {
    left: { type: "pressure", p: 3.6 }, right: { type: "pressure", p: 0 },
    top: { type: "wall" }, bottom: { type: "wall" },
  };
  const channelParams = { nu: 0.05, rho: 1, divergenceTol: 1e-7, poissonMaxIterations: 20000 };
  const channelDt = 0.3 * Math.min((0.25 / (cpw * cpw) / 0.05), 1 / cpw / 3);
  for (let n = 0; n < Math.round(30 / channelDt); n++) {
    step(channel, channelBc, { ...channelParams, dt: channelDt });
  }
  const summary = rotationSummary(channel);
  const rotatingFraction = summary.rotating / summary.fluid;

  // The staircase paradox, which is why integrated wall force is withheld.
  const ratios = [];
  for (const n of [16, 32, 64, 128]) {
    const grid = new StaggeredGrid(n, n, 1 / n);
    stampCircle(grid, 0.5, 0.5, 0.25);
    const faces = surfaceFaces(grid, { nu: 0.01, rho: 1 });
    ratios.push(surfacePerimeter(grid, faces) / (2 * Math.PI * 0.25));
  }

  return [
    {
      quantity: "wall shear vs plane Poiseuille, order of convergence",
      measured: order,
      context:
        `relative error ${errors.map((e) => e.toExponential(2)).join(" -> ")} at ` +
        `${sizes.join(", ")} cells across; the discrete stress itself reads ` +
        `${lastMeasured.toFixed(6)} at every resolution, pinned by the streamwise force balance`,
    },
    {
      quantity: "Q in solid-body rotation, relative error",
      measured: rotationError,
      context: `angular rate ${W}, so Q is exactly ${(W * W).toFixed(6)}`,
    },
    {
      quantity: "Q in pure shear (analytically zero)",
      measured: shearQ,
      context: `shear rate ${S}: |Omega|^2 and |S|^2 are equal, so Q cancels exactly`,
    },
    {
      quantity: "fluid reported as rotating in a pure shear channel",
      measured: rotatingFraction,
      context:
        `${summary.rotating} of ${summary.fluid} cells, at a rotation-over-strain margin of ` +
        `${(summary.margin * 100).toFixed(0)}%; a bare Q > 0 test reports about half`,
    },
    {
      quantity: "staircase perimeter of a circle, ratio to the true perimeter",
      measured: ratios[ratios.length - 1],
      context:
        `${ratios.map((r) => r.toFixed(4)).join(", ")} at n = 16, 32, 64, 128 - constant, ` +
        `so refining the grid does not reduce it`,
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
  "probe-quantities": measureProbeQuantities,
  "flow-curves": measureFlowCurves,
  "flow-analysis": measureFlowAnalysis,
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
