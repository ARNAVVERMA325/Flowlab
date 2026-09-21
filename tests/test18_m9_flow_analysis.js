// M9 - flow analysis: gradients, shear, wall shear, separation, recirculation,
// pressure drop.
//
// Most of this milestone is one quantity computed three ways and named
// carefully. The tests are therefore mostly about the naming holding: that
// shear rate is not vorticity, that the two derivations of vorticity agree to
// the last bit, that "rotating" is not a coin flip, and that the two Reynolds
// numbers each say which speed they use.
//
// The one refusal - integrated wall force - is asserted with the measurement
// that justifies it, because a refusal without a number is a shrug.

import test from "node:test";
import assert from "node:assert/strict";

import { StaggeredGrid, stampCircle } from "../geometry/grid.js";
import { boundaryPlanFor, step } from "../solver/ns2d.js";
import { vorticityAtCell } from "../physics/probe.js";
import {
  qCriterionAt, rotationSummary, shearRateAt, shearSummary,
  velocityGradientAt, vorticityFromGradient,
} from "../physics/gradients.js";
import {
  separationPoints, surfaceFaces, surfacePerimeter, wallShearSummary,
} from "../physics/wallShear.js";
import { analyseFlow, pressureDropBetween } from "../physics/flowAnalysis.js";
import { SimulationSession } from "../ui/session.js";
import { SCENARIOS, buildScenario } from "../scenarios/index.js";

function fill(grid, uAt, vAt) {
  const { nx, ny, h } = grid;
  for (let j = 0; j <= ny + 1; j++) {
    for (let i = 0; i <= nx + 1; i++) {
      const k = grid.idx(i, j);
      grid.u[k] = uAt(i * h, (j - 0.5) * h);
      grid.v[k] = vAt((i - 0.5) * h, j * h);
    }
  }
}

// ---------------------------------------------------------------------------
// The gradient tensor
// ---------------------------------------------------------------------------

test("M9 - the velocity gradient tensor is exact on a linear field", () => {
  const grid = new StaggeredGrid(12, 10, 0.2);
  // u = 3x - 2y + 1, v = 5x + 4y  (not divergence-free; this tests arithmetic)
  fill(grid, (x, y) => 3 * x - 2 * y + 1, (x, y) => 5 * x + 4 * y);
  for (const [i, j] of [[2, 3], [6, 5], [11, 9]]) {
    const g = velocityGradientAt(grid, i, j);
    assert.ok(Math.abs(g.dudx - 3) < 1e-12, `dudx at ${i},${j}: ${g.dudx}`);
    assert.ok(Math.abs(g.dudy - -2) < 1e-12, `dudy at ${i},${j}: ${g.dudy}`);
    assert.ok(Math.abs(g.dvdx - 5) < 1e-12, `dvdx at ${i},${j}: ${g.dvdx}`);
    assert.ok(Math.abs(g.dvdy - 4) < 1e-12, `dvdy at ${i},${j}: ${g.dvdy}`);
  }
});

test("M9 - shear rate and vorticity are the same two terms, added and subtracted", () => {
  // The distinction the whole milestone turns on. A uniform shear layer has
  // large shear AND large vorticity; solid-body rotation has large vorticity
  // and NO shear. Showing one under the other's name would make a shear layer
  // look like a vortex.
  const S = 0.6;
  const shear = new StaggeredGrid(16, 16, 0.1);
  fill(shear, (_x, y) => S * y, () => 0);
  assert.ok(Math.abs(shearRateAt(shear, 8, 8) - S) < 1e-12);
  assert.ok(Math.abs(vorticityAtCell(shear, 8, 8) - -S) < 1e-12);

  const W = 1.75;
  const rotation = new StaggeredGrid(16, 16, 0.1);
  fill(rotation, (_x, y) => -W * y, (x) => W * x);
  assert.ok(Math.abs(shearRateAt(rotation, 8, 8)) < 1e-12, "rotation has no shear");
  assert.ok(Math.abs(vorticityAtCell(rotation, 8, 8) - 2 * W) < 1e-12);
  console.log(
    `[M9 decomposition] shear S=${S}: gamma=${shearRateAt(shear, 8, 8).toFixed(3)}, ` +
    `omega=${vorticityAtCell(shear, 8, 8).toFixed(3)}; rotation W=${W}: ` +
    `gamma=${shearRateAt(rotation, 8, 8).toExponential(1)}, ` +
    `omega=${vorticityAtCell(rotation, 8, 8).toFixed(3)}`
  );
});

