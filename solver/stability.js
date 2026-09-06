// Explicit-scheme stability limits, timestep selection, and the failure mode.
//
// The projection scheme in ns2d.js treats both advection and diffusion
// explicitly, so it has two hard stability limits and no way to survive
// violating either. Until now the timestep was a fixed number chosen per
// scenario by hand, with a guessed peak velocity - which is how the bend came
// to diverge: sizing against a peak of 2*U0 put the CFL number at 0.86 once
// the corner jet formed, because the flow actually accelerates to about
// 2.9*U0. The guess was wrong and nothing checked it.
//
// The two limits, for uniform h:
//
//   viscous     nu*dt*(2/h^2 + 2/h^2) <= 1   ->   dt <= h^2 / (4*nu)
//   convective  dt*(|u|/h + |v|/h) <= 1      ->   dt <= h / max(|u| + |v|)
//
// The convective one is stated per cell on the sum of the two components
// rather than on each separately: a flow running diagonally through a cell is
// constrained by both at once, and taking the maxima of |u| and |v|
// independently would under-constrain it.

export class SolverStabilityError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "SolverStabilityError";
    Object.assign(this, detail);
  }
}

// Largest |u| + |v| at any fluid cell centre, and whether the field is finite.
// Non-finite entries are counted rather than compared, for the reason spelled
// out in tests/regression_nonfinite_reporting.js: `s > max` is false for NaN
// and would report a calm field where there is a blown-up one.
export function peakCellSpeed(grid) {
  const { nx, ny, u, v, solid, stride } = grid;
  const idx = (i, j) => i + stride * j;
  let peak = 0;
  let nonFinite = 0;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      const k = idx(i, j);
      if (solid[k]) continue;
      const uc = (u[k - 1] + u[k]) / 2;
      const vc = (v[k - stride] + v[k]) / 2;
      const s = Math.abs(uc) + Math.abs(vc);
      if (!Number.isFinite(s)) { nonFinite++; continue; }
      if (s > peak) peak = s;
    }
  }
  return { peak: nonFinite > 0 ? NaN : peak, nonFiniteCells: nonFinite, finite: nonFinite === 0 };
}

// The hard limits for the current field. Exceeding either of these is not a
// matter of degree - the scheme is unconditionally unstable beyond them.
//
// `incomingSpeed` is a speed the field does not have YET but will have by the
// end of the step, in the convective limit's own norm of |u| + |v|. A momentum
// source is the case: it pulls a face toward its target, so the fluid can be
// moving at the target by the time the step finishes, and a limit computed from
// the field as it stands would not know. Zero for everything else, in which
// case this is exactly the previous function.
export function stabilityLimits(grid, nu, incomingSpeed = 0) {
  const { h } = grid;
  const { peak, finite, nonFiniteCells } = peakCellSpeed(grid);
  const effective = Math.max(peak, incomingSpeed);
  return {
    viscous: nu > 0 ? (h * h) / (4 * nu) : Infinity,
    convective: effective > 0 ? h / effective : Infinity,
    peakSpeed: peak,
    // What the convective limit was actually computed from, which differs from
    // peakSpeed exactly when a source is about to outrun the field.
    limitingSpeed: effective,
    incomingSpeed,
    finite,
    nonFiniteCells,
  };
}

