// The UI refresh: colour ramps, smooth rendering, the residual history.
//
// The refresh replaced two deliberate choices - single-hue ramps and one flat
// block per cell - at the user's request. These tests pin what the replacements
// are allowed to do and, more importantly, what they are not: interpolate
// colours, let a wall bleed into the fluid, average a NaN away, or claim a
// property (monotone lightness) that the chosen ramp does not have.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAGNITUDE_RAMP, LUT_SIZE, MAGNITUDE_RAMPS, NON_FINITE_COLOUR, SOLID_COLOUR,
  lutFor, sampleDiverging, sampleDye, sampleRamp, sampleViridis,
} from "../visualization/colormap.js";
import { blendCells, centreOffset, interpolateCells, subsampleFor } from "../visualization/fieldRenderer.js";
import { prepareView } from "../visualization/fieldSources.js";
import { layoutSeries } from "../visualization/timeseries.js";
import { ResidualHistory } from "../ui/residuals.js";
import { PROBE_COLOURS } from "../ui/probes.js";
import { compact } from "../ui/format.js";
import { SimulationSession } from "../ui/session.js";
import { SCENARIOS, buildScenario } from "../scenarios/index.js";

// OKLab lightness of an sRGB triple, 0..255. The same model the palette
// validator uses, so "monotone" here means what it means there.
function oklabL([r8, g8, b8]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(r8), lin(g8), lin(b8)];
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  return 0.2104542553 * Math.cbrt(l) + 0.793617785 * Math.cbrt(m) - 0.0040720468 * Math.cbrt(s);
}

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// ---------------------------------------------------------------------------
// Ramps
// ---------------------------------------------------------------------------

test("UI - the embedded ramps have the published endpoints", () => {
  // The tables were generated from matplotlib's reference implementation and
  // embedded, not transcribed. matplotlib is not a project dependency, so the
  // check here is on the endpoints every published copy of these maps agrees
  // on - a table pasted from the wrong map, or reversed, fails it.
  assert.equal(hex(sampleRamp(0)), "#30123b", "turbo starts dark violet");
  assert.equal(hex(sampleRamp(1)), "#7a0403", "and ends dark red");
  assert.equal(hex(sampleViridis(0)), "#440154");
  assert.equal(hex(sampleViridis(1)), "#fde725");
  assert.equal(hex(sampleDiverging(0)), "#3b4cc0", "coolwarm's blue arm");
  assert.equal(hex(sampleDiverging(1)), "#b40426", "and its red arm");
});

test("UI - each ramp has the lightness profile it is documented to have", () => {
  // The trade the refresh made, measured rather than asserted in a comment.
  const L = (sample) => Array.from({ length: 201 }, (_, k) => oklabL(sample(k / 200)));

  // Viridis is the monotone alternative, and has to BE monotone.
  const viridis = L(sampleViridis);
  for (let k = 1; k < viridis.length; k++) {
    assert.ok(viridis[k] >= viridis[k - 1] - 1e-9, `viridis lightness falls at ${k / 200}`);
  }

  // Turbo, the default, is NOT - it rises and then falls, which is the cost
  // named in visualization/colormap.js. Pinned so that claim cannot go stale.
  const turbo = L(sampleRamp);
  const peak = turbo.indexOf(Math.max(...turbo));
  assert.ok(peak > 20 && peak < 180, "turbo's lightness peaks in the middle, not at an end");
  assert.ok(turbo[200] < turbo[peak] - 0.3, "and falls a long way after it");

  // Coolwarm is a diverging map: each ARM monotone towards a light, neutral
  // centre, and the two ends balanced so neither sign reads as stronger.
  //
  // To within one display step. Right at the flat peak the 33-stop table,
  // interpolated linearly in sRGB, wobbles by about 0.001 in lightness - below
  // the ~0.004 that one 8-bit step is worth at this lightness, so invisible,
  // and measured rather than assumed away.
  const DISPLAY_STEP = 0.004;
  const coolwarm = L(sampleDiverging);
  for (let k = 1; k <= 100; k++) {
    assert.ok(coolwarm[k] >= coolwarm[k - 1] - DISPLAY_STEP, `blue arm darkens at ${k / 200}`);
  }
  for (let k = 101; k <= 200; k++) {
    assert.ok(coolwarm[k] <= coolwarm[k - 1] + DISPLAY_STEP, `red arm lightens at ${k / 200}`);
  }
  assert.ok(coolwarm[100] > coolwarm[0] + 0.3 && coolwarm[100] > coolwarm[200] + 0.3,
    "the centre is far lighter than either end");
  assert.ok(Math.abs(coolwarm[0] - coolwarm[200]) < 0.03, "the two arms end at matched lightness");
  const [r, g, b] = sampleDiverging(0.5);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 3, `the midpoint must be a neutral grey, got ${hex([r, g, b])}`);
  console.log(
    `[UI ramps] OKLab L - turbo ${turbo[0].toFixed(3)} -> ${turbo[peak].toFixed(3)} -> ${turbo[200].toFixed(3)} ` +
    `(not monotone, as documented); viridis ${viridis[0].toFixed(3)} -> ${viridis[200].toFixed(3)} (monotone); ` +
    `coolwarm ends ${coolwarm[0].toFixed(3)} / ${coolwarm[200].toFixed(3)}, centre ${coolwarm[100].toFixed(3)}`
  );
});

