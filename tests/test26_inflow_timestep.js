// The timestep is chosen from the field the step will advect
// (docs/inflow-timestep-proposal.md).
//
// Before this, SimulationSession chose each timestep from the raw field, and
// step() applied the boundary pass afterwards. A scenario starting from rest
// therefore chose its first timestep blind to its own inlet: the field step 1
// advected sat at CFL 0.833 (bends) and 0.899 (jet) against a safety target of
// 0.4. The choice now reads the boundary-applied field, on copies. These tests
// hold it to that, and to changing nothing else.

import test from "node:test";
import assert from "node:assert/strict";

import { SimulationSession } from "../ui/session.js";
import { SCENARIOS } from "../scenarios/index.js";
import { StaggeredGrid } from "../geometry/grid.js";
import { applyVelocityBoundaryConditions, step } from "../solver/ns2d.js";
import { computeStableTimestep, peakCellSpeed } from "../solver/stability.js";

// The CFL, by the solver's own measure, of the field a step will advect
// from the session's current state with timestep dt.
function advectedCfl(session, dt) {
  const { grid } = session;
  const u = grid.u.slice();
  const v = grid.v.slice();
  applyVelocityBoundaryConditions(grid, session.bc, u, v);
  const view = { nx: grid.nx, ny: grid.ny, h: grid.h, stride: grid.stride, solid: grid.solid, u, v };
  return (peakCellSpeed(view).peak * dt) / grid.h;
}

test("a cold start with an inlet takes its first step at the safety target, not twice it", () => {
  for (const id of ["bend-sharp", "bend-smooth", "jet"]) {
    const session = new SimulationSession(id);
    const safety = session.scenario.timestep.safety;
    const before = advectedCfl(session, 1); // per unit dt, from the state step 1 starts in
    session.advance();
    const cfl = before * session.lastTimestep;
    assert.ok(Math.abs(cfl - safety) < 1e-12, `${id}: step 1 advected at CFL ${cfl}, target ${safety}`);
  }
});

test("every step advects a field inside the safety target, in every scenario", () => {
  for (const { id } of SCENARIOS) {
    const session = new SimulationSession(id);
    const safety = session.scenario.timestep.safety;
    let worst = 0;
    for (let n = 0; n < 150; n++) {
      const perUnitDt = advectedCfl(session, 1);
      session.advance();
      worst = Math.max(worst, perUnitDt * session.lastTimestep);
    }
    assert.ok(worst <= safety * (1 + 1e-12), `${id}: a step advected at CFL ${worst} against ${safety}`);
  }
});

test("the grid step() receives is untouched: only the timestep can differ", () => {
  // The boundary pass for the choice runs on copies. So the session's step
  // must equal a direct step() on the same state with the same dt, byte for
  // byte - which it could not if the choice had written into the grid.
  for (const id of ["bend-sharp", "jet", "cylinder"]) {
    const session = new SimulationSession(id);
    for (let n = 0; n < 5; n++) session.advance();
    const { grid } = session;
    const twin = new StaggeredGrid(grid.nx, grid.ny, grid.h);
    twin.solid.set(grid.solid);
    twin.maskVersion = grid.maskVersion;
    twin.u.set(grid.u);
    twin.v.set(grid.v);
    twin.p.set(grid.p);
    session.advance();
    step(twin, session.bc, { ...session.scenario.params, dt: session.lastTimestep, sources: session.sources });
    for (const field of ["u", "v", "p"]) {
      assert.ok(grid[field].every((x, k) => Object.is(x, twin[field][k])), `${id}: ${field} differs from a direct step`);
    }
  }
});

test("scenarios without a cold-start inlet take exactly the first step they always did", () => {
  for (const id of ["cylinder", "cavity", "pressure-channel"]) {
    const session = new SimulationSession(id);
    const raw = computeStableTimestep(session.grid, {
      nu: session.scenario.params.nu,
      safety: session.scenario.timestep.safety,
    });
    session.advance();
    assert.equal(session.lastTimestep, raw.dt, `${id}: first timestep changed`);
  }
});

test("a non-finite field is still refused when the timestep is chosen", () => {
  // On a face with fluid on both sides. (A face inside a solid body is no
  // velocity at all - the boundary pass overwrites it, before and after this
  // change alike - so a NaN there is not a broken field.)
  const session = new SimulationSession("bend-sharp");
  session.advance();
  const { grid } = session;
  let face = null;
  for (let j = 1; j <= grid.ny && face === null; j++) {
    for (let i = 2; i < grid.nx; i++) {
      if (!grid.solid[grid.idx(i, j)] && !grid.solid[grid.idx(i + 1, j)]) { face = grid.idx(i, j); break; }
    }
  }
  grid.u[face] = NaN;
  assert.throws(() => session.advance(), /non-finite/);
});
