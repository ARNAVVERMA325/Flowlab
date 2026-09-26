// The guided experiments of M10.
//
// Each experiment asks one question a person could ask of a fluid - does a
// channel flow really come out parabolic, does a wake grow with Reynolds
// number, does a smooth bend cost less pressure than a sharp one - and answers
// it by running the solver and MEASURING, then setting the measurement beside
// whatever reference exists and saying how much weight that reference can
// carry.
//
// ---------------------------------------------------------------------------
// TWO WAYS A RUN ENDS
// ---------------------------------------------------------------------------
//
// STEADY: the field has stopped changing. Declared on the measured rate of
// change of the field, max |du/dt| over a step, against the scenario's own
// scale U^2/L - the same criterion the M2 cavity benchmark uses. A run that
// hits its time cap first is reported as NOT steady, with the rate it reached;
// its numbers are shown but marked, never presented as converged.
//
// AVERAGED: the flow never settles, so it is sampled over a window after the
// start-up transient and reported as a mean with its spread. Both bends at
// Re 200 are like this - measured still shedding from the corner at t = 68 and
// t = 91 - so "run to steady" would simply run until the cap and then report a
// snapshot of one arbitrary instant.
//
// Measured times to a steady state on this machine, headless, to set the
// caps: pressure channel 4 s; cavity at Re 100, 400, 1000: 49, 64, 87 s;
// cylinder at Re 20 and 40: about 105 s each.

import { boundaryPlanFor } from "../solver/ns2d.js";
import { bodyExtent, boundaryMeanPressure, primaryVortexCentre, wakeLength } from "../physics/features.js";
import { rotationSummary } from "../physics/gradients.js";
import { inspectField } from "../physics/fieldStats.js";
import { separationPoints, surfaceFaces, wallShearSummary } from "../physics/wallShear.js";
import { PRIMARY_VORTEX_CENTRE } from "../validation/ghia.js";

// The flux through the column of u faces at index i, per unit depth.
function columnFlux(grid, i) {
  let flux = 0;
  for (let j = 1; j <= grid.ny; j++) {
    if (grid.solid[grid.idx(i, j)] || grid.solid[grid.idx(i + 1, j)]) continue;
    flux += grid.u[grid.idx(i, j)] * grid.h;
  }
  return flux;
}

const PIPE = {
  id: "pipe",
  title: "Pipe flow: is it really a parabola?",
  question:
    "A pressure difference drives fluid between two plates. Theory says the " +
    "velocity profile is a parabola, the flow rate is dp*w^2/(12*mu*L), and the " +
    "wall stress is 6*mu*U/w. Does the solver reproduce all three without being " +
    "told the answer?",
  method:
    "Run the pressure-driven channel from rest until the field stops changing, " +
    "then measure the flow rate, the profile at mid-channel and the wall shear, " +
    "and compare each with the closed-form plane-Poiseuille solution.",
  reference: "planePoiseuille (derived - closed form, nothing transcribed)",
  runs: [
    {
      label: "channel, from rest to steady",
      scenario: "pressure-channel",
      stop: { steady: 1e-4, maxTime: 60 },
      view: { mode: "velocity", overlays: { vectors: true } },
      measure(session) {
        const { grid, bc, params } = session;
        const w = grid.ny * grid.h;
        const L = grid.nx * grid.h;
        const mu = params.nu * params.rho;
        const dp = bc.left.p - bc.right.p;
        const exactU = (dp * w * w) / (12 * mu * L);
        const mid = Math.round(grid.nx / 2);
        const meanU = columnFlux(grid, mid) / w;
        // The profile against the parabola evaluated at the SAME points - the
        // u samples sit at cell-centre heights, and comparing the sampled peak
        // with 1.5 exactly would count the sampling offset as an error.
        let profileError = 0;
        let peak = 0;
        for (let j = 1; j <= grid.ny; j++) {
          const y = (j - 0.5) * grid.h;
          const exact = 6 * exactU * (y / w) * (1 - y / w);
          const u = grid.u[grid.idx(mid, j)];
          profileError = Math.max(profileError, Math.abs(u - exact));
          peak = Math.max(peak, u);
        }
        const plan = boundaryPlanFor(grid, bc);
        const tau = Math.abs(wallShearSummary(surfaceFaces(grid, { nu: params.nu, rho: params.rho, plan })).peak);
        return { exactU, meanU, profileError, peak, tau, exactTau: (6 * mu * meanU) / w };
      },
    },
  ],
  conclude([run]) {
    const m = run.measured;
    return {
      rows: [
        row("mean velocity (flow rate / width)", m.meanU, m.exactU, 0.01, true,
          "dp*w^2/(12*mu*L) from the scenario's own pressure drop"),
        row("worst profile error vs the parabola", m.profileError / (1.5 * m.exactU), 0, 0.01, false,
          "as a fraction of the exact centreline speed, at the solver's own sample heights"),
        row("wall shear stress", m.tau, m.exactTau, 0.01, true, "6*mu*U/w, from M9's per-face wall shear"),
      ],
      summary:
        "All three come from the solver without the answer being put in: the " +
        "inlet and outlet only fix a pressure, and the flow rate, the parabola " +
        "and the wall stress are outputs.",
    };
  },
};

