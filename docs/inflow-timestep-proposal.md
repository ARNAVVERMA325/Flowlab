# Proposal: choose the timestep from the field the step will advect

The carried item "boundary-inflow timestep coupling" (from M6), proposed as
its own unit per the agreed sequencing, then **adopted by the owner and
implemented** (section 6). This document describes the mechanism as
measured, the change, what it fixes and what it does not, and the validation.

## 1. What actually happens, measured

A scenario that starts from rest with a boundary inlet has a field of zeros
when its first timestep is chosen. `SimulationSession.advance()` calls
`computeStableTimestep` **before** `step()` applies the boundary conditions.
The inlet's prescribed speed is therefore invisible to the choice, and the
timestep comes from the viscous limit alone. `step()` then applies the
boundary pass and advects a field whose inlet faces are already moving.

Measured with the solver's own CFL, (|u|+|v|)·dt/h at cell centres, on
today's code:

| scenario | step-1 dt | CFL of the field step 1 **advects** | CFL of the field step 1 **produces** |
|---|---|---|---|
| bend-sharp | 1.389e-1 | 0.833 (inlet face 1.667) | 5.145 |
| bend-smooth | 1.389e-1 | 0.833 (inlet face 1.667) | 3.717 |
| jet | 6.250e-2 | 0.899 (inlet face 1.798) | 1.798 |
| cylinder | 3.333e-2 | 0.400 | 0.993 |
| cavity, pressure channel | unaffected | 0.40 target met | 0.30, 0.00 |

This corrects the framing the item has carried since M6. **5.145 is the
produced field**: the speed after the pressure projection, which at the bend's
corner instantly accelerates the flow to about 2.9× the inlet speed, measured
against the timestep step 1 used. The field step 1 actually advects has a CFL
of 0.833. That is inside the hard limit of 1, but **about twice the safety
target of 0.4** the selector aims for, and the inlet face itself is at 1.67.
The explicit advection in step 1 is therefore run outside the margin the
driver believes it is enforcing, though not outside the hard limit by the
solver's own measure.

## 2. Proposed change

**Compute the stability limits on the field as `step()` will advect it**: the
current velocity with the boundary pass applied, on copies. That is the same
pass `step()` makes first, so the limit is taken on the quantity it
constrains. Nothing about the scheme changes, only the input to the timestep
choice. The grid itself is not touched, so `step()` receives exactly the
bytes it receives today and only `dt` can differ.

It would apply at every step, not only the first, because "the field the step
advects" is the definition. From step 2 on, the boundary pass mostly rewrites
tangential ghosts, which the cell-centre measure does not read. Outflow faces
it does read, so later timesteps may move slightly in scenarios with an
outlet. That will be measured, not assumed.

**Measured effect of the change** (prototype on scratch copies, not
committed):

| scenario | step-1 dt | advected CFL | produced CFL |
|---|---|---|---|
| bend-sharp | 1.389e-1 → 6.667e-2 | 0.833 → **0.400** | 5.145 → **2.470** |
| bend-smooth | 1.389e-1 → 6.667e-2 | 0.833 → **0.400** | 3.717 → **1.784** |
| jet | 6.250e-2 → 2.781e-2 | 0.899 → **0.400** | 1.798 → **0.830** |
| cylinder, cavity, pressure channel | identical | identical | identical |

## 3. What it would not fix, stated plainly

The bends' produced CFL after step 1 stays above 1 (2.47, 1.78). That is the
projection's impulsive acceleration at a sharp corner. It is not something
any timestep chosen *before* the step can bound, because it happens inside
the step. Step 2's timestep responds to it, as it does today.

Two ways to go further were considered and are **not** proposed:

- **A start-up ramp of the inlet speed.** This changes the problem being
  solved, not just the numerics. It would be a scenario-definition change
  with its own validation consequences.
- **Step rejection and retry** (redo step 1 with a smaller dt if the produced
  field exceeds the limit). This adds a retry loop and a heuristic threshold
  to every step, for a transient the next step already handles.

## 4. What would move, and how it would be checked

- **Golden fields do not move.** The fixture harness calls `step()` with a
  fixed `dt`; timestep selection lives in the session.
- **Validation tests** that run the solver with fixed timesteps do not move.
  Anything that runs through the session with adaptive timesteps may. That
  means the M10 experiments and the session-based scenarios, above all the
  unsteady bends and the jet, whose trajectories will differ from step 1 on.
- **Checking:** the pressure-preconditioner method. The baseline is the
  current capture (`scripts/capture-solver-baseline.js`, taken with the
  preconditioned solve enabled). After the change, rerun and compare every
  claim with `scripts/compare-solver-baseline.js`. The unit is done only if
  every claim holds; otherwise stop and report.