test("M9 - the two derivations of vorticity agree to the last bit", () => {
  // physics/probe.js computes vorticity from the corners directly; the tensor
  // reaches it through du/dy and dv/dx. Two derivations of one quantity that
  // can drift apart is the shape this project keeps finding, so they are
  // pinned together rather than trusted to stay equal.
  const session = new SimulationSession("cylinder");
  for (let n = 0; n < 60; n++) session.advance();
  const grid = session.grid;
  let worst = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      if (grid.solid[grid.idx(i, j)]) continue;
      worst = Math.max(worst, Math.abs(vorticityFromGradient(grid, i, j) - vorticityAtCell(grid, i, j)));
    }
  }
  assert.equal(worst, 0, `the two derivations differ by up to ${worst}`);

  // And the tensor's OWN pair, which Q uses and which is not the same
  // floating-point operation, agrees to within rounding rather than exactly.
  // Measured rather than assumed, because "they are the same arithmetic" is
  // true and "they are the same number" is not.
  let tensorGap = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      if (grid.solid[grid.idx(i, j)]) continue;
      const g = velocityGradientAt(grid, i, j);
      tensorGap = Math.max(tensorGap, Math.abs((g.dvdx - g.dudy) - vorticityAtCell(grid, i, j)));
    }
  }
  assert.ok(tensorGap > 0, "if these were bit-identical the delegation would be pointless");
  assert.ok(tensorGap < 1e-12, `the tensor's vorticity is ${tensorGap} from the canonical one`);
  console.log(
    `[M9 vorticity] one definition, delegated; the tensor's own pair differs by ` +
    `${tensorGap.toExponential(2)} through summation order alone`
  );
});

test("M9 - Q takes its three exact values on the three canonical fields", () => {
  // Q = 0.5*(|Omega|^2 - |S|^2). Solid-body rotation at rate W gives W^2;
  // planar strain at rate a gives -a^2; and PURE SHEAR gives exactly zero,
  // which is the value that matters most because it is the boundary the
  // recirculation count sits on.
  const W = 1.75;
  const rotation = new StaggeredGrid(20, 20, 0.1);
  fill(rotation, (_x, y) => -W * y, (x) => W * x);
  assert.ok(Math.abs(qCriterionAt(rotation, 10, 10) - W * W) < 1e-12);

  const S = 0.6;
  const shear = new StaggeredGrid(20, 20, 0.1);
  fill(shear, (_x, y) => S * y, () => 0);
  assert.ok(Math.abs(qCriterionAt(shear, 10, 10)) < 1e-14, "pure shear must give exactly zero");

  const a = 0.9;
  const strain = new StaggeredGrid(20, 20, 0.1);
  fill(strain, (x) => a * x, (_x, y) => -a * y);
  assert.ok(Math.abs(qCriterionAt(strain, 10, 10) - -(a * a)) < 1e-12);
  console.log(
    `[M9 Q] rotation ${qCriterionAt(rotation, 10, 10).toFixed(6)} (expected ${(W * W).toFixed(6)}), ` +
    `shear ${qCriterionAt(shear, 10, 10).toExponential(1)} (expected 0), ` +
    `strain ${qCriterionAt(strain, 10, 10).toFixed(6)} (expected ${(-a * a).toFixed(6)})`
  );
});