const CYLINDER = {
  id: "cylinder",
  title: "Cylinder wake: does the bubble grow with Re?",
  question:
    "Behind a cylinder at low Reynolds number the flow separates and a pair of " +
    "standing eddies forms. How long is that bubble, and how does it change " +
    "when the Reynolds number doubles?",
  method:
    "Run the cylinder channel to a steady state at Re 20 and at Re 40 - both " +
    "below the onset of shedding - and measure the bubble along the centreline " +
    "from the body's rear face to where the flow turns forward again.",
  reference:
    "cylinderWakeLength (UNVERIFIED, and for an UNBOUNDED cylinder: L/D about " +
    "0.93 at Re 20 and 2.3 at Re 40)",
  runs: [20, 40].map((Re) => ({
    label: `Re ${Re}, to steady`,
    scenario: "cylinder",
    Re,
    stop: { steady: 1e-3, maxTime: 60 },
    view: { mode: "velocity", overlays: { streamlines: true } },
    measure(session) {
      const { grid } = session;
      const body = bodyExtent(grid);
      const wake = wakeLength(grid, { row: body.row, rear: body.x1, D: body.height });
      const blockage = body.height / (grid.ny * grid.h);
      return { Re, lengthOverD: wake.lengthOverD, separated: wake.separated, blockage, D: body.height };
    },
  })),
  conclude(runs) {
    const [a, b] = runs.map((run) => run.measured);
    const unbounded = { 20: 0.93, 40: 2.3 };
    return {
      rows: [
        row("L/D at Re 20", a.lengthOverD, unbounded[20], null, false, "reference is unbounded flow"),
        row("L/D at Re 40", b.lengthOverD, unbounded[40], null, false, "reference is unbounded flow"),
        row("growth L(40)/L(20)", b.lengthOverD / a.lengthOverD, unbounded[40] / unbounded[20], null, false,
          "the trend, which confinement changes less than the lengths themselves"),
      ],
      summary:
        `${grows(a, b)} ` +
        `This channel is only ${(1 / a.blockage).toFixed(1)} diameters wide ` +
        `(${(a.blockage * 100).toFixed(0)}% blockage), and the reference is for an ` +
        `unbounded cylinder whose values are themselves unverified - so the lengths ` +
        `are not expected to match, and no pass or fail is claimed. Confinement ` +
        `accelerates the flow past the body and shortens the bubble; the direction ` +
        `is what should survive it.`,
    };
  },
};

// The bends shed from the corner at Re 200 and never settle, so the
// comparison is between TIME AVERAGES over a window after the start-up
// transient, each reported with its spread.
function bendRun(scenario, label) {
  return {
    label,
    scenario,
    stop: { average: { from: 20, to: 35 } },
    view: { mode: "velocity", overlays: { streamlines: true } },
    sample(session) {
      const { grid, bc, params } = session;
      const plan = boundaryPlanFor(grid, bc);
      const inlet = boundaryMeanPressure(grid, plan, "inflow");
      const outlet = boundaryMeanPressure(grid, plan, "outflow");
      const faces = surfaceFaces(grid, { nu: params.nu, rho: params.rho, plan });
      const rotation = rotationSummary(grid);
      return {
        pressureDrop: inlet.mean - outlet.mean,
        peakSpeed: inspectField(grid).maxSpeed,
        separations: separationPoints(faces, grid).length,
        rotating: rotation.rotating / rotation.fluid,
      };
    },
  };
}