- **New tests:**
  - the advected-field CFL of step 1 equals the safety target in the three
    inflow scenarios;
  - cylinder, cavity and pressure channel take an identical first step;
  - `step()` receives byte-identical input apart from `dt`.

## 5. Recommendation

Adopt it. It is a correction to what the timestep is chosen *from*, not a new
heuristic. It brings step 1 inside the margin the selector already promises,
and it makes the jet's whole start-up inside the hard limit. It is small, and
it is fully checkable with the tooling already built.

## 6. Adopted — implemented and re-validated

`SimulationSession.advance()` now chooses each timestep from the field as
`step()` will advect it: the boundary pass is applied to copies of u and v,
and the grid `step()` receives is untouched. Measured after the change:

| scenario | step-1 dt | advected CFL | produced CFL |
|---|---|---|---|
| bend-sharp | 6.667e-2 | **0.400** | 2.470 |
| bend-smooth | 6.667e-2 | **0.400** | 1.784 |
| jet | 2.781e-2 | **0.400** | 0.830 |
| cylinder, cavity, pressure channel | unchanged | unchanged | unchanged |

**Every claim holds.** The full before/after comparison follows. The baseline
is the capture taken with the preconditioned solve, which today's code
reproduces byte for byte.

- The validation registry is **identical, value for value**: its measurements
  run with fixed timesteps.
- The cylinder, cavity and pressure channel are **byte-identical** after 400
  steps. The later-step effect section 2 allowed for, outflow faces changing
  the choice, did not occur.
- Only the bends and the jet move. They are the three inflow scenarios
  started from rest, and their trajectories differ from step 1 on. The bends'
  averages stay inside their spread: pressure drop 1.53 → 1.54, separation
  points 6.5 → 6.2, and the smooth bend needs 24% less pressure (23% before).
  The jet's peak speed after 400 steps moved by 7e-5 relative.

Tests, in `tests/test26_inflow_timestep.js`:

- step 1 of the three inflow scenarios advects at exactly the safety target;
- every step of every scenario advects inside it;
- the session's step equals a direct `step()` on the same state with the
  same dt, byte for byte, so the grid really is untouched;
- the other scenarios take exactly the first step they always did;
- a NaN on a fluid face is still refused.

While writing the last one: a NaN placed on a face *inside* a solid body is
overwritten by the boundary pass and never refused. That was verified to be
the old behaviour too; such a face carries no velocity at all.

## Validation registry — every claim, before and after

