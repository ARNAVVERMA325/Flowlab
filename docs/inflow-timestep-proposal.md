# Proposal: choose the timestep from the field the step will advect

The carried item "boundary-inflow timestep coupling" (from M6), proposed as
its own unit per the agreed sequencing. **Nothing has been changed.** This
document describes the mechanism as measured, the proposed change, what it
would and would not fix, and how it would be validated.

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