const BENDS = {
  id: "bends",
  title: "Sharp vs smooth bend: what does the corner cost?",
  question:
    "Fluid turns 90 degrees through a duct. Does rounding the corner reduce the " +
    "pressure it takes to push the flow round, and does it stop the flow " +
    "separating from the inner wall?",
  method:
    "Run each bend at Re 200. Neither settles - both shed from the corner - so " +
    "each is sampled every few steps between t = 20 and t = 35, after the " +
    "start-up transient, and compared as time averages with their spread.",
  reference: "none external - the bend cases are self-validated (M2)",
  runs: [bendRun("bend-sharp", "sharp (mitre) bend"), bendRun("bend-smooth", "smooth (radiused) bend")],
  conclude([sharp, smooth]) {
    const s = sharp.averaged;
    const r = smooth.averaged;
    const lower = r.pressureDrop.mean < s.pressureDrop.mean;
    // Said from the numbers, not assumed: the sentence that credits the radius
    // with removing separation is only written when the smooth bend measured
    // fewer separation points.
    const counts =
      ` On the walls, the sharp bend shows ${s.separations.mean.toFixed(1)} separation ` +
      `points on average against ${r.separations.mean.toFixed(1)} for the smooth one`;
    const separation = r.separations.mean < s.separations.mean
      ? `${counts} - the flow tearing off the inner corner is what the radius removes.`
      : `${counts} - so over this window the radius did NOT reduce separation.`;
    return {
      rows: [
        compare("inlet-to-outlet pressure drop", s.pressureDrop, r.pressureDrop),
        compare("peak speed", s.peakSpeed, r.peakSpeed),
        compare("separation points on the walls", s.separations, r.separations),
        compare("fluid rotating (margin 10%)", s.rotating, r.rotating),
      ],
      summary: lower
        ? `The smooth bend needs ${((1 - r.pressureDrop.mean / s.pressureDrop.mean) * 100).toFixed(0)}% ` +
          `less pressure to push the same inflow round, on average over the window. ` +
          `That is the direction engineering loss coefficients predict, and no ` +
          `number here is compared with one - they are for turbulent pipe elbows, ` +
          `not a laminar 2D duct at Re 200.` + separation
        : `The smooth bend did NOT come out cheaper on average over this window. ` +
          `Reported as measured; the spread above says how much of that is the ` +
          `shedding rather than the geometry.`,
      detail: separation,
    };
  },
};

