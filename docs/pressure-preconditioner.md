# Pressure solve: MIC(0)-preconditioned CG

A solver change handled as its own unit, as agreed: the approach proposed first,
a baseline captured before touching anything, then the implementation, a full
re-validation claim by claim, and a stop if any claim did not hold.

**Status: built, tested, re-validated, and NOT enabled.** Every validation
claim, experiment verdict and per-step bound holds under it except one M6 test
claim (section 3), which needs the owner's decision. Until then `step()`
defaults to plain CG exactly as before, and nothing in the app's numbers has
changed. Enabling it is one line (`pressureSolver = "mic-pcg"` in `step()`).

## 1. What changed, and what did not

- **The same equations.** The operator (fluid-cell Laplacian, Neumann faces
  dropped, Dirichlet faces folded into the diagonal), the right-hand side and
  the warm start are all unchanged.
- **The same stopping test**, on the true residual max|b − Ap| against the same
  bound. `step()`'s continuity check is untouched.
- **Only the path to the answer changes**: CG preconditioned with MIC(0), the
  modified incomplete Cholesky factor of the same operator, in the solver's own
  cell order. It uses τ = 0.97 and a pivot floor σ = 0.25, so every pivot is
  positive and the preconditioner M is symmetric positive definite (tested).
- **Breakdown** falls back to plain CG, and the step reports it
  (`preconditionerFallback`).
- **The reference solve is kept**: `pressureSolver: "cg"` is the old loop,
  untouched. The original golden fields still pin it **byte for byte**
  (tests 10 and 13, 13 cases), and `tests/fixtures/golden-fields-mic-pcg.json`
  pins the new one.

## 2. Found on the way — four defects, each caught by an existing claim or a new test

1. **Per-region pressure constants.** Plain CG never excites the undetermined
   constant of a sealed region. MIC(0) does not map a constant to a constant,
   so with one global projection a two-chamber cavity's region mean pressure
   drifted to **−0.209**, and a sealed pocket that must be exactly still moved
   at **2.9e-18**. Caught by the M5 region tests.
2. **Projecting the residual per region was wrong.** The first fix projected
   the residual per region too. That strips out exactly the component an
   unsolvable region cannot lose, so the solve reported convergence while the
   field did not have it. That breaks the identity continuity error =
   (dt/ρ)·residual. Caught by the M6 split-chamber test.
   - **Fix:** the residual is projected exactly as plain CG projects it, so it
     stays the true residual. Only the preconditioner is projected per region,
     B = P M⁻¹ P, which is symmetric and positive definite on the solvable
     subspace.
   - **Test:** the new test25 checks directly that the reported continuity
     error equals the one measured from the field in that case.
3. **Rounding in the pocket.** Subtracting a computed mean from an exactly
   constant vector leaves the rounding of sum/size behind: the pocket moved at
   **2.0e-33**. A region whose values are bit-identical and finite now projects
   to exactly zero. This is not a tolerance; it only triggers on identical
   values.
4. **NaN masking, bug A's class.** The first version of that rule used NaN as
   its "not seen yet" marker, so a region full of NaN counted as constant and
   was **set to zero**. A NaN pressure was silently repaired, and the step
   reported success. Caught when the M14 worker test that injects a NaN hung,
   because nothing ever failed. "Finite" is now part of the rule, and a new
   test requires a NaN pressure to fail the step under both solvers.

## 3. The claim that does not hold — for decision

`tests/test13_m6_sources.js`, "an unsolvable mass source is refused at every
meaningful bound", runs a source in one sealed chamber and an equal sink in
the other. It requires a refusal at `divergenceTol` = 1e-7, 1e-2 **and 1**.

| bound | plain CG | MIC(0)-PCG |
|---|---|---|
| 1e-7, 1e-2 | refused | refused |
| 1 | step 1 runs (continuity error 0.81); on step 2 CG **diverges** on the inconsistent system (residual 1.94e3 after 20,000 iterations) and the divergence bound throws | every step converges below the requested bound; **true** continuity error 0.62–0.95, reported honestly (checked against the measured field); **not refused** |

**The ambiguity.** The test's own comment defines a meaningful bound as one
"tighter than the divergence the configuration forces (1.091e-1 per chamber)".
Bound 1 is looser than that. Under plain CG it was refused only because CG
diverges on a system with no solution, not by the solvability check. The next
M6 test, "at an absurd bound the continuity error is the only honest
readout", describes exactly the regime the new solver lands in. **Nothing has
been changed in the test.** The options are:

- **(a) Accept.** Bound 1 was never meaningful by the test's own definition.
  Restrict that list to bounds below the forced divergence, and add an
  assertion that at a looser bound the reported continuity error is the true
  one, at or above the forced imbalance. Then enable the new solver.