test("M9 - a shear flow is not reported as half recirculating", () => {
  // The regression for a threshold that was a coin flip. Pure shear has
  // |Omega|^2 = |S|^2 exactly, so Q is analytically zero and its measured sign
  // is decided by the last bits of a difference of near-equal numbers. A bare
  // Q > 0 test reported 49.2% of a fully developed Poiseuille channel - which
  // contains no vortex at all - as rotating.
  const session = new SimulationSession("pressure-channel");
  for (let n = 0; n < 600; n++) session.advance();
  const summary = rotationSummary(session.grid);
  assert.ok(
    summary.rotating / summary.fluid < 0.01,
    `${((summary.rotating / summary.fluid) * 100).toFixed(1)}% of a pure shear flow reported as rotating`
  );
  assert.ok(
    summary.balanced / summary.fluid > 0.95,
    "a Poiseuille channel is shear everywhere, so almost every cell is balanced"
  );
  assert.ok(summary.margin > 0, "the margin must be declared, not hidden");

  // And the cavity, which genuinely does recirculate, is not flattened to zero
  // by the same margin.
  const cavity = new SimulationSession("cavity");
  for (let n = 0; n < 600; n++) cavity.advance();
  const rotating = rotationSummary(cavity.grid);
  assert.ok(
    rotating.rotating / rotating.fluid > 0.05,
    `the cavity's primary vortex must survive the margin (${rotating.rotating} cells)`
  );
  console.log(
    `[M9 rotation] channel ${((summary.rotating / summary.fluid) * 100).toFixed(1)}% rotating, ` +
    `${((summary.balanced / summary.fluid) * 100).toFixed(1)}% balanced; cavity ` +
    `${((rotating.rotating / rotating.fluid) * 100).toFixed(1)}% rotating`
  );
});

// ---------------------------------------------------------------------------
// Wall shear
// ---------------------------------------------------------------------------

test("M9 - wall shear matches plane Poiseuille, and converges", () => {
  // tau_w = 6*mu*U_mean/w exactly for plane Poiseuille, and planePoiseuille is
  // already a derived reference in the registry.
  //
  // Worth knowing what is actually being measured: the discrete wall stress
  // comes out at 0.300000 at EVERY resolution, because the streamwise force
  // balance pins it - the pressure drop across the channel has to be carried
  // by the two walls. What converges is the analytic value it is compared
  // against, through the flow rate.
  const errors = [];
  for (const cpw of [12, 24, 48]) {
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
    const measured = Math.abs(wallShearSummary(surfaceFaces(grid, { nu, rho: 1, plan })).peak);
    const exact = (6 * nu * flux) / w;
    errors.push(Math.abs(measured - exact) / exact);
  }
  for (let n = 1; n < errors.length; n++) {
    const rate = Math.log2(errors[n - 1] / errors[n]);
    assert.ok(rate > 1.8 && rate < 2.2, `wall shear converges at ${rate.toFixed(2)}`);
  }
  assert.ok(errors[errors.length - 1] < 1e-3);
  console.log(
    `[M9 wall shear] plane Poiseuille relative error ` +
    `${errors.map((e) => e.toExponential(2)).join(" -> ")} at 12, 24, 48 cells across`
  );
});

test("M9 - a domain-boundary wall is a wall", () => {
  // The regression for a proxy. Keying surface faces on `solid[i] != solid[i+1]`
  // is a proxy for "the fluid meets a no-slip wall here", and the two come
  // apart for half the scenarios in this project: the cavity's lid and the
  // pressure channel's walls are BOUNDARY CONDITIONS, not solid cells. Both
  // reported zero surface faces and no wall shear at all, and the cavity's lid
  // is the single most interesting wall here.
  for (const scenario of SCENARIOS) {
    const session = new SimulationSession(scenario.id);
    for (let n = 0; n < 80; n++) session.advance();
    const plan = boundaryPlanFor(session.grid, session.bc);
    const faces = surfaceFaces(session.grid, {
      nu: session.params.nu, rho: session.params.rho, plan,
    });
    assert.ok(faces.length > 0, `${scenario.id} reports no no-slip wall at all`);
    const summary = wallShearSummary(faces);
    assert.ok(Number.isFinite(summary.peak), `${scenario.id}: peak wall shear is ${summary.peak}`);
  }

  // Without the plan, only drawn bodies are found - which is what the bug was.
  const cavity = new SimulationSession("cavity");
  cavity.advance();
  assert.equal(
    surfaceFaces(cavity.grid, { nu: cavity.params.nu }).length, 0,
    "the cavity has no solid cells at all; its walls are boundary conditions"
  );
});