const SWEEP = {
  id: "sweep",
  title: "Reynolds sweep: where does the cavity vortex sit?",
  question:
    "A lid drags fluid round a square cavity. As the Reynolds number rises from " +
    "100 to 1000, how does the centre of the main vortex move - and does the " +
    "solver put it where the standard benchmark does?",
  method:
    "Run the cavity to a steady state at Re 100, 400 and 1000 and locate the " +
    "primary vortex centre as the interior point of minimum speed - the " +
    "measurement the M2 Ghia comparison is built on - then compare each with " +
    "Ghia, Ghia & Shin (1982).",
  reference: "ghia1982 (VERIFIED against an independent source; 129x129 grid there, 64x64 here)",
  runs: [100, 400, 1000].map((Re) => ({
    label: `Re ${Re}, to steady`,
    scenario: "cavity",
    Re,
    stop: { steady: 1e-4, maxTime: 80 },
    view: { mode: "velocity", overlays: { streamlines: true } },
    measure(session) {
      const centre = primaryVortexCentre(session.grid);
      const ghia = PRIMARY_VORTEX_CENTRE[Re];
      return { Re, x: centre.x, y: centre.y, ghia, h: session.grid.h,
        distance: Math.hypot(centre.x - ghia.x, centre.y - ghia.y) };
    },
  })),
  conclude(runs) {
    const h = runs[0].measured.h;
    // Two cells. The measurement is the CELL of minimum speed, so it cannot
    // resolve better than one cell; the second covers Ghia's centres sitting on
    // a 129-point grid that does not line up with this one.
    const tolerance = 2 * h;
    return {
      rows: runs.map((run) => {
        const m = run.measured;
        return {
          quantity: `vortex centre at Re ${m.Re}`,
          measured: `(${m.x.toFixed(3)}, ${m.y.toFixed(3)})`,
          reference: `(${m.ghia.x.toFixed(3)}, ${m.ghia.y.toFixed(3)})`,
          note: `${(m.distance / h).toFixed(1)} cells away`,
          status: m.distance <= tolerance ? "agrees" : "differs",
        };
      }),
      summary:
        `${vortexMotion(runs.map((run) => run.measured))} ` +
        `Agreement is judged to two cells (${tolerance.toFixed(3)}): the ` +
        "measurement is the cell of minimum speed and cannot resolve finer than " +
        "one, and Ghia's grid does not line up with this one.",
    };
  },
};

// What the wake did between the two runs, from the measurements.
function grows(a, b) {
  if (!a.separated || !b.separated) {
    return `No separation bubble was found at Re ${a.separated ? b.Re : a.Re}, so ` +
      `there is no length to compare there.`;
  }
  return b.lengthOverD > a.lengthOverD
    ? `The bubble grew from ${a.lengthOverD.toFixed(2)} to ${b.lengthOverD.toFixed(2)} ` +
      `diameters as Re doubled.`
    : `The bubble did NOT grow with Re here: ${a.lengthOverD.toFixed(2)} at Re ${a.Re}, ` +
      `${b.lengthOverD.toFixed(2)} at Re ${b.Re}.`;
}

// How the measured vortex centre moved across the sweep, stated only as far as
// the measurements move monotonically - Ghia's centres move down and towards
// the middle, but the sentence is about what THIS run found.
function vortexMotion(centres) {
  const monotone = (key, sign) =>
    centres.every((c, k) => k === 0 || sign * (c[key] - centres[k - 1][key]) > 0);
  const parts = [];
  if (monotone("y", -1)) parts.push("down");
  if (centres.every((c, k) => k === 0 || Math.abs(c.x - 0.5) < Math.abs(centres[k - 1].x - 0.5))) {
    parts.push("towards the middle of the cavity");
  }
  if (parts.length === 0) {
    return "The measured vortex centre did not move steadily in one direction as Re rose.";
  }
  return `As Re rose the measured vortex centre moved ${parts.join(" and ")} - ` +
    "inertia carries the flow further round before viscosity turns it.";
}

// A comparison row with a reference. `relative` compares measured/reference
// against 1; otherwise the absolute difference is compared.
function row(quantity, measured, reference, tolerance, relative, note) {
  let status = "comparison only";
  if (tolerance !== null && Number.isFinite(measured)) {
    const error = relative ? Math.abs(measured / reference - 1) : Math.abs(measured - reference);
    status = error <= tolerance ? "agrees" : "differs";
  }
  if (!Number.isFinite(measured)) status = "not measured";
  return { quantity, measured, reference, tolerance, relative, note, status };
}

// A sharp-versus-smooth row from two time averages.
function compare(quantity, sharp, smooth) {
  return {
    quantity,
    measured: `${fmt(sharp.mean)} +/- ${fmt(sharp.spread)}`,
    reference: `${fmt(smooth.mean)} +/- ${fmt(smooth.spread)}`,
    note: "sharp | smooth, mean +/- standard deviation over the window",
    status: "comparison",
  };
}

function fmt(value) {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  return magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e4)
    ? value.toExponential(2)
    : String(Number(value.toPrecision(3)));
}

export const EXPERIMENTS = [PIPE, CYLINDER, BENDS, SWEEP];

export function experimentById(id) {
  return EXPERIMENTS.find((experiment) => experiment.id === id) ?? null;
}