- **(b) Keep the claim as written.** Refusing at any bound would need a new
  check, for example refusing any region whose per-region residual cannot
  fall. That would be new behaviour, not a restoration, since CG only met the
  claim by diverging.
- **(c) Don't adopt the preconditioner.** It stays available by name.

## 4. Measured gain

Steps per scenario, same process, same states, median of 100 steps after 40
of warm-up (node), and of 40 after 30 (browser).

| scenario | CG iterations per step | step time, node | step time, browser |
|---|---|---|---|
| cylinder | 302 → 53 (5.7×) | 66.0 → 33.9 ms (1.95×) | 75.9 → 50.4 ms (1.51×) |
| cavity | 189 → 34 (5.5×) | 14.4 → 8.3 ms (1.74×) | 15.8 → 10.3 ms (1.53×) |
| bend-sharp | 244 → 38 (6.3×) | 9.6 → 3.7 ms (2.59×) | 9.5 → 5.8 ms (1.64×) |
| bend-smooth | 229 → 47 (4.9×) | 6.5 → 4.2 ms (1.54×) | — |
| jet | 177 → 31 (5.7×) | 5.6 → 3.8 ms (1.47×) | 6.0 → 3.7 ms (1.62×) |
| pressure-channel | ~0 (already converged) | 0.5 → 0.6 ms | — |

- **Iterations:** 4.9–6.3× fewer, above the 3–4× estimated. Each iteration
  costs more than estimated, because the two triangular sweeps are sequential
  and index through the neighbour table.
- **Step time: 1.5–2.6× in node, and 1.51–1.64× in the browser, where the app
  runs.** The browser figures sit at the 1.5× threshold proposed for stopping.
  The gain is real but modest there.
- **Experiments**, headless, full runs: sweep 143 → 60 s, cylinder 147 → 61 s,
  bends 78 → 38 s.
- **Room left:** the sweeps could be restructured (precomputed coupling
  coefficients, fewer branches) without changing a single value. That is
  optimisation of the new path, deliberately not done before this review.

## 5. Before/after, every claim

Generated by `scripts/compare-solver-baseline.js` from two runs of
`scripts/capture-solver-baseline.js`. The baseline was captured before any
solver change; the "after" run used the new solver as the default. Each claim
is judged by the criterion the project already uses for it: the registry's
tolerance, or the experiment's own verdict. The one change made to the
comparison script during the review: an averaged run is judged on the **kind**
of ending, not its sample count. The count follows the timestep history, which
unsteady shedding legitimately moves (sharp bend: 203 → 196 samples,
4,546 → 4,472 steps to the same t = 35).

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
| lid-driven-cavity | max|u - Ghia| at Re=100 | 0.00380191 | 0.00380191 | 8.8e-7 rel | pass → pass |
| lid-driven-cavity | max|v - Ghia| at Re=100 | 0.00854523 | 0.00854523 | 2.1e-8 rel | pass → pass |
| lid-driven-cavity | max|u - Ghia| at Re=400 | 0.00733363 | 0.00733363 | 2.5e-7 rel | pass → pass |
| lid-driven-cavity | max|u - Ghia| at Re=1000 | 0.0178955 | 0.0178955 | 2.2e-7 rel | pass → pass |
| lid-driven-cavity | self-convergence order | 1.90538 | 1.90538 | 2.8e-7 rel | pass → pass |
| lid-driven-cavity | primary vortex centre offset at Re=100 | 0.00778751 | 0.00778751 | identical | reported → reported |
| cylinder-wake | wake L/D at Re=20, 6% blockage | 1.03318 | 1.03318 | 1.2e-9 rel | pass → pass |
| cylinder-wake | separation onset below Re~5 | 0 | 0 | identical | pass → pass |
| cylinder-wake | velocity on the body surface | 0 | 0 | identical | pass → pass |
| cylinder-wake | flux deviation through all cuts (relative) | 2.5266e-10 | 6.3561e-11 | 7.5e-1 rel | pass → pass |
| cylinder-wake | centreline asymmetry | 5.3884e-11 | 3.6560e-10 | 8.5e-1 rel | pass → pass |
| channel-bend | inlet-leg dp/dx vs -12*mu*U/w^2 (relative) | 0.00779198 | 0.00779157 | 5.3e-5 rel | pass → pass |
| channel-bend | inlet-leg profile convergence order | 1.93237 | 1.93238 | 2.1e-6 rel | pass → pass |
| channel-bend | flux deviation through all cuts (relative) | 6.9062e-9 | 4.1974e-8 | 8.4e-1 rel | pass → pass |
| channel-bend | velocity on the duct walls | 0 | 0 | identical | pass → pass |
| channel-bend | sharp bend separates at the inner corner | — | — | same | reported → reported |
| channel-bend | radiusing suppresses the separation | — | — | same | reported → reported |
| pressure-driven-channel | U_mean vs dp*w^2/(12*mu*L) at 32 cells (relative) | 0.00195312 | 0.00195313 | 2.5e-8 rel | pass → pass |
| pressure-driven-channel | U_mean vs dp*w^2/(12*mu*L) at 16 cells (relative) | 0.00781250 | 0.00781250 | 1.4e-8 rel | pass → pass |
| pressure-driven-channel | convergence order of the flow-rate error | 2.00000 | 2.00000 | 2.8e-8 rel | pass → pass |
| pressure-driven-channel | flux deviation inlet to outlet | 9.1130e-11 | 4.0790e-13 | 1.0e+0 rel | pass → pass |
| pressure-driven-channel | flow-rate inlet delivered vs requested (relative) | 0 | 0 | identical | pass → pass |
| drawn-geometry | cells differing between document and original predicate (3 scenarios) | 0 | 0 | identical | pass → pass |
| drawn-geometry | surface flow rate delivered vs requested | 0 | 0 | identical | pass → pass |
| drawn-geometry | velocity on drawn solid surfaces | 0 | 0 | identical | pass → pass |
| drawn-geometry | max|div u| with a surface inlet driving the flow | 9.3987e-8 | 5.9188e-8 | 3.7e-1 rel | pass → pass |
| interior-sources | mass source: flux delivered vs requested | 6.9389e-18 | 0 | 1.0e+0 rel | pass → pass |
| interior-sources | continuity error with a source driving the flow | 8.5702e-8 | 7.0309e-8 | 1.8e-1 rel | pass → pass |
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
| flow-analysis | wall shear vs plane Poiseuille, order of convergence | 1.99073 | 1.99073 | 7.7e-7 rel | pass → pass |
| flow-analysis | Q in solid-body rotation, relative error | 1.0151e-15 | 1.0151e-15 | identical | pass → pass |
| flow-analysis | Q in pure shear (analytically zero) | 0 | 0 | identical | pass → pass |
| flow-analysis | fluid reported as rotating in a pure shear channel | 0 | 0 | identical | pass → pass |
| flow-analysis | staircase perimeter of a circle, ratio to the true perimeter | 1.27324 | 1.27324 | identical | pass → pass |