test("M9 - a moving wall shears by the difference, not by the fluid's speed", () => {
  // The cavity's lid slides. Fluid moving at exactly the lid's speed is not
  // being sheared by it, and a wall-shear formula that forgot the wall's own
  // velocity would report the largest stress in the domain there.
  const U = 1;
  const grid = new StaggeredGrid(12, 12, 1 / 12);
  const bc = {
    left: { type: "wall" }, right: { type: "wall" },
    bottom: { type: "wall" }, top: { type: "wall", u: U },
  };
  const plan = boundaryPlanFor(grid, bc);
  // Fluid everywhere at exactly the lid speed.
  for (let k = 0; k < grid.u.length; k++) grid.u[k] = U;
  const faces = surfaceFaces(grid, { nu: 0.01, rho: 1, plan });
  const lid = faces.filter((face) => face.boundary === "top");
  assert.ok(lid.length > 0);
  for (const face of lid) {
    assert.ok(Math.abs(face.tau) < 1e-12, `the lid shears co-moving fluid by ${face.tau}`);
  }
  // The stationary floor, under the same fluid, does not.
  const floor = faces.filter((face) => face.boundary === "bottom");
  assert.ok(floor.length > 0);
  assert.ok(Math.abs(floor[0].tau) > 0, "a stationary wall under moving fluid is sheared");
});

test("M9 - free-slip is not counted as a no-slip wall", () => {
  // It carries zero tangential stress by construction, so including it would
  // pad the surface with faces that can never separate and can never carry the
  // peak - true zeros standing among measured values.
  const grid = new StaggeredGrid(10, 10, 0.1);
  const plan = boundaryPlanFor(grid, {
    left: { type: "inflow", u: 1, v: 0 }, right: { type: "outflow" },
    top: { type: "freeSlip" }, bottom: { type: "freeSlip" },
  });
  for (let k = 0; k < grid.u.length; k++) grid.u[k] = 1;
  const faces = surfaceFaces(grid, { nu: 0.01, rho: 1, plan });
  assert.equal(faces.length, 0, "a free-slip box has no no-slip wall");
});

test("M9 - separation is a sign change in the wall's tangential flow", () => {
  const grid = new StaggeredGrid(20, 6, 0.1);
  const plan = boundaryPlanFor(grid, {
    left: { type: "inflow", u: 1, v: 0 }, right: { type: "outflow" },
    top: { type: "wall" }, bottom: { type: "wall" },
  });
  // Flow along the bottom wall that reverses at the middle of the domain.
  for (let j = 0; j <= grid.ny + 1; j++) {
    for (let i = 0; i <= grid.nx + 1; i++) {
      grid.u[grid.idx(i, j)] = (i * grid.h) < 1.0 ? 0.5 : -0.5;
    }
  }
  const faces = surfaceFaces(grid, { nu: 0.01, rho: 1, plan });
  const points = separationPoints(faces, grid);
  assert.ok(points.length > 0, "a reversal along a wall is a separation point");
  for (const point of points) {
    assert.ok(Math.abs(point.x - 1.0) < grid.h, `separation found at x = ${point.x}, expected 1.0`);
    // Either an exact zero at the crossing, or a bracketed sign change. The
    // exact case is the one a zero-skipping guard used to lose.
    assert.ok(
      point.exact || (point.from > 0) !== (point.to > 0),
      "a separation point is a zero or a sign change"
    );
  }
  // Both walls reverse here, so both report - once each, not twice.
  assert.equal(points.length, 2, `${points.length} points for two reversing walls`);

  // No reversal, no separation.
  for (let k = 0; k < grid.u.length; k++) grid.u[k] = 0.5;
  assert.equal(
    separationPoints(surfaceFaces(grid, { nu: 0.01, rho: 1, plan }), grid).length, 0
  );
});