// Picks the largest timestep the current field can be advanced with safely.
//
// safety is the fraction of the hard limit actually used. It is not a guess:
// see tests/test7_m1_hardening.js, which walks the safety factor up
// across the scenarios until each one diverges, and the documented margin in
// docs/M1-solver-hardening.md.
//
// growthLimit stops the timestep jumping upward the instant the flow relaxes.
// Without it dt oscillates - a large step raises the peak velocity, which
// forces a small step, which lets the velocity settle, which permits a large
// step again. Ramping up gently and dropping immediately is the standard
// asymmetry, and it is what makes the sequence stable rather than merely
// stable-on-average.
//
// maxTimestep caps the result independently of stability. A nearly stationary
// field has no convective limit at all, and taking an enormous step would be
// stable while destroying the temporal accuracy of the answer.
//
// `incomingSpeed` closes the gap this project has carried since M3: dt is
// chosen from the field BEFORE the step, so a step that accelerates the flow
// ends outside the limit the driver believes it is enforcing. Measured at an
// effective convective CFL near 5 on the first step of the sharp bend.
//
// A momentum source would turn that from a once-per-run event into a
// once-per-stroke one, because a brush accelerates the flow deliberately and
// repeatedly. The relaxation formulation bounds how far: the source's
// contribution leaves a face between its current velocity and the target, so
// the speed after the step is at most max(field peak, target). That bound is
// known before the step, which is what makes it usable here.
//
// This coupling belongs in the CHOICE, not in the rejection. The advection term
// this step evaluates uses the velocity the field has now, so the current
// field's CFL is the correct stability criterion for this step, and
// assertTimestepIsStable would be wrong to refuse it. What the coupling buys is
// the NEXT step: dt was sized for a field moving at the target, so the field
// that exists afterwards is already within it. Nothing is rejected that would
// have worked.
export function computeStableTimestep(grid, {
  nu,
  safety = 0.4,
  maxTimestep = Infinity,
  previousTimestep = null,
  growthLimit = 1.1,
  incomingSpeed = 0,
}) {
  const limits = stabilityLimits(grid, nu, incomingSpeed);

  if (!limits.finite) {
    throw new SolverStabilityError(
      `cannot choose a timestep: the velocity field has ${limits.nonFiniteCells} non-finite cells`,
      { reason: "non-finite-field", nonFiniteCells: limits.nonFiniteCells }
    );
  }

  const viscous = safety * limits.viscous;
  const convective = safety * limits.convective;

  let dt = Math.min(viscous, convective);
  let limitedBy = viscous <= convective ? "viscous" : "convective";

  if (dt > maxTimestep) {
    dt = maxTimestep;
    limitedBy = "maxTimestep";
  }
  if (previousTimestep !== null && dt > previousTimestep * growthLimit) {
    dt = previousTimestep * growthLimit;
    limitedBy = "growthLimit";
  }

  return {
    dt,
    limitedBy,
    peakSpeed: limits.peakSpeed,
    limitingSpeed: limits.limitingSpeed,
    incomingSpeed,
    // The numbers a reader needs to judge the choice, not just the choice.
    cflNumber: limits.convective === Infinity ? 0 : dt / limits.convective,
    diffusionNumber: limits.viscous === Infinity ? 0 : dt / limits.viscous,
    viscousLimit: limits.viscous,
    convectiveLimit: limits.convective,
  };
}

// Rejects a timestep the current field cannot survive. Called by step() before
// it does any work.
//
// This throws rather than clamping. Clamping would mean step() silently
// advancing by something other than the dt it was asked for, which puts the
// caller's clock out of step with the solver's without saying so - the same
// class of quiet wrongness as a divergence readout of zero on a NaN field.
// A throw cannot be ignored; a returned status can be, and this project has
// already been bitten once by a status nobody looked at.
export function assertTimestepIsStable(grid, nu, dt) {
  const limits = stabilityLimits(grid, nu);
  if (!limits.finite) return limits; // already broken on entry; reported, not thrown

  if (!(dt > 0) || !Number.isFinite(dt)) {
    throw new SolverStabilityError(`timestep must be a positive finite number, got ${dt}`, {
      reason: "invalid-timestep", dt,
    });
  }
  if (dt > limits.viscous) {
    throw new SolverStabilityError(
      `timestep ${dt.toExponential(3)} exceeds the viscous stability limit ` +
      `${limits.viscous.toExponential(3)} (diffusion number ${(dt / limits.viscous).toFixed(3)}, ` +
      `must be below 1). Reduce dt, coarsen the grid, or lower the viscosity.`,
      { reason: "viscous", dt, limit: limits.viscous, ratio: dt / limits.viscous }
    );
  }
  if (dt > limits.convective) {
    throw new SolverStabilityError(
      `timestep ${dt.toExponential(3)} exceeds the convective (CFL) stability limit ` +
      `${limits.convective.toExponential(3)} at a peak speed of ${limits.peakSpeed.toExponential(3)} ` +
      `(CFL ${(dt / limits.convective).toFixed(3)}, must be below 1). The flow has accelerated ` +
      `beyond what this fixed timestep allows - use computeStableTimestep to adapt it.`,
      { reason: "convective", dt, limit: limits.convective, ratio: dt / limits.convective,
        peakSpeed: limits.peakSpeed }
    );
  }
  return limits;
}