## Experiments (M10) — every row, before and after

| experiment | quantity | before | after | verdict before → after |
|---|---|---|---|---|
| pipe | mean velocity (flow rate / width) | 1.00334 | 1.00334 | agrees → agrees |
| pipe | worst profile error vs the parabola | 0.00172727 | 0.00172732 | agrees → agrees |
| pipe | wall shear stress | 0.299968 | 0.299968 | agrees → agrees |
| pipe | run "channel, from rest to steady" ending | steady, 5222 steps | steady, 5225 steps | same kind |
| pipe | summary sentence | | | identical |
| cylinder | L/D at Re 20 | 0.749567 | 0.749567 | comparison only → comparison only |
| cylinder | L/D at Re 40 | 1.74450 | 1.74450 | comparison only → comparison only |
| cylinder | growth L(40)/L(20) | 2.32735 | 2.32735 | comparison only → comparison only |
| cylinder | run "Re 20, to steady" ending | steady, 1368 steps | steady, 1368 steps | same kind |
| cylinder | run "Re 40, to steady" ending | steady, 1228 steps | steady, 1228 steps | same kind |
| cylinder | summary sentence | | | identical |
| bends | inlet-to-outlet pressure drop | 1.55 +/- 0.155 | 1.53 +/- 0.109 | comparison → comparison |
| bends | peak speed | 4.19 +/- 1.15 | 4.07 +/- 1.28 | comparison → comparison |
| bends | separation points on the walls | 6.34 +/- 1.22 | 6.5 +/- 1.2 | comparison → comparison |
| bends | fluid rotating (margin 10%) | 0.198 +/- 0.00818 | 0.195 +/- 0.0118 | comparison → comparison |
| bends | run "sharp (mitre) bend" ending | averaged, 203 samples, 4546 steps | averaged, 196 samples, 4472 steps | same kind |
| bends | run "smooth (radiused) bend" ending | averaged, 170 samples, 3707 steps | averaged, 170 samples, 3707 steps | same kind |
| bends | summary sentence | | | differs (numbers only — see below) |
| sweep | vortex centre at Re 100 | (0.617, 0.742) | (0.617, 0.742) | agrees → agrees |
| sweep | vortex centre at Re 400 | (0.555, 0.602) | (0.555, 0.602) | agrees → agrees |
| sweep | vortex centre at Re 1000 | (0.539, 0.570) | (0.539, 0.570) | agrees → agrees |
| sweep | run "Re 100, to steady" ending | steady, 5554 steps | steady, 5555 steps | same kind |
| sweep | run "Re 400, to steady" ending | steady, 4751 steps | steady, 4751 steps | same kind |
| sweep | run "Re 1000, to steady" ending | steady, 6700 steps | steady, 6701 steps | same kind |
| sweep | summary sentence | | | identical |