test("UI - the renderer's lookup table is the ramp, to within its quantisation", () => {
  for (const sampler of [sampleRamp, sampleViridis, sampleDiverging, sampleDye]) {
    const lut = lutFor(sampler);
    assert.equal(lut.length, LUT_SIZE * 3);
    let worst = 0;
    for (let k = 0; k <= 1000; k++) {
      const t = k / 1000;
      const n = 3 * Math.round(t * (LUT_SIZE - 1));
      const exact = sampler(t);
      worst = Math.max(worst, ...[0, 1, 2].map((c) => Math.abs(lut[n + c] - exact[c])));
    }
    assert.ok(worst <= 4, `a lookup table strays ${worst} from its ramp`);
    assert.equal(lutFor(sampler), lut, "and is built once, not per frame");
  }
});

test("UI - the solid colour is clear of every ramp, including the optional one", () => {
  // test9 checks the three ramps it knew about; viridis arrived with the
  // refresh and a wall must be distinguishable in it too.
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const [name, sampler] of Object.entries({ turbo: sampleRamp, viridis: sampleViridis, coolwarm: sampleDiverging, dye: sampleDye })) {
    let closest = Infinity;
    for (let k = 0; k <= 400; k++) closest = Math.min(closest, distance(SOLID_COLOUR, sampler(k / 400)));
    assert.ok(closest > 40, `a wall is only ${closest.toFixed(1)} from the ${name} ramp`);
  }
  assert.ok(distance(SOLID_COLOUR, NON_FINITE_COLOUR) > 100);
});

test("UI - the magnitude ramp is a choice for velocity and nothing else", () => {
  const session = new SimulationSession("cavity");
  for (let n = 0; n < 10; n++) session.advance();
  const grid = session.grid;
  assert.equal(DEFAULT_MAGNITUDE_RAMP, "turbo", "turbo is the default because it was asked for");
  assert.equal(prepareView("velocity", { grid }).ramp, MAGNITUDE_RAMPS.turbo.sample);
  assert.equal(prepareView("velocity", { grid, palette: "viridis" }).ramp, MAGNITUDE_RAMPS.viridis.sample);
  // A stale or mistyped setting falls back rather than leaving the field unpainted.
  assert.equal(prepareView("velocity", { grid, palette: "jet" }).ramp, MAGNITUDE_RAMPS.turbo.sample);
  // Signed fields have one map, whatever the magnitude choice.
  for (const id of ["pressure", "vorticity", "shear", "q", "continuity"]) {
    assert.equal(prepareView(id, { grid, palette: "viridis" }).ramp, sampleDiverging, `${id} ignores the palette`);
  }
  // And each choice says what it costs, so the legend can repeat it.
  for (const ramp of Object.values(MAGNITUDE_RAMPS)) assert.ok(ramp.note.length > 60);
  assert.match(MAGNITUDE_RAMPS.turbo.note, /greyscale/);
});

