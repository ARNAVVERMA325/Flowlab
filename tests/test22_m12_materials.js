// M12 - materials.
//
// The roadmap's requirement is that density and viscosity "must genuinely
// affect the solver". For an incompressible fluid there is a precise statement
// of what that means, and these tests hold the app to it rather than to a
// looser "the picture changes":
//
//   - with the speeds at the boundary prescribed, the velocity depends on the
//     material ONLY through nu = mu/rho, and the pressure scales with rho;
//   - with a pressure difference prescribed, the flow rate goes as 1/mu;
//   - a fluid this grid cannot resolve is refused, not run.

import test from "node:test";
import assert from "node:assert/strict";

import { SimulationSession } from "../ui/session.js";
import { FLUIDS, MAX_CELL_RE, SPEED_UNIT, WATER, applyFluid, fluidById, lengthUnitFor } from "../materials/fluids.js";

function advance(session, steps) {
  for (let n = 0; n < steps; n++) session.advance();
  return session;
}

function maxDifference(a, b) {
  let m = 0;
  for (let k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k] - b[k]));
  return m;
}

function maxAbs(a) {
  let m = 0;
  for (let k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k]));
  return m;
}

// Pressure relative to its fluid-cell mean - the cavity's pressure is a gauge.
function gauge(session) {
  const { grid } = session;
  let sum = 0;
  let n = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      if (grid.solid[k]) continue;
      sum += grid.p[k];
      n++;
    }
  }
  const out = new Float64Array(grid.p.length);
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      const k = grid.idx(i, j);
      if (!grid.solid[k]) out[k] = grid.p[k] - sum / n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The physical scale
// ---------------------------------------------------------------------------

test("each scenario as shipped is water at 1 cm/s in an apparatus of a stated size", () => {
  const cavity = new SimulationSession("cavity");
  assert.ok(Math.abs(lengthUnitFor(cavity.scenario.params.nu) - 0.1004) < 1e-3, "the cavity is 10 cm across");
  cavity.setMaterial(WATER);
  const m = cavity.scenario.material;
  assert.ok(Math.abs(m.Re - 1000) < 1e-6, `water reproduces Re 1000: ${m.Re}`);
  assert.ok(Math.abs(m.physical.speed - SPEED_UNIT) < 1e-15);
  assert.equal(cavity.scenario.params.rho, WATER.rho);

  const cylinder = new SimulationSession("cylinder");
  cylinder.setMaterial(WATER);
  assert.ok(Math.abs(cylinder.scenario.material.physical.length - 0.01) < 1e-4, "a 1 cm cylinder");
});

// ---------------------------------------------------------------------------
// What the material does to the flow
// ---------------------------------------------------------------------------

test("with prescribed speeds, the velocity depends only on nu, and the pressure scales with rho", () => {
  // Water, and a fluid with water's kinematic viscosity at ten times its
  // density. Incompressible flow cannot tell them apart except in the
  // pressure it takes to move them - which must be exactly ten times larger.
  const water = advance(new SimulationSession("cylinder").setMaterial(WATER), 60);
  const heavy = advance(new SimulationSession("cylinder").setMaterial({ name: "heavy water-like", rho: 10 * WATER.rho, mu: 10 * WATER.mu }), 60);
  const speed = maxAbs(water.grid.u);
  assert.ok(maxDifference(water.grid.u, heavy.grid.u) < 1e-9 * speed, `u differs by ${maxDifference(water.grid.u, heavy.grid.u)}`);
  assert.ok(maxDifference(water.grid.v, heavy.grid.v) < 1e-9 * speed);
  const pw = gauge(water);
  const ph = gauge(heavy);
  const scaled = pw.map((p) => 10 * p);
  assert.ok(maxDifference(scaled, ph) < 1e-8 * maxAbs(ph), `pressure is 10x: off by ${maxDifference(scaled, ph)}`);
});

test("water reproduces the shipped scenario's flow, carrying 998 times its pressure", () => {
  const shipped = advance(new SimulationSession("cavity"), 40);
  const water = advance(new SimulationSession("cavity").setMaterial(WATER), 40);
  const speed = maxAbs(shipped.grid.u);
  assert.ok(maxDifference(shipped.grid.u, water.grid.u) < 1e-9 * speed);
  const ratio = maxAbs(gauge(water)) / maxAbs(gauge(shipped));
  assert.ok(Math.abs(ratio / WATER.rho - 1) < 1e-8, `pressure ratio ${ratio}`);
});

test("air in the cavity is a different flow, at the Reynolds number its viscosity gives", () => {
  const water = advance(new SimulationSession("cavity").setMaterial(WATER), 200);
  const air = advance(new SimulationSession("cavity").setMaterial(fluidById("air")), 200);
  const ratio = (fluidById("air").mu / fluidById("air").rho) / (WATER.mu / WATER.rho);
  assert.ok(Math.abs(air.scenario.params.nu / water.scenario.params.nu - ratio) < 1e-12 * ratio);
  assert.ok(Math.abs(air.scenario.Re - 1000 / ratio) < 1e-6, `Re ${air.scenario.Re}`);
  assert.ok(maxDifference(water.grid.u, air.grid.u) > 1e-3, "a different fluid, a different flow");
});