test("M9 - integrated wall force is refused, with the measurement that refuses it", () => {
  // The staircase paradox, measured rather than recalled. The staircase
  // perimeter of a convex shape is the perimeter of its bounding box AT EVERY
  // RESOLUTION, so a summed wall force on a curved body is wrong by a factor
  // that more grid cannot reduce.
  const ratios = [];
  for (const n of [16, 32, 64, 128]) {
    const h = 1 / n;
    const grid = new StaggeredGrid(n, n, h);
    const R = 0.25;
    stampCircle(grid, 0.5, 0.5, R);
    const faces = surfaceFaces(grid, { nu: 0.01, rho: 1 });
    ratios.push(surfacePerimeter(grid, faces) / (2 * Math.PI * R));
  }
  for (const ratio of ratios) {
    assert.ok(Math.abs(ratio - 4 / Math.PI) < 1e-9, `staircase/circle = ${ratio}, expected 4/pi`);
  }
  assert.equal(
    ratios[0].toFixed(9), ratios[ratios.length - 1].toFixed(9),
    "and it does not converge - that is the whole reason integration is withheld"
  );

  // The refusal is in the DATA, not only in a comment, so a caller cannot get
  // the per-face numbers and quietly add them up without meeting it.
  const summary = wallShearSummary(
    surfaceFaces(new StaggeredGrid(8, 8, 0.1), { nu: 0.01, rho: 1 })
  );
  assert.equal(summary.integrable, false);
  assert.match(summary.integrationRefusedBecause, /staircase/);

  // On an axis-aligned body the staircase perimeter IS the true wall length,
  // which is why the refusal is about curvature rather than about drawing.
  const box = new StaggeredGrid(40, 40, 0.1);
  for (let j = 11; j <= 30; j++) for (let i = 11; i <= 20; i++) box.solid[box.idx(i, j)] = 1;
  const boxFaces = surfaceFaces(box, { nu: 0.01, rho: 1 });
  // A 10 x 20 cell block: perimeter 2*(1.0 + 2.0) = 6.0.
  assert.ok(Math.abs(surfacePerimeter(box, boxFaces) - 6.0) < 1e-9);
  console.log(
    `[M9 staircase] circle: ${ratios.map((r) => r.toFixed(4)).join(", ")} at n = 16, 32, 64, 128 ` +
    `(4/pi = ${(4 / Math.PI).toFixed(4)}, not converging); axis-aligned block exact`
  );
});

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

test("M9 - every scenario's declared Reynolds number matches its own definition", () => {
  // A hole nothing was checking. Each build function picks Re and a reference
  // pair (U, L) and derives nu from them, but the pair was local to the
  // builder - so a scenario whose nu was edited and whose Re label was not
  // would have gone on claiming the old number with nothing to notice.
  for (const scenario of SCENARIOS) {
    const built = buildScenario(scenario.id);
    const reference = built.reference;
    assert.ok(reference, `${scenario.id} declares no reference scale`);
    assert.ok(Number.isFinite(reference.U) && reference.U > 0, `${scenario.id}: U`);
    assert.ok(Number.isFinite(reference.L) && reference.L > 0, `${scenario.id}: L`);
    assert.ok(reference.speed?.length > 3 && reference.length?.length > 3,
      `${scenario.id}: both scales must say what they are`);
    const implied = (reference.U * reference.L) / built.params.nu;
    assert.equal(
      Math.round(implied), built.Re,
      `${scenario.id} declares Re = ${built.Re} but U*L/nu is ${implied}`
    );
  }
  console.log(
    `[M9 Reynolds] all ${SCENARIOS.length} scenarios: declared Re equals U*L/nu from their own ` +
    `reference scales`
  );
});