test("UI - probe identities come from the validated categorical palette", () => {
  // A probe's colour is an identity, so it is a categorical job and the slots
  // are the validated palette's dark steps in its fixed order. Pinned, so a
  // later edit that re-picks by eye is a visible change rather than a silent one.
  assert.deepEqual(PROBE_COLOURS, [
    "#3987e5", "#d95926", "#199e70", "#c98500",
    "#d55181", "#008300", "#9085e9", "#e66767",
  ]);
  assert.equal(new Set(PROBE_COLOURS).size, PROBE_COLOURS.length);
});

// ---------------------------------------------------------------------------
// Smooth rendering
// ---------------------------------------------------------------------------

function cellField(nx, ny, valueAt, solidAt = () => false) {
  const stride = nx + 2;
  const values = new Float64Array(stride * (ny + 2)).fill(NaN);
  const solid = new Uint8Array(stride * (ny + 2));
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = i + stride * j;
      solid[k] = solidAt(i, j) ? 1 : 0;
      values[k] = solid[k] ? 12345 : valueAt(i - 1, j - 1);   // garbage in the solid slot
    }
  }
  return { values, solid, stride };
}

test("UI - smooth rendering interpolates values exactly between fluid centres", () => {
  // Bilinear interpolation of a linear function is exact, so any slip in the
  // centre offsets shows up as a constant error rather than hiding in noise.
  const nx = 8;
  const ny = 6;
  const { values, solid, stride } = cellField(nx, ny, (ci, cj) => 0.3 * ci - 0.7 * cj + 2);
  let worst = 0;
  for (let n = 0; n <= 400; n++) {
    const cx = ((n * 37) % 700) / 100;
    const cy = ((n * 53) % 500) / 100;
    const got = interpolateCells(values, solid, stride, nx, ny, cx, cy);
    worst = Math.max(worst, Math.abs(got - (0.3 * cx - 0.7 * cy + 2)));
  }
  assert.ok(worst < 1e-12, `interpolation error ${worst}`);
  // Outside the centres it clamps to the edge centre rather than extrapolating.
  assert.equal(interpolateCells(values, solid, stride, nx, ny, -0.4, 0), 2);
  assert.deepEqual(centreOffset(-3, nx), { index: 0, frac: 0 });
  assert.deepEqual(centreOffset(99, nx), { index: nx - 2, frac: 1 });
});

test("UI - a wall never bleeds into the fluid, and a NaN is never averaged away", () => {
  // Cell (3, 3) is solid and holds 12345 - a stand-in for the ghost values the
  // solver keeps in solid slots. It must contribute nothing.
  const nx = 6;
  const ny = 6;
  const { values, solid, stride } = cellField(nx, ny, () => 1, (i, j) => i === 3 && j === 3);
  for (const [cx, cy] of [[1.5, 1.5], [2, 1.5], [1.2, 2.2], [1.9, 1.9]]) {
    assert.equal(interpolateCells(values, solid, stride, nx, ny, cx, cy), 1,
      `the solid cell leaked into (${cx}, ${cy})`);
  }

  // A non-finite fluid value poisons every pixel whose stencil touches it.
  values[4 + stride * 4] = NaN;
  assert.ok(Number.isNaN(interpolateCells(values, solid, stride, nx, ny, 2.5, 2.5)));
  assert.ok(Number.isNaN(interpolateCells(values, solid, stride, nx, ny, 3.4, 3.6)));
  assert.equal(interpolateCells(values, solid, stride, nx, ny, 0.5, 0.5), 1, "and nothing further away");

  // With every contributing centre solid there is nothing to interpolate.
  const all = cellField(4, 4, () => 1, () => true);
  assert.equal(blendCells(all.values, all.solid, all.stride, 1 + all.stride, 0.5, 0.5), null);
});

