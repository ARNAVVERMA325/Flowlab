// M7 - probes.
//
// A probe is a reading, so the only thing that makes it worth anything is that
// the number is right and that a number nobody should trust is impossible to
// get. Three groups here:
//
//   1. The sampler, against fields whose answer is known exactly. Vorticity on
//      a staggered grid is the one quantity where a sign or an index slip
//      produces a plausible-looking field, so it is checked against solid-body
//      rotation and simple shear rather than against itself.
//   2. The history: sampled once per SOLVER STEP, carrying the simulated time,
//      cleared by anything that rebuilds the field.
//   3. The plot's arithmetic, including what it does with a broken sample.

import test from "node:test";
import assert from "node:assert/strict";

import { StaggeredGrid } from "../geometry/grid.js";
import { cellAt, probeAt, probeCell, vorticityAtCell, vorticityAtNode } from "../physics/probe.js";
import { pressureIsGauge, boundaryPlanFor } from "../solver/ns2d.js";
import { inspectScalar } from "../physics/fieldStats.js";
import { ProbeSet, PROBE_CAPACITY, PROBE_QUANTITIES } from "../ui/probes.js";
import { SimulationSession } from "../ui/session.js";
import { buildScenario } from "../scenarios/index.js";
import { layoutSeries, seriesRange } from "../visualization/timeseries.js";
import { TOOLS } from "../geometry/editor.js";

const NU = 1e-2;

// Fills every slot, ghosts included, from the analytic field evaluated at each
// component's own staggered position. With the ghosts set too, the difference
// quotients are exact right up to the corner cells and the test can assert
// machine precision rather than a tolerance that would hide an index slip.
function fillAnalytic(grid, uAt, vAt) {
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
// The sampler
// ---------------------------------------------------------------------------

test("M7 - a probe reports the cell it is in, and refuses points outside", () => {
  const grid = new StaggeredGrid(8, 5, 0.25);
  // Cell (i, j) spans [(i-1)h, i*h), so the first cell starts at the origin.
  assert.deepEqual(cellAt(grid, 0, 0), { i: 1, j: 1 });
  assert.deepEqual(cellAt(grid, 0.24, 0.24), { i: 1, j: 1 });
  // Exactly on a cell boundary belongs to the cell above/right of it.
  assert.deepEqual(cellAt(grid, 0.25, 0.25), { i: 2, j: 2 });
  assert.deepEqual(cellAt(grid, 8 * 0.25 - 1e-9, 5 * 0.25 - 1e-9), { i: 8, j: 5 });

  // Outside in any direction is null, not a clamped cell. A probe silently
  // clamped to the edge would report a real cell's numbers for a point that is
  // not in the domain.
  assert.equal(cellAt(grid, -1e-9, 0.5), null);
  assert.equal(cellAt(grid, 0.5, -1e-9), null);
  assert.equal(cellAt(grid, 8 * 0.25, 0.5), null);
  assert.equal(cellAt(grid, 0.5, 5 * 0.25), null);
  assert.equal(cellAt(grid, NaN, 0.5), null);

  const outside = probeAt(grid, -1, 0.5, { nu: NU });
  assert.equal(outside.inside, false);
  assert.ok(Number.isNaN(outside.speed), "a point outside the domain has no speed");
});

test("M7 - velocity at a cell is the mean of that cell's own faces", () => {
  const grid = new StaggeredGrid(6, 6, 0.5);
  // A linear field, so the face average equals the exact centre value and any
  // off-by-one in the face indices shows up as a shift of exactly h/2.
  fillAnalytic(grid, (x) => 3 * x, (_x, y) => -2 * y);

  for (const [i, j] of [[1, 1], [3, 4], [6, 6]]) {
    const { x, y } = grid.cellCentre(i, j);
    const sample = probeCell(grid, i, j, { nu: NU });
    assert.ok(Math.abs(sample.u - 3 * x) < 1e-15, `u at ${i},${j}: ${sample.u} vs ${3 * x}`);
    assert.ok(Math.abs(sample.v - -2 * y) < 1e-15, `v at ${i},${j}`);
    assert.ok(Math.abs(sample.speed - Math.hypot(3 * x, 2 * y)) < 1e-15);
    assert.equal(sample.inside, true);
    assert.equal(sample.solid, false);
    assert.equal(sample.finite, true);
  }
});

test("M7 - vorticity matches solid-body rotation exactly, sign included", () => {
  // u = -w0*y, v = w0*x is rotation at angular rate w0, whose vorticity is
  // 2*w0 everywhere. Both difference quotients are of a linear field, so the
  // answer is exact - which means a tolerance here would only be hiding
  // something. A transposed index or a swapped subtraction gives -2*w0 or 0.
  const w0 = 1.75;
  const grid = new StaggeredGrid(7, 9, 0.2);
  fillAnalytic(grid, (_x, y) => -w0 * y, (x) => w0 * x);

  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      assert.ok(
        Math.abs(vorticityAtCell(grid, i, j) - 2 * w0) < 1e-14,
        `cell ${i},${j}: ${vorticityAtCell(grid, i, j)} should be ${2 * w0}`
      );
    }
  }
  // And at a node, where the quantity actually lives and no averaging happens.
  assert.ok(Math.abs(vorticityAtNode(grid, 3, 4) - 2 * w0) < 1e-14);

  // Simple shear pins the sign on its own: u = S*y with v = 0 has vorticity
  // -S, so a convention flipped to du/dy - dv/dx would pass the rotation test
  // only if it also flipped the rotation's sign, and fails here either way.
  const S = 0.6;
  const shear = new StaggeredGrid(5, 5, 0.3);
  fillAnalytic(shear, (_x, y) => S * y, () => 0);
  assert.ok(Math.abs(vorticityAtCell(shear, 3, 3) - -S) < 1e-14,
    `shear vorticity ${vorticityAtCell(shear, 3, 3)} should be ${-S}`);

  console.log(
    `[M7 vorticity] solid-body rotation w0=${w0} reads 2w0 to ` +
    `${Math.abs(vorticityAtCell(grid, 4, 5) - 2 * w0).toExponential(1)}; ` +
    `shear S=${S} reads ${vorticityAtCell(shear, 3, 3).toFixed(3)}`
  );
});