test("with a pressure difference prescribed, the flow rate goes as 1/mu", () => {
  // Plane Poiseuille: U = dp w^2 / (12 mu L). The same channel and the same
  // pressure difference, water and then air: air is 55 times less viscous,
  // so it must carry 55 times the flow once each has developed.
  const developed = (fluid) => {
    const session = new SimulationSession("pressure-channel");
    session.setMaterial(fluid);
    while (session.changeRate > 1e-9 * session.scenario.material.speed && session.simulatedTime < 200) session.advance();
    const { grid } = session;
    const i = grid.nx / 2;
    let flux = 0;
    for (let j = 1; j <= grid.ny; j++) flux += grid.u[grid.idx(i, j)] * grid.h;
    return { flux, predicted: session.scenario.material.speed * grid.ny * grid.h, session };
  };
  const water = developed(WATER);
  const air = developed(fluidById("air"));
  for (const r of [water, air]) {
    assert.ok(Math.abs(r.flux / r.predicted - 1) < 0.01, `developed flux ${r.flux} vs Poiseuille ${r.predicted}`);
  }
  const expected = WATER.mu / fluidById("air").mu;
  assert.ok(Math.abs((air.flux / water.flux) / expected - 1) < 0.01, `ratio ${air.flux / water.flux} vs ${expected}`);
});

test("a very viscous fluid runs with the timestep its viscosity demands", () => {
  const water = advance(new SimulationSession("cavity").setMaterial(WATER), 2);
  const glycerol = advance(new SimulationSession("cavity").setMaterial(fluidById("glycerol")), 2);
  const h = glycerol.grid.h;
  assert.ok(glycerol.lastTimestep <= 0.25 * h * h / glycerol.scenario.params.nu + 1e-15, "inside the diffusive limit");
  assert.ok(glycerol.lastTimestep < water.lastTimestep / 100, `${glycerol.lastTimestep} vs ${water.lastTimestep}`);
});

// ---------------------------------------------------------------------------
// Refusals and lifecycle
// ---------------------------------------------------------------------------

test("a fluid this grid cannot resolve is refused, and nothing changes", () => {
  const session = new SimulationSession("cavity");
  const nu = session.scenario.params.nu;
  const predicted = applyFluid({ ...session.scenario.params, U: 1, L: 1, h: session.grid.h }, fluidById("mercury"));
  assert.ok(predicted.cellRe > MAX_CELL_RE, `mercury in a 10 cm cavity: cell Re ${predicted.cellRe}`);
  assert.throws(() => session.setMaterial(fluidById("mercury")), /cell Reynolds number/);
  assert.equal(session.scenario.params.nu, nu);
  assert.equal(session.scenario.material, null);
  // The same fluid in the pressure channel is slow enough to resolve.
  const channel = new SimulationSession("pressure-channel");
  channel.setMaterial(fluidById("mercury"));
  assert.ok(channel.scenario.material.cellRe <= MAX_CELL_RE);
});

test("the limit is the finest scale any shipped scenario runs at, with a margin", () => {
  for (const id of ["cavity", "cylinder", "bend-sharp", "bend-smooth", "jet", "pressure-channel"]) {
    const session = new SimulationSession(id);
    session.setMaterial(WATER); // must not throw: every scenario as shipped is resolvable
    assert.ok(session.scenario.material.cellRe < 17, `${id}: ${session.scenario.material.cellRe}`);
  }
  assert.equal(MAX_CELL_RE, 20);
});

test("nonsense properties are refused", () => {
  const session = new SimulationSession("cavity");
  for (const bad of [{ rho: 0, mu: 1e-3 }, { rho: -1, mu: 1e-3 }, { rho: 1000, mu: 0 }, { rho: NaN, mu: 1 }, { rho: 1000, mu: Infinity }]) {
    assert.throws(() => session.setMaterial({ name: "bad", ...bad }), RangeError, JSON.stringify(bad));
  }
  assert.equal(session.scenario.material, null);
});

test("a material survives reset, is cleared by load, and excludes a bare Reynolds override", () => {
  const session = new SimulationSession("cavity");
  session.setMaterial(fluidById("air"));
  advance(session, 3);
  session.reset();
  assert.equal(session.scenario.material.fluid.id, "air");
  assert.equal(session.scenario.params.rho, fluidById("air").rho);

  // A Reynolds number without a fluid is dimensionless, so it replaces the
  // material rather than stacking on it - and the other way round.
  session.setReynolds(400);
  assert.equal(session.scenario.material, null);
  assert.equal(session.scenario.params.rho, 1);
  assert.equal(session.scenario.Re, 400);
  session.setMaterial(WATER);
  assert.ok(Math.abs(session.scenario.Re - 1000) < 1e-6, "the material sets Re; the old override is gone");
  // Gone, not merely outranked: removing the fluid must return to the
  // scenario's own Re, not resurrect the 400 set before it.
  session.setMaterial(null);
  assert.equal(session.scenario.Re, 1000);
  session.setMaterial(WATER);

  session.setMaterial(null);
  assert.equal(session.scenario.material, null);
  assert.equal(session.scenario.params.rho, 1);
  session.setMaterial(WATER);
  session.load("cavity");
  assert.equal(session.scenario.material, null);
});

test("every listed fluid has sane properties", () => {
  const ids = new Set();
  for (const fluid of FLUIDS) {
    assert.ok(!ids.has(fluid.id));
    ids.add(fluid.id);
    assert.ok(fluid.rho > 0.5 && fluid.rho < 2e4, fluid.id);
    assert.ok(fluid.mu > 1e-6 && fluid.mu < 10, fluid.id);
    assert.equal(fluidById(fluid.id), fluid);
  }
  // Water and air at 20 C, to the precision anything here relies on.
  assert.ok(Math.abs(WATER.mu / WATER.rho - 1.004e-6) < 0.01e-6);
  const air = fluidById("air");
  assert.ok(Math.abs(air.mu / air.rho - 1.516e-5) < 0.02e-5);
});