test("UI - the smooth renderer stays within its pixel budget on every scenario", () => {
  // Measured: rendering every display pixel is the SLOW option (36 ms for the
  // cavity), and a fixed budget with a bilinear upscale keeps every scenario
  // near 8 ms. Pinned so a larger grid cannot quietly blow the frame budget.
  for (const scenario of SCENARIOS) {
    const { grid } = buildScenario(scenario.id);
    for (const scale of [3, 5, 9, 14]) {
      const sub = subsampleFor(grid.nx, grid.ny, scale);
      assert.ok(sub >= 1 && sub <= Math.max(2, scale), `${scenario.id} at ${scale}: sub ${sub}`);
      const pixels = grid.nx * grid.ny * sub * sub;
      assert.ok(pixels <= 130000 || sub <= 2, `${scenario.id} renders ${pixels} pixels a frame`);
    }
  }
});

// ---------------------------------------------------------------------------
// Residuals and the chart axis
// ---------------------------------------------------------------------------

test("UI - the residual history is one reading per solver step, cleared on rebuild", () => {
  const session = new SimulationSession("cavity");
  for (let n = 0; n < 15; n++) session.advance();
  assert.equal(session.residuals.length, 15);
  const series = session.residuals.series();
  assert.deepEqual(Array.from(series.time), Array.from({ length: 15 }, (_, n) => n + 1));
  for (const value of series.value) {
    assert.ok(value <= session.params.divergenceTol, `a recorded step broke its bound: ${value}`);
  }
  assert.ok(session.residuals.latest().poisson > 0, "the pressure solve's iteration count is kept too");

  session.reset();
  assert.equal(session.residuals.length, 0, "a rebuilt field must not keep the old history");

  const ring = new ResidualHistory(4);
  for (let n = 1; n <= 7; n++) ring.record(n, { continuityError: n * 1e-8, poissonIterations: n });
  assert.deepEqual(Array.from(ring.series().time), [4, 5, 6, 7], "oldest first after wrapping");
});

test("UI - a fixed chart axis reports what it clips instead of dropping it", () => {
  // The residual chart's axis is anchored to the bound because the series,
  // fitted to itself, spans a fifth of a decade and draws its rounding noise
  // as a scribble. On a fixed axis a value outside it is drawn at the edge
  // and COUNTED - never silently dropped.
  const time = Float64Array.from([1, 2, 3, 4]);
  const value = Float64Array.from([1e-8, 5e-8, 1e-2, 0]);
  const laid = layoutSeries({ time, value }, {
    width: 200, height: 100, padding: 10, log: true, range: { lo: 1e-11, hi: 1e-4 },
  });
  assert.equal(laid.clipped, 1, "the 1e-2 sample is past the top and must be counted");
  assert.equal(laid.unplottable, 1, "an exact zero has no place on a log axis and is said to");
  assert.ok(Math.abs(laid.range.lo - 1e-11) < 1e-20 && Math.abs(laid.range.hi - 1e-4) < 1e-12);
  const ys = laid.segments.flat().map((p) => p.py);
  assert.ok(ys.every((y) => y >= 10 - 1e-9 && y <= 90 + 1e-9), "nothing is drawn outside the box");
});

test("UI - compact numbers keep the non-finite cases honest", () => {
  assert.equal(compact(0), "0");
  assert.equal(compact(1.4567), "1.46");
  assert.equal(compact(0.01393), "0.0139");
  assert.equal(compact(1234.5), "1230", "three significant figures");
  assert.equal(compact(1e-7), "1.00e-7");
  assert.equal(compact(-2.5e5), "-2.50e+5");
  assert.equal(compact(NaN), "NaN", "a broken value must read as broken, not as blank");
  assert.equal(compact(Infinity), "+Infinity");
});