test("M7 - vorticity is second order against a closed-form field", () => {
  // Solid-body rotation is linear, so the difference quotients are exact there
  // and it pins the formula rather than its accuracy. Taylor-Green is not, and
  // it says how fast the error actually falls:
  //
  //   u = -cos(x)sin(y),  v = sin(x)cos(y)   =>   omega = 2 cos(x) cos(y)
  //
  // At a NODE the two differences are centred on the point, and the error
  // halves squared. At a CENTRE the four-corner average adds its own
  // second-order term - about seven times larger in magnitude here - and the
  // rate is unchanged. Which is the justification for reporting the average:
  // it costs a constant, not an order.
  //
  // Worth recording: the first version of this measurement compared against
  // 2*sin(x)*sin(y) and reported a max error of exactly 2.0 that did not
  // converge. The code was right and the reference was wrong - which is why
  // the rotation test above uses a field whose answer is unmistakable.
  const errors = { node: [], centre: [] };
  for (const n of [16, 32, 64]) {
    const h = (2 * Math.PI) / n;
    const grid = new StaggeredGrid(n, n, h);
    fillAnalytic(
      grid,
      (x, y) => -Math.cos(x) * Math.sin(y),
      (x, y) => Math.sin(x) * Math.cos(y)
    );
    let node = 0;
    let centre = 0;
    for (let j = 1; j <= n; j++) {
      for (let i = 1; i <= n; i++) {
        node = Math.max(node, Math.abs(
          vorticityAtNode(grid, i, j) - 2 * Math.cos(i * h) * Math.cos(j * h)
        ));
        const { x, y } = grid.cellCentre(i, j);
        centre = Math.max(centre, Math.abs(
          vorticityAtCell(grid, i, j) - 2 * Math.cos(x) * Math.cos(y)
        ));
      }
    }
    errors.node.push(node);
    errors.centre.push(centre);
  }

  for (const where of ["node", "centre"]) {
    for (let m = 1; m < errors[where].length; m++) {
      const rate = Math.log2(errors[where][m - 1] / errors[where][m]);
      assert.ok(
        rate > 1.85 && rate < 2.15,
        `${where} vorticity converges at ${rate.toFixed(2)}, which is not second order`
      );
    }
  }
  console.log(
    `[M7 vorticity order] node ${errors.node.map((e) => e.toExponential(2)).join(" -> ")} ` +
    `(rate ${Math.log2(errors.node[0] / errors.node[2]).toFixed(2)} over 4x); ` +
    `centre ${errors.centre.map((e) => e.toExponential(2)).join(" -> ")} ` +
    `(${(errors.centre[2] / errors.node[2]).toFixed(1)}x the node error, same order)`
  );
});