## Solver, per scenario over 400 steps

| scenario | CG iterations/step before → after | worst continuity error before → after (bound 1e-7) | field after 400 steps |
|---|---|---|---|
| bend-sharp | 245.4 → 39.3 (max 274 → 49) | 9.9946e-8 → 9.9683e-8 | differs; peak speed 5.86626 → 5.86626 (2.8e-8 rel) |
| bend-smooth | 230.1 → 46.9 (max 264 → 62) | 9.9976e-8 → 9.9842e-8 | differs; peak speed 4.77403 → 4.77403 (8.7e-8 rel) |
| cylinder | 295.8 → 50.6 (max 434 → 83) | 9.9978e-8 → 9.9979e-8 | differs; peak speed 1.42588 → 1.42588 (4.4e-9 rel) |
| cavity | 188.1 → 30.8 (max 229 → 45) | 9.9968e-8 → 9.9972e-8 | differs; peak speed 2.00000 → 2.00000 (identical) |
| pressure-channel | 0.5 → 0.6 (max 206 → 46) | 9.9779e-8 → 9.9877e-8 | differs; peak speed 0.719754 → 0.719754 (1.6e-9 rel) |
| jet | 172.5 → 29.5 (max 222 → 40) | 9.9936e-8 → 9.9879e-8 | differs; peak speed 1.43918 → 1.43918 (1.5e-10 rel) |

## Other claims

| claim | before | after |
|---|---|---|
| M11 budget closes (bend-sharp), relative | 4.8349e-16 | 3.2232e-16 |
| M11 budget closes (bend-smooth), relative | 2.5341e-16 | 6.0914e-16 |
| M11 budget closes (cylinder), relative | 4.6014e-15 | 4.6129e-15 |
| M11 budget closes (cavity), relative | 1.2581e-15 | 1.3201e-15 |
| M11 budget closes (pressure-channel), relative | 5.3013e-14 | 5.3198e-14 |
| M11 budget closes (jet), relative | 2.1327e-14 | 2.0995e-14 |
| M12 velocity depends only on nu (rel. difference at 10x density) | 8.6121e-16 | 5.7414e-16 |
| M12 air/water flux (predicted mu ratio 54.9041) | 54.9041 | 54.9041 |

**Claims that held before and do not hold after: 0.**


Reading the table:

- **Steady and analytic claims** move by 1e-9 to 9e-7 relative or not at all,
  as predicted, because both solves stop inside the same bound.
- **Round-off-level quantities** (flux deviations 1e-13 to 4e-8, centreline
  asymmetry 5e-11 → 4e-10) move by their own order of magnitude and stay far
  inside their tolerances.
- **The unsteady bends** move within their stated spread: pressure drop
  1.55 ± 0.155 → 1.53 ± 0.109; separation points 6.34 → 6.5 (spread 1.2). The
  summary now says **23%** less pressure for the smooth bend instead of 24%.
  `docs/M10-experiments.md` quotes 24%, and would be updated if the solver is
  enabled.
- **Every experiment verdict is unchanged.** The pipe experiment's three
  "agrees", the sweep's three vortex centres, and the cylinder's comparison
  rows are all the same.

## 6. Suites and tests

- **With the new solver as the default:** node 364/365 (the M6 case in
  section 3 is the only failure) and browser 44/44.
- **As committed, with the default back to CG:** both suites green.
- **`tests/test25_pressure_preconditioner.js`** (10 tests) covers:
  - the factor is finite, positive and symmetric in eight geometries (six
    scenarios, a sealed chamber, a drawn body);
  - both solves land on the same flow at a 1e-12 bound;
  - one-step differences stay within the bound at the app's tolerance;
  - per-region gauge, including a pressure-driven region beside a sealed
    pocket;
  - the reported continuity error is the true one in an unsolvable region;
  - a NaN pressure fails the step under either solver;
  - a broken preconditioner falls back to plain CG and says so;
  - the iteration reduction;
  - the new golden record.

Ten mutants were run against the new path: the finite guard, the input and
output projections of the preconditioner, a per-region residual projection,
the exact-constant rule, the pivot floor, one triangular-sweep coupling, the
fallback flag, the breakdown check, and the τ term of the factorisation. All
ten are killed. The exact-constant rule survived at first, because the only
pocket tested sat beside a pressure-driven region, where the residual
projection is off and the rule is never needed. A pocket in a domain with
inlet and outlet but no prescribed pressure now covers it.