| case | quantity | before | after | change | verdict before → after |
|---|---|---|---|---|---|
| still-water | max|u| after 50 steps | 0 | 0 | identical | pass → pass |
| still-water | max|div u| | 0 | 0 | identical | pass → pass |
| uniform-channel | max|u - U0| | 0 | 0 | identical | pass → pass |
| uniform-channel | max|div u| | 0 | 0 | identical | pass → pass |
| viscous-diffusion | decay rate vs nu*k^2 (relative) | 7.6352e-4 | 7.6352e-4 | identical | pass → pass |
| viscous-diffusion | spatial convergence order | 2.05348 | 2.05348 | identical | pass → pass |
| viscous-diffusion | spreading-layer profile error | 4.9617e-5 | 4.9617e-5 | identical | pass → pass |
| lid-driven-cavity | max|u - Ghia| at Re=100 | 0.00380191 | 0.00380191 | identical | pass → pass |
| lid-driven-cavity | max|v - Ghia| at Re=100 | 0.00854523 | 0.00854523 | identical | pass → pass |
| lid-driven-cavity | max|u - Ghia| at Re=400 | 0.00733363 | 0.00733363 | identical | pass → pass |
| lid-driven-cavity | max|u - Ghia| at Re=1000 | 0.0178955 | 0.0178955 | identical | pass → pass |
| lid-driven-cavity | self-convergence order | 1.90538 | 1.90538 | identical | pass → pass |
| lid-driven-cavity | primary vortex centre offset at Re=100 | 0.00778751 | 0.00778751 | identical | reported → reported |
| cylinder-wake | wake L/D at Re=20, 6% blockage | 1.03318 | 1.03318 | identical | pass → pass |
| cylinder-wake | separation onset below Re~5 | 0 | 0 | identical | pass → pass |
| cylinder-wake | velocity on the body surface | 0 | 0 | identical | pass → pass |
| cylinder-wake | flux deviation through all cuts (relative) | 6.3561e-11 | 6.3561e-11 | identical | pass → pass |
| cylinder-wake | centreline asymmetry | 3.6560e-10 | 3.6560e-10 | identical | pass → pass |
| channel-bend | inlet-leg dp/dx vs -12*mu*U/w^2 (relative) | 0.00779157 | 0.00779157 | identical | pass → pass |
| channel-bend | inlet-leg profile convergence order | 1.93238 | 1.93238 | identical | pass → pass |
| channel-bend | flux deviation through all cuts (relative) | 4.1974e-8 | 4.1974e-8 | identical | pass → pass |
| channel-bend | velocity on the duct walls | 0 | 0 | identical | pass → pass |
| channel-bend | sharp bend separates at the inner corner | — | — | same | reported → reported |
| channel-bend | radiusing suppresses the separation | — | — | same | reported → reported |
| pressure-driven-channel | U_mean vs dp*w^2/(12*mu*L) at 32 cells (relative) | 0.00195313 | 0.00195313 | identical | pass → pass |
| pressure-driven-channel | U_mean vs dp*w^2/(12*mu*L) at 16 cells (relative) | 0.00781250 | 0.00781250 | identical | pass → pass |
| pressure-driven-channel | convergence order of the flow-rate error | 2.00000 | 2.00000 | identical | pass → pass |
| pressure-driven-channel | flux deviation inlet to outlet | 4.0790e-13 | 4.0790e-13 | identical | pass → pass |
| pressure-driven-channel | flow-rate inlet delivered vs requested (relative) | 0 | 0 | identical | pass → pass |
| drawn-geometry | cells differing between document and original predicate (3 scenarios) | 0 | 0 | identical | pass → pass |
| drawn-geometry | surface flow rate delivered vs requested | 0 | 0 | identical | pass → pass |
| drawn-geometry | velocity on drawn solid surfaces | 0 | 0 | identical | pass → pass |
| drawn-geometry | max|div u| with a surface inlet driving the flow | 5.9188e-8 | 5.9188e-8 | identical | pass → pass |
| interior-sources | mass source: flux delivered vs requested | 0 | 0 | identical | pass → pass |
| interior-sources | continuity error with a source driving the flow | 7.0309e-8 | 7.0309e-8 | identical | pass → pass |
| interior-sources | momentum source: overshoot past its target in one step | 0 | 0 | identical | pass → pass |
| interior-sources | golden fields moved by compiling the source path in | 0 | 0 | identical | pass → pass |
| probe-quantities | vorticity at a node, order of convergence (Taylor-Green) | 1.99870 | 1.99870 | identical | pass → pass |
| probe-quantities | vorticity at a cell centre, order of convergence (Taylor-Green) | 1.96239 | 1.96239 | identical | pass → pass |
| probe-quantities | vorticity in solid-body rotation, exact | 1.7764e-15 | 1.7764e-15 | identical | pass → pass |
| probe-quantities | velocity at a cell vs its own faces, linear field | 0 | 0 | identical | pass → pass |
| flow-curves | interpolation error on a linear field | 4.4409e-16 | 4.4409e-16 | identical | pass → pass |
| flow-curves | streamline radius drift in solid-body rotation, 900 steps | 3.5121e-4 | 3.5121e-4 | identical | pass → pass |
| flow-curves | pathline radius drift in the same field | 1.2800e-8 | 1.2800e-8 | identical | pass → pass |
| flow-curves | streamline points outside the fluid, all scenarios | 0 | 0 | identical | pass → pass |
| flow-analysis | wall shear vs plane Poiseuille, order of convergence | 1.99073 | 1.99073 | identical | pass → pass |
| flow-analysis | Q in solid-body rotation, relative error | 1.0151e-15 | 1.0151e-15 | identical | pass → pass |
| flow-analysis | Q in pure shear (analytically zero) | 0 | 0 | identical | pass → pass |
| flow-analysis | fluid reported as rotating in a pure shear channel | 0 | 0 | identical | pass → pass |
| flow-analysis | staircase perimeter of a circle, ratio to the true perimeter | 1.27324 | 1.27324 | identical | pass → pass |

## Experiments (M10) — every row, before and after