test("M7 - a probe inside a body reports solid, not a plausible zero", () => {
  // The faces around a solid cell hold what the solver put there for the
  // stencils one layer out: zero on the surface, a reflection inside. Averaging
  // them yields a number, and that is the danger - it would read as fluid at
  // rest rather than as no fluid at all.
  const grid = new StaggeredGrid(6, 6, 0.5);
  fillAnalytic(grid, () => 2, () => 0);
  grid.solid[grid.idx(3, 3)] = 1;

  const solid = probeCell(grid, 3, 3, { nu: NU });
  assert.equal(solid.solid, true);
  assert.equal(solid.finite, false);
  for (const quantity of ["u", "v", "speed", "pressure", "vorticity", "cellRe"]) {
    assert.ok(Number.isNaN(solid[quantity]), `${quantity} must be NaN inside a body, not 0`);
  }
  // Its neighbour is ordinary fluid and still reports.
  assert.equal(probeCell(grid, 4, 3, { nu: NU }).solid, false);
});

test("M7 - cell Re is the cell's own Reynolds number, not the scenario's", () => {
  // The distinction the panel is never allowed to blur. |u|h/nu compares
  // advection to diffusion across ONE CELL; the scenario's Re uses a
  // characteristic length that spans many. They differ by roughly nx, and
  // reporting one under the other's name would be the same mislabelling this
  // project keeps finding.
  const scenario = buildScenario("cylinder");
  const { grid, params } = scenario;
  const sample = probeCell(grid, 4, Math.round(grid.ny / 2), { nu: params.nu });
  assert.ok(Math.abs(sample.cellRe - (sample.speed * grid.h) / params.nu) < 1e-15);

  const ratio = scenario.Re / sample.cellRe;
  assert.ok(ratio > 10, `cell Re ${sample.cellRe} against scenario Re ${scenario.Re}`);
  console.log(
    `[M7 cell Re] cylinder: cell Re = ${sample.cellRe.toFixed(3)} against a scenario ` +
    `Re of ${scenario.Re} - a factor of ${ratio.toFixed(0)}, which is why they are never ` +
    `given the same name`
  );

  // A viscosity of zero has no Reynolds number to report, and must not produce
  // Infinity dressed as a measurement.
  assert.ok(Number.isNaN(probeCell(grid, 4, 4, { nu: 0 }).cellRe));
});

test("M7 - the pressure datum is read from the solver's own rule", () => {
  // Whether p is a gauge or an absolute value is not a display decision. With
  // nothing prescribing a pressure the Poisson problem is pure Neumann and the
  // solver zero-means the answer; with a pressure boundary it does not, and
  // saying "gauge" there would be describing a different solve.
  const cavity = buildScenario("cavity");
  const channel = buildScenario("pressure-channel");
  assert.equal(pressureIsGauge(boundaryPlanFor(cavity.grid, cavity.bc)), true);
  assert.equal(pressureIsGauge(boundaryPlanFor(channel.grid, channel.bc)), false);

  // Behavioural, not just structural: run each and look at the mean pressure.
  // The gauge case is projected to zero mean every step; the prescribed case
  // is free to sit wherever its boundaries put it, and here it does.
  const gauge = new SimulationSession("cavity");
  const fixed = new SimulationSession("pressure-channel");
  for (let n = 0; n < 12; n++) { gauge.advance(); fixed.advance(); }
  const gaugeMean = inspectScalar(gauge.grid, (i, j) => gauge.grid.p[gauge.grid.idx(i, j)]).mean;
  const fixedMean = inspectScalar(fixed.grid, (i, j) => fixed.grid.p[fixed.grid.idx(i, j)]).mean;
  assert.ok(Math.abs(gaugeMean) < 1e-9, `zero-meaned field has mean ${gaugeMean}`);
  assert.ok(Math.abs(fixedMean) > 1e-6, `prescribed-pressure field has mean ${fixedMean}`);
  console.log(
    `[M7 datum] cavity mean p = ${gaugeMean.toExponential(2)} (gauge, zero-meaned); ` +
    `pressure-channel mean p = ${fixedMean.toExponential(2)} (absolute)`
  );
});