test("M9 - the peak Reynolds number uses the same length and says which speed", () => {
  const session = new SimulationSession("bend-sharp");
  for (let n = 0; n < 600; n++) session.advance();
  const analysis = analyseFlow(session.grid, {
    nu: session.params.nu, rho: session.params.rho,
    plan: boundaryPlanFor(session.grid, session.bc),
    reference: session.scenario.reference, Re: session.scenario.Re,
  });
  assert.equal(analysis.declaredRe, 200);
  // The corner jet accelerates the flow well past the inlet speed, which is
  // exactly the fact the declared number cannot show.
  assert.ok(analysis.peakRe > analysis.declaredRe, `peak ${analysis.peakRe}`);
  assert.ok(
    Math.abs(analysis.peakRe - (analysis.peakSpeed * analysis.reference.L) / session.params.nu) < 1e-9,
    "the peak figure must use the declared length, not a second one"
  );
  console.log(
    `[M9 peak Re] sharp bend: declared ${analysis.declaredRe}, peak ` +
    `${analysis.peakRe.toFixed(0)} at |u| = ${analysis.peakSpeed.toFixed(3)} against an ` +
    `inlet speed of ${analysis.reference.U}`
  );
});

test("M9 - a pressure drop is between two points, and refuses points with no fluid", () => {
  const session = new SimulationSession("cylinder");
  for (let n = 0; n < 200; n++) session.advance();
  const grid = session.grid;
  const upstream = { x: 1.0, y: grid.ny * grid.h / 2 };
  const downstream = { x: 12.0, y: grid.ny * grid.h / 2 };

  const measured = pressureDropBetween(grid, upstream, downstream);
  assert.notEqual(measured, null);
  // Flow runs left to right, so the downstream pressure is the lower one.
  assert.ok(measured.drop < 0, `drop reads ${measured.drop}`);
  const reversed = pressureDropBetween(grid, downstream, upstream);
  assert.ok(Math.abs(reversed.drop + measured.drop) < 1e-12, "and reverses exactly");

  // A point in the cylinder, and a point outside the domain, both refuse.
  let solidPoint = null;
  for (let j = 1; j <= grid.ny && solidPoint === null; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      if (grid.solid[grid.idx(i, j)]) { solidPoint = grid.cellCentre(i, j); break; }
    }
  }
  assert.equal(pressureDropBetween(grid, upstream, solidPoint), null);
  assert.equal(pressureDropBetween(grid, upstream, { x: -1, y: 1 }), null);
});

test("M9 - a broken field withholds every analysed quantity", () => {
  // The rule the rest of physics/ follows: a number computed from the
  // survivors of a partly non-finite field is not a number anyone should read.
  const session = new SimulationSession("cavity");
  for (let n = 0; n < 20; n++) session.advance();
  session.grid.u[session.grid.idx(20, 20)] = NaN;
  const analysis = analyseFlow(session.grid, {
    nu: session.params.nu, rho: session.params.rho,
    plan: boundaryPlanFor(session.grid, session.bc),
    reference: session.scenario.reference, Re: session.scenario.Re,
  });
  assert.equal(analysis.speedIsUsable, false);
  assert.ok(Number.isNaN(analysis.peakRe));
  assert.equal(analysis.pressure.usable, true, "pressure is still finite here");
  assert.ok(analysis.rotation.nonFinite > 0, "the non-finite cells must be counted");
  assert.ok(analysis.shear.nonFinite > 0);
  // Counted, never folded into a maximum - `a > max` is false for NaN.
  assert.ok(Number.isFinite(analysis.shear.peak));
});

test("M9 - the shear summary finds the largest shear, not the largest positive one", () => {
  // shearSummary compares magnitudes, so a flow whose strongest shear is
  // negative must report that rather than a smaller positive one.
  const grid = new StaggeredGrid(10, 10, 0.1);
  fill(grid, (_x, y) => -5 * y, () => 0);
  const summary = shearSummary(grid);
  assert.ok(Math.abs(summary.peak - -5) < 1e-12, `peak reads ${summary.peak}`);
  assert.notEqual(summary.peakAt, null);
});