| experiment | quantity | before | after | verdict before → after |
|---|---|---|---|---|
| pipe | mean velocity (flow rate / width) | 1.00334 | 1.00334 | agrees → agrees |
| pipe | worst profile error vs the parabola | 0.00172732 | 0.00172732 | agrees → agrees |
| pipe | wall shear stress | 0.299968 | 0.299968 | agrees → agrees |
| pipe | run "channel, from rest to steady" ending | steady, 5225 steps | steady, 5225 steps | same kind |
| pipe | summary sentence | | | identical |
| cylinder | L/D at Re 20 | 0.749567 | 0.749567 | comparison only → comparison only |
| cylinder | L/D at Re 40 | 1.74450 | 1.74450 | comparison only → comparison only |
| cylinder | growth L(40)/L(20) | 2.32735 | 2.32735 | comparison only → comparison only |
| cylinder | run "Re 20, to steady" ending | steady, 1368 steps | steady, 1368 steps | same kind |
| cylinder | run "Re 40, to steady" ending | steady, 1228 steps | steady, 1228 steps | same kind |
| cylinder | summary sentence | | | identical |
| bends | inlet-to-outlet pressure drop | 1.53 +/- 0.109 | 1.54 +/- 0.125 | comparison → comparison |
| bends | peak speed | 4.07 +/- 1.28 | 4.15 +/- 1.22 | comparison → comparison |
| bends | separation points on the walls | 6.5 +/- 1.2 | 6.17 +/- 1.18 | comparison → comparison |
| bends | fluid rotating (margin 10%) | 0.195 +/- 0.0118 | 0.196 +/- 0.0115 | comparison → comparison |
| bends | run "sharp (mitre) bend" ending | averaged, 196 samples, 4472 steps | averaged, 201 samples, 4534 steps | same kind |
| bends | run "smooth (radiused) bend" ending | averaged, 170 samples, 3707 steps | averaged, 170 samples, 3715 steps | same kind |
| bends | summary sentence | | | differs (numbers only — see below) |
| sweep | vortex centre at Re 100 | (0.617, 0.742) | (0.617, 0.742) | agrees → agrees |
| sweep | vortex centre at Re 400 | (0.555, 0.602) | (0.555, 0.602) | agrees → agrees |
| sweep | vortex centre at Re 1000 | (0.539, 0.570) | (0.539, 0.570) | agrees → agrees |
| sweep | run "Re 100, to steady" ending | steady, 5555 steps | steady, 5555 steps | same kind |
| sweep | run "Re 400, to steady" ending | steady, 4751 steps | steady, 4751 steps | same kind |
| sweep | run "Re 1000, to steady" ending | steady, 6701 steps | steady, 6701 steps | same kind |
| sweep | summary sentence | | | identical |

## Solver, per scenario over 400 steps

| scenario | CG iterations/step before → after | worst continuity error before → after (bound 1e-7) | field after 400 steps |
|---|---|---|---|
| bend-sharp | 39.3 → 39.3 (max 49 → 49) | 9.9683e-8 → 9.9683e-8 | differs; peak speed 5.86626 → 5.86626 (4.5e-10 rel) |
| bend-smooth | 46.9 → 46.9 (max 62 → 60) | 9.9842e-8 → 9.9842e-8 | differs; peak speed 4.77403 → 4.77403 (1.4e-9 rel) |
| cylinder | 50.6 → 50.6 (max 83 → 83) | 9.9979e-8 → 9.9979e-8 | byte-identical |
| cavity | 30.8 → 30.8 (max 45 → 45) | 9.9972e-8 → 9.9972e-8 | byte-identical |
| pressure-channel | 0.6 → 0.6 (max 46 → 46) | 9.9877e-8 → 9.9877e-8 | byte-identical |
| jet | 29.5 → 29.6 (max 40 → 40) | 9.9879e-8 → 9.9994e-8 | differs; peak speed 1.43918 → 1.43928 (7.0e-5 rel) |

## Other claims

| claim | before | after |
|---|---|---|
| M11 budget closes (bend-sharp), relative | 3.2232e-16 | 3.2232e-16 |
| M11 budget closes (bend-smooth), relative | 6.0914e-16 | 3.0457e-16 |
| M11 budget closes (cylinder), relative | 4.6129e-15 | 4.6129e-15 |
| M11 budget closes (cavity), relative | 1.3201e-15 | 1.3201e-15 |
| M11 budget closes (pressure-channel), relative | 5.3198e-14 | 5.3198e-14 |
| M11 budget closes (jet), relative | 2.0995e-14 | 2.0148e-14 |
| M12 velocity depends only on nu (rel. difference at 10x density) | 5.7414e-16 | 5.7414e-16 |
| M12 air/water flux (predicted mu ratio 54.9041) | 54.9041 | 54.9041 |

**Claims that held before and do not hold after: 0.**

Three mutants were run: dropping the boundary pass from the copies, choosing
from the raw grid again, and applying the pass to the real grid instead of a
copy. All three are killed, the last by the byte-identity test.