// ---------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------

test("M7 - a probe is sampled once per solver step, carrying simulated time", () => {
  // The point of sampling in the session rather than in the harness's repaint.
  // The harness runs up to four steps per frame, so a sample taken on repaint
  // would keep one reading in four - invisible on a smooth signal, and
  // aliasing on anything varying near the step rate.
  const session = new SimulationSession("cavity");
  const probe = session.addProbe(0.5, 0.5);
  assert.equal(probe.history.length, 0, "pinning is not a measurement");

  const times = [];
  for (let n = 0; n < 9; n++) {
    session.advance();
    times.push(session.simulatedTime);
  }
  assert.equal(probe.history.length, 9, "one sample per step, no more and no fewer");

  const series = probe.history.series("speed");
  assert.equal(series.time.length, 9);
  for (let n = 0; n < 9; n++) {
    assert.equal(series.time[n], times[n], `sample ${n} must carry the step's simulated time`);
  }
  // Strictly increasing, which is what makes it a time axis at all.
  for (let n = 1; n < 9; n++) assert.ok(series.time[n] > series.time[n - 1]);
});

test("M7 - the history wraps at capacity, oldest first", () => {
  const set = new ProbeSet({ capacity: 4 });
  const probe = set.add(0, 0);
  for (let n = 1; n <= 7; n++) {
    probe.history.push(n, { speed: n, u: n, v: 0, pressure: 0, vorticity: 0, cellRe: 0 });
  }
  assert.equal(probe.history.length, 4);
  const series = probe.history.series("speed");
  assert.deepEqual(Array.from(series.value), [4, 5, 6, 7], "the oldest three are gone");
  assert.deepEqual(Array.from(series.time), [4, 5, 6, 7], "and time comes back in order");

  assert.throws(() => probe.history.series("dye"), /no such probe quantity/);
  assert.equal(PROBE_CAPACITY > 1000, true);
});

test("M7 - anything that rebuilds the field clears the history, keeping the probes", () => {
  // A curve that runs continuously across a reset is two different simulations
  // drawn as one line. The probe stays - the point is still a point - but what
  // it read of a field that no longer exists does not.
  const session = new SimulationSession("cylinder");
  const probe = session.addProbe(2.0, 2.0);
  for (let n = 0; n < 5; n++) session.advance();
  assert.equal(probe.history.length, 5);

  session.reset();
  assert.equal(probe.history.length, 0, "a reset discards the history");
  assert.equal(session.probes.count, 1, "and keeps the probe");
  assert.equal(probe.last, null, "including the last reading");

  // A geometry edit goes through the same path, so it must behave the same.
  for (let n = 0; n < 5; n++) session.advance();
  assert.equal(probe.history.length, 5);
  session.applyEdit(TOOLS.rectangle(6.0, 2.0, 7.0, 4.0));
  assert.equal(probe.history.length, 0, "a geometry edit rebuilds the field, so the history goes");
  assert.equal(session.probes.count, 1);

  // A scenario change discards the probes themselves: a place in one domain is
  // not a place in another of a different size.
  session.load("cavity");
  assert.equal(session.probes.count, 0);
});

test("M7 - probes are refused outside the domain and allowed inside a wall", () => {
  const session = new SimulationSession("cylinder");
  const { grid } = session;
  assert.throws(() => session.addProbe(-0.1, 1), /outside the domain/);
  assert.throws(() => session.addProbe(1, grid.ny * grid.h + 0.1), /outside the domain/);
  assert.throws(() => session.addProbe(NaN, 1), /outside the domain/);

  // Inside the cylinder is a real cell with no fluid in it, and erasing the
  // body around it is an ordinary thing to do next - so it is pinned, and says
  // what it is.
  const centre = grid.cellCentre(
    ...(() => {
      for (let j = 1; j <= grid.ny; j++) {
        for (let i = 1; i <= grid.nx; i++) if (grid.solid[grid.idx(i, j)]) return [i, j];
      }
      throw new Error("the cylinder scenario should have solid cells");
    })()
  );
  const inWall = session.addProbe(centre.x, centre.y);
  assert.equal(session.readProbe(inWall).solid, true);
  assert.equal(session.readProbe(inWall).inside, true);
});

test("M7 - reading a probe records nothing and changes nothing", () => {
  // Two separate promises. A hover readout must not enter the history the plot
  // is drawing, and no probe may ever write to the field - the same rule the
  // dye tracer is held to in M3.
  const session = new SimulationSession("cavity");
  const probe = session.addProbe(0.5, 0.5);
  for (let n = 0; n < 4; n++) session.advance();

  const before = {
    u: Float64Array.from(session.grid.u),
    v: Float64Array.from(session.grid.v),
    p: Float64Array.from(session.grid.p),
  };
  for (let n = 0; n < 20; n++) session.readProbe(probe);
  assert.equal(probe.history.length, 4, "reading is not recording");
  assert.deepEqual(Float64Array.from(session.grid.u), before.u, "a probe must not write to u");
  assert.deepEqual(Float64Array.from(session.grid.v), before.v);
  assert.deepEqual(Float64Array.from(session.grid.p), before.p);
});

test("M7 - removing or clearing probes leaves the run and the other histories alone", () => {
  // Probes are a reading, not a simulation input, so adding and dropping them
  // must be invisible to the flow - and dropping one must not disturb what the
  // others have recorded.
  const session = new SimulationSession("cavity");
  const a = session.addProbe(0.25, 0.75);
  const b = session.addProbe(0.5, 0.5);
  const c = session.addProbe(0.75, 0.25);
  for (let n = 0; n < 6; n++) session.advance();

  const iteration = session.iteration;
  const time = session.simulatedTime;
  const field = Float64Array.from(session.grid.u);
  const kept = Array.from(a.history.series("speed").value);

  assert.equal(session.removeProbe(b.id), true);
  assert.equal(session.removeProbe(b.id), false, "removing it twice is not a change");
  assert.equal(session.probes.count, 2);
  assert.deepEqual(
    Array.from(a.history.series("speed").value), kept,
    "removing one probe must not touch another's history"
  );
  assert.equal(c.history.length, 6);
  assert.equal(session.iteration, iteration, "and must not step the simulation");
  assert.equal(session.simulatedTime, time);
  assert.deepEqual(Float64Array.from(session.grid.u), field, "nor touch the field");

  // The run carries on past it, and the surviving probes keep recording.
  session.advance();
  assert.equal(c.history.length, 7);
  assert.equal(a.history.length, 7);

  assert.equal(session.clearProbes(), true);
  assert.equal(session.clearProbes(), false, "clearing an empty set is not a change");
  assert.equal(session.probes.count, 0);
  assert.equal(session.iteration, iteration + 1, "clearing probes must not reset the run");
  session.advance();
  assert.equal(session.iteration, iteration + 2, "and the solver runs on with none pinned");
});

test("M7 - probe labels are stable when one in the middle is removed", () => {
  // Renumbering would rename the series someone is watching, mid-run.
  const set = new ProbeSet();
  const [a, b, c] = [set.add(0, 0), set.add(1, 0), set.add(2, 0)];
  assert.deepEqual([a.label, b.label, c.label], ["P1", "P2", "P3"]);
  assert.equal(set.remove(b.id), true);
  assert.deepEqual(set.probes.map((p) => p.label), ["P1", "P3"]);
  assert.equal(set.remove(b.id), false, "removing it twice is not a change");
  const d = set.add(3, 0);
  assert.equal(d.label, "P4", "and an id is never reused");
  assert.notEqual(a.colour, b.colour, "adjacent probes are distinguishable");

  assert.equal(set.clear(), true);
  assert.equal(set.clear(), false);
  assert.throws(() => set.add(NaN, 0), /finite coordinates/);
});

test("M7 - every plotted quantity is one the sampler actually produces", () => {
  // The selector is built from this table, so a quantity listed here and not
  // read by the sampler would appear in the UI and plot a column of undefined.
  const grid = new StaggeredGrid(4, 4, 0.5);
  const sample = probeCell(grid, 2, 2, { nu: NU });
  for (const quantity of Object.keys(PROBE_QUANTITIES)) {
    assert.ok(quantity in sample, `the sampler produces no "${quantity}"`);
    assert.equal(typeof sample[quantity], "number");
  }
  // And never called "local Re" anywhere a reader could see it.
  assert.match(PROBE_QUANTITIES.cellRe.label, /cell/i);
  assert.doesNotMatch(PROBE_QUANTITIES.cellRe.label, /local/i);
});

// ---------------------------------------------------------------------------
// The plot's arithmetic
// ---------------------------------------------------------------------------

test("M7 - a broken sample breaks the line instead of being drawn through", () => {
  // lineTo(NaN, NaN) neither throws nor draws, so a plot that ignores the
  // difference shows a straight line from the last good sample to the next -
  // which looks exactly like data. The gap is the whole point.
  const time = Float64Array.from([0, 1, 2, 3, 4, 5]);
  const value = Float64Array.from([1, 2, NaN, NaN, 3, 4]);
  const layout = layoutSeries({ time, value }, { width: 200, height: 100 });

  assert.equal(layout.segments.length, 2, "the run must be split where the data is");
  assert.deepEqual(layout.segments.map((s) => s.length), [2, 2]);
  assert.equal(layout.points, 4);
  assert.equal(layout.gaps, 1);
  assert.equal(layout.range.nonFinite, 2, "and the count must be reported, not swallowed");
  assert.deepEqual([layout.range.lo, layout.range.hi], [1, 4],
    "the range must come from the finite samples only");

  // An entirely broken series yields no range at all rather than a plausible
  // zero - the mistake physics/fieldStats.js exists to prevent.
  const broken = seriesRange(Float64Array.from([NaN, Infinity, NaN]));
  assert.equal(broken.usable, false);
  assert.ok(Number.isNaN(broken.lo) && Number.isNaN(broken.hi));
  assert.equal(broken.nonFinite, 3);
  assert.equal(layoutSeries({ time, value: Float64Array.from([NaN, NaN, NaN, NaN, NaN, NaN]) },
    { width: 200, height: 100 }).segments.length, 0);
});

test("M7 - a constant series draws flat, and one sample draws at the newest edge", () => {
  const flat = seriesRange(Float64Array.from([2.5, 2.5, 2.5]));
  assert.equal(flat.flat, true);
  assert.ok(flat.lo < 2.5 && flat.hi > 2.5, "a constant series must still occupy the box");

  const layout = layoutSeries(
    { time: Float64Array.from([0, 1, 2]), value: Float64Array.from([2.5, 2.5, 2.5]) },
    { width: 200, height: 100, padding: 4 }
  );
  const ys = layout.segments[0].map((p) => p.py);
  assert.ok(ys.every(Number.isFinite), "a flat series must not divide by zero");
  assert.ok(Math.abs(ys[0] - 50) < 1e-9, `a constant sits mid-box, got ${ys[0]}`);
  // Inside the padding, at both ends.
  assert.ok(Math.abs(layout.segments[0][0].px - 4) < 1e-9);
  assert.ok(Math.abs(layout.segments[0][2].px - 196) < 1e-9);

  // A single sample has no time span. Drawn at the right-hand edge, where the
  // newest reading belongs, rather than floating in the middle.
  const one = layoutSeries(
    { time: Float64Array.from([3]), value: Float64Array.from([7]) },
    { width: 200, height: 100, padding: 4 }
  );
  assert.equal(one.points, 1);
  assert.ok(Math.abs(one.segments[0][0].px - 196) < 1e-9);
  assert.equal(layoutSeries({ time: new Float64Array(0), value: new Float64Array(0) },
    { width: 200, height: 100 }).points, 0);
});
