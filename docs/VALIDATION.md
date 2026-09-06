# Validation record

**This file is generated. Do not edit it by hand — run `npm run validate`.**

Every number below was measured by running the solver through the same harnesses the test suite uses (`validation/measure.js`), and compared against references declared in `validation/registry.js`. A hand-maintained validation record can drift from the code while still reading as authority, which is the one failure mode a document like this must not have.

Generated 2026-09-06 17:20:32 UTC.

## How to read this

**Classification** — what a case's agreement actually establishes:

- `benchmarked` — checked against a reference external to this project, so being wrong is detectable from outside
- `self-validated` — checked against exact invariants and its own grid convergence; nothing external says the answer is right
- `demonstration` — neither — runs and looks plausible

The distinction carries real weight. A cavity agreeing with published measurements and a bend separating where physical reasoning says it should are not the same kind of claim, and presenting them identically would mislead by omission.

**Every number below describes that case's own geometry.** The harness can now draw into a domain, and a measurement made on one domain says nothing about another. When the geometry on screen differs from the scenario's own, the panel withdraws these numbers rather than annotating them. What still holds on any domain the solver accepts are its own invariants — divergence, flux balance, finiteness — which the harness reports live.

**A number here is about the flow the solver computed, not about how realistic the configuration is.** M6 added sources that inject momentum or mass into the interior. A source delivers exactly what it is asked for and the projection still meets its bound around one — both measured below — but nothing here says a source resembles a pump, a nozzle or a hand in water. It is a boundary condition applied in the middle of the domain.

**Reference verification** — how far the reference itself can be trusted:

- `derived` — reproducible from the equations
- `verified` — cross-referenced against an independent source
- `unverified` — **recalled, not checked**

## Summary

| case | classification | reference | verification |
|---|---|---|---|
| Still water | `self-validated` | invariants only | — |
| Uniform channel flow | `self-validated` | invariants only | — |
| Viscous diffusion | `benchmarked` | analyticalDiffusion | `derived` |
| Lid-driven cavity | `benchmarked` | ghia1982 | `verified` |
| Flow past a circular cylinder | `benchmarked` | cylinderWakeLength | `unverified` |
| 90-degree channel bend | `self-validated` | planePoiseuille | `derived` |
| Pressure-driven channel | `benchmarked` | planePoiseuille | `derived` |
| Drawn geometry and surface conditions | `self-validated` | invariants only | — |
| Interior sources | `self-validated` | invariants only | — |

## Still water

**Classification:** `self-validated` — checked against exact invariants and its own grid convergence; nothing external says the answer is right

**Asserted by:** `tests/test1_still_water.js`

u = 0 is an exact fixed point of the discretised equations, so this is an invariant rather than a comparison. It cannot be close - it is either exact or the solver is manufacturing motion from nothing.

| quantity | reference | measured | tolerance | result |
|---|---|---|---|---|
| max\|u\| after 50 steps | 0 | 0 | 1.000e-10 | pass |
| max\|div u\| | 0 | 0 | 1.000e-10 | pass |

## Uniform channel flow

**Classification:** `self-validated` — checked against exact invariants and its own grid convergence; nothing external says the answer is right

**Asserted by:** `tests/test2_channel_flow.js`

A uniform plug flow with no-penetration, zero-gradient walls is another exact fixed point. Isolates whether the projection preserves a trivial solution.

| quantity | reference | measured | tolerance | result |
|---|---|---|---|---|
| max\|u - U0\| | 0 | 0 | 1.000e-6 | pass |
| max\|div u\| | 0 | 0 | 1.000e-6 | pass |

## Viscous diffusion

**Classification:** `benchmarked` — checked against a reference external to this project, so being wrong is detectable from outside

**Asserted by:** `tests/test3_viscous_diffusion.js`

Compared against exact closed-form solutions. The construction makes the nonlinear and pressure terms vanish identically, which the test verifies by requiring v and divergence to stay at exactly zero, so this isolates the diffusion term alone.

**Reference:** Closed-form solutions of the 1D heat equation: the decaying mode u = U0*cos(k*y)*exp(-nu*k^2*t) and the spreading error-function layer u = (U0/2)(1 + erf((y-y0)/(2*sqrt(nu*t)))).

**Verification:** reproducible from the equations

> Reproducible from the governing equations. For a unidirectional flow the nonlinear and pressure terms vanish identically, so the momentum equation collapses onto the heat equation exactly - the tests assert that collapse rather than assuming it.

| quantity | reference | measured | tolerance | result |
|---|---|---|---|---|
| decay rate vs nu*k^2 (relative) | 0 | 7.635e-4 | 1.000e-3 | pass |
| spatial convergence order | 2 | 2.05348 | 0.3 | pass |
| spreading-layer profile error | 0 | 4.962e-5 | 2.000e-4 | pass |

## Lid-driven cavity

**Classification:** `benchmarked` — checked against a reference external to this project, so being wrong is detectable from outside

**Asserted by:** `tests/test4_lid_driven_cavity.js`

The standard 2D incompressible benchmark and the go/no-go gate for this solver. The first case where advection and pressure are both live.

**Reference:** Ghia, U., Ghia, K. N., & Shin, C. T. (1982). High-Re solutions for incompressible flow using the Navier-Stokes equations and a multigrid method. Journal of Computational Physics, 48(3), 387-411.

**Verification:** cross-referenced against an independent source

> Cross-referenced against an independent public transcription, one source per table. The check found one wrong digit in the previous recalled transcription (Re=1000, x=0.9063: -0.51550 against a true -0.51500) which was setting the reported Re=1000 error. One published point is excluded as unreliable - see tests/support/ghia.js EXCLUDED_POINTS.

| quantity | reference | measured | tolerance | result |
|---|---|---|---|---|
| max\|u - Ghia\| at Re=100 | 0 | 3.802e-3 | 0.015 | pass |
| max\|v - Ghia\| at Re=100 | 0 | 8.545e-3 | 0.015 | pass |
| max\|u - Ghia\| at Re=400 | 0 | 7.334e-3 | 0.015 | pass |
| max\|u - Ghia\| at Re=1000 | 0 | 0.0179 | 0.035 | pass |
| self-convergence order | 2 | 1.90538 | 0.3 | pass |

Also measured, not asserted:

- primary vortex centre offset at Re=100: 7.788e-3 (solver (0.6172, 0.7422) vs Ghia (0.6172, 0.7344))

## Flow past a circular cylinder

**Classification:** `benchmarked` — checked against a reference external to this project, so being wrong is detectable from outside

**Asserted by:** `tests/test5_flow_around_obstacle.js`

Wake length compared against published values for an unbounded cylinder, which requires accounting for channel blockage: the measured length rises monotonically toward the published figure as the channel widens. The structural invariants (exact zero velocity on the body, flux conserved through every cut, a symmetric answer to a symmetric problem) hold to roundoff and are what the case mostly rests on.

**Reference:** Steady recirculation length behind a circular cylinder in unbounded flow, L/D ~ 0.93 at Re=20 and ~2.3 at Re=40. Usually attributed to Coutanceau & Bouard (1977), J. Fluid Mech. 79(2), 231-256, and to Tritton (1959), J. Fluid Mech. 6, 547-567.

**Verification:** **recalled, not checked**

> THE NUMBERS ARE STILL RECALLED, NOT CHECKED. A partial check has since confirmed the citation but not the values. Coutanceau & Bouard (1977), J. Fluid Mech. 79, is a real paper, correctly attributed here, and is the standard experimental benchmark that numerical work compares against for cylinder wake length at Re < 40 - so the attribution is sound. What could not be obtained is the part this project actually depends on: the figures L/D ~ 0.93 at Re=20 and ~2.3 at Re=40 still come from recall, not from any source that could be checked. That is why this stays `unverified` rather than being upgraded on the strength of the citation. Published values also differ by a few percent between sources (2.24 to 2.35 at Re=40 is commonly quoted), which is part of why the test asserts a band rather than a point. This remains the weakest reference in the project.

> ⚠️ **Caveat.** The reference VALUES behind this case are UNVERIFIED. The citation has been confirmed as real, correctly attributed and the standard source for this measurement, but the specific numbers attributed to it have not been checked against it. The agreement is also indirect - it is a trend toward the published number under reducing blockage, not a direct match at a stated condition.

| quantity | reference | measured | tolerance | result |
|---|---|---|---|---|
| wake L/D at Re=20, 6% blockage | 0.93 | 1.03318<br><sub>published unbounded value 0.93</sub> | 15% relative | pass |
| separation onset below Re~5 | 0 | 0<br><sub>0 = attached at Re=1, as expected</sub> | 0 | pass |
| velocity on the body surface | 0 | 0 | 0 | pass |
| flux deviation through all cuts (relative) | 0 | 2.527e-10 | 1.000e-7 | pass |
| centreline asymmetry | 0 | 5.388e-11 | 1.000e-9 | pass |

## 90-degree channel bend

**Classification:** `self-validated` — checked against exact invariants and its own grid convergence; nothing external says the answer is right

**Asserted by:** `tests/test6_channel_bend.js`

There is no published reference for this geometry, so the bend's own behaviour - separation off the sharp inner corner, suppression when the corner is radiused, flow thrown toward the outer wall, higher pressure on the outer wall - is checked against physical reasoning and exact invariants, not against measurements. What IS benchmarked is the inlet leg, which carries fully developed plane Poiseuille flow with a closed-form profile and pressure gradient. That analytical anchor inside the same geometry is what makes the bend numbers worth believing.

**Reference:** Plane Poiseuille flow: for a channel of width w with mean velocity U, u(y) = 1.5*U*(1 - (2(y-yc)/w)^2) and dp/dx = -12*mu*U/w^2.

**Verification:** reproducible from the equations

> Standard closed-form result, reproducible from the equations.

> ⚠️ **Caveat.** The bend results themselves are NOT benchmarked. No external source says the separation bubble should be 1.555w at Re=200; it is reported because the solver is trusted, not the other way round.

| quantity | reference | measured | tolerance | result |
|---|---|---|---|---|
| inlet-leg dp/dx vs -12*mu*U/w^2 (relative) | 0 | 7.792e-3 | 0.02 | pass |
| inlet-leg profile convergence order | 2 | 1.93237 | 0.3 | pass |
| flux deviation through all cuts (relative) | 0 | 6.906e-9 | 1.000e-6 | pass |
| velocity on the duct walls | 0 | 0 | 0 | pass |
| sharp bend separates at the inner corner | — | —<br><sub>bubble 2.768w, peak reverse 0.2214 U0</sub> | — | reported |
| radiusing suppresses the separation | — | —<br><sub>smooth bend peak reverse 0.0011 U0 against 0.2214 sharp</sub> | — | reported |

## Pressure-driven channel

**Classification:** `benchmarked` — checked against a reference external to this project, so being wrong is detectable from outside

**Asserted by:** `tests/test10_m4_boundary_conditions.js`

The M4 pressure boundary condition checked against closed form. Nothing prescribes the flow rate here: the pressure is fixed at both ends, the projection determines the velocity through them, and the steady answer must be U_mean = dp*w^2/(12*mu*L). That makes it a genuine prediction rather than a restatement of an input, which is what separates this from the velocity-inlet cases. The convergence ORDER carries more weight here than any single error figure: a wrongly implemented boundary can be accidentally close on one grid, but it does not converge at second order to the right answer. The residual is the no-slip WALL treatment rather than the pressure ends - reflecting no-slip into the ghost is exact for a linear profile and O(h^2) for a parabolic one - which is why the local dp/dx error tracks the global rate error to three digits.

**Reference:** Plane Poiseuille flow: for a channel of width w with mean velocity U, u(y) = 1.5*U*(1 - (2(y-yc)/w)^2) and dp/dx = -12*mu*U/w^2.

**Verification:** reproducible from the equations

> Standard closed-form result, reproducible from the equations.

> ⚠️ **Caveat.** The agreement is RESOLUTION-QUALIFIED. 0.195% at 32 cells across the channel and 0.781% at 16, but 1.389% at 12: a coarse channel flows measurably too freely. What is prescribed is also the projection variable, which approximates the true pressure to O(dt) and carries a known error layer near walls, so the pressure NUMBER at the boundary is not an engineering-grade static pressure even though the flow it drives is right.

| quantity | reference | measured | tolerance | result |
|---|---|---|---|---|
| U_mean vs dp*w^2/(12*mu*L) at 32 cells (relative) | 0 | 1.953e-3<br><sub>U_mean = 1.001953 against 1.000000</sub> | 0.01 | pass |
| U_mean vs dp*w^2/(12*mu*L) at 16 cells (relative) | 0 | 7.813e-3 | 0.02 | pass |
| convergence order of the flow-rate error | 2 | 2<br><sub>second order is what a correct boundary treatment gives</sub> | 0.2 | pass |
| flux deviation inlet to outlet | 0 | 9.113e-11<br><sub>the flux is an output here, so its constancy is a real check</sub> | 1.000e-8 | pass |
| flow-rate inlet delivered vs requested (relative) | 0 | 0<br><sub>asked for 0.6, delivered 0.600000000000000</sub> | 1.000e-13 | pass |

## Drawn geometry and surface conditions

**Classification:** `self-validated` — checked against exact invariants and its own grid convergence; nothing external says the answer is right

**Asserted by:** `tests/test11_m5_geometry.js`

The M5 geometry pipeline, checked against exact invariants only. Two things are established here and nothing else. First, that expressing the existing scenarios as geometry documents reproduces their masks CELL FOR CELL - the claim every other case in this record silently depends on, since a benchmark measured on one domain says nothing about another. Second, that conditions attached to drawn surfaces behave exactly like the domain-edge conditions M4 validated: a prescribed rate through a surface is delivered to roundoff, no-slip on a drawn wall is exactly zero, and the projection still delivers its divergence bound with a surface driving the flow. The last is a regression guard with history: when the flux balance counted surface outflow but not surface inflow, the rate was delivered exactly while the field carried a divergence of 5.3e-2 against a bound of 1e-7, and nothing threw.

> ⚠️ **Caveat.** Nothing here is benchmarked and nothing here validates a DRAWN domain - there is no external reference for a shape someone just drew. These are invariants that hold on any domain the solver accepts. Drawn shapes are also sampled onto the uniform grid rather than meshed, so the staircase error of about one cell applies to anything drawn.

| quantity | reference | measured | tolerance | result |
|---|---|---|---|---|
| cells differing between document and original predicate (3 scenarios) | 0 | 0<br><sub>cylinder 113 solid cells on a 168x73 grid, plus both bends over 7056 cells each</sub> | 0 | pass |
| surface flow rate delivered vs requested | 0 | 0<br><sub>asked for 0.15 through the block's upstream face, delivered 0.150000000000000</sub> | 1.000e-12 | pass |
| velocity on drawn solid surfaces | 0 | 0<br><sub>the block's other faces, which carry plain no-slip</sub> | 0 | pass |
| max\|div u\| with a surface inlet driving the flow | 0 | 9.399e-8<br><sub>after 300 steps</sub> | 1.000e-7 | pass |

## Interior sources

**Classification:** `self-validated` — checked against exact invariants and its own grid convergence; nothing external says the answer is right

**Asserted by:** `tests/test13_m6_sources.js`

The M6 source model, against exact invariants only. Three things are established. A MASS source delivers the volume it asks for: the flux leaving through the outlet equals the requested rate to twelve digits, which is a real check because nothing prescribes that flux - the projection determines it. A MOMENTUM source cannot carry a face past its target, which is what makes the timestep sizeable against it and is checked at relaxation times from far below the timestep to far above it. And the solver still delivers its continuity bound with a source driving the flow - measured against what the sources ask for, max |div u - q|, because with a mass source running max|div u| is q by design and reads 1.8 where the bound is 1e-7.

> ⚠️ **Caveat.** Nothing here is benchmarked and nothing here validates a source's PHYSICAL realism - a source is a boundary condition applied in the interior, not a model of a pump or a nozzle, and no external reference says what one should do. These are invariants. The brush's speed is a control rather than a measurement of hand motion, for the reason given in docs/M6-sources.md: pointer time is wall-clock and fluid time is simulated, so any mapping between them is invented.

| quantity | reference | measured | tolerance | result |
|---|---|---|---|---|
| mass source: flux delivered vs requested | 0 | 6.939e-18<br><sub>asked for 0.05, the outlet carried 0.050000000000</sub> | 1.000e-11 | pass |
| continuity error with a source driving the flow | 0 | 8.570e-8<br><sub>max\|div u - q\|; the raw max\|div u\| is 1.800e+0, which is the divergence the source imposes on purpose</sub> | 1.000e-7 | pass |
| momentum source: overshoot past its target in one step | 0 | 0<br><sub>relaxation times from 1e-9 to 10 against a timestep of 4.167e-3</sub> | 0 | pass |
| golden fields moved by compiling the source path in | 0 | 0<br><sub>13 cases, asserted byte-identical in tests/test13_m6_sources.js</sub> | 0 | pass |

## Known limitations

Carried forward from `docs/M1-solver-hardening.md`, which has the detail:

- Symmetry costs convergence under the CG pressure solve; it was structurally free under SOR.
- No upwinding: cell Reynolds numbers above ~2 are outside formal validity.
- A CFL-respecting timestep is not sufficient near a geometric singularity.
- Obstacles are staircase-resolved to about one cell.
- The explicit viscous limit scales as h², so refinement gets expensive quickly.
- The first step of a run from rest is taken outside the stability limit the driver believes it is enforcing: dt is sized from the field before the step, which is motionless, so the viscous limit sets it and the flow that exists afterwards is moving. Measured at an effective convective CFL near 5 on the sharp bend. It survives — dt drops by 13x on the next step and no validation case is affected — and is recorded rather than fixed. See `docs/M3-visualization.md` §2.

From `docs/M3-visualization.md`, and bearing on what this document does NOT cover: the dye tracer added in M3 is a visualization aid, not a result. No case below validates it, nothing external says a dye pattern is right, and the harness labels it accordingly. The pressure view shows the first-order Chorin projection pressure, which is not the true pressure near walls.

From `docs/M4-boundary-conditions.md`: the outlet condition is zero-gradient with a per-region flux rescale, which reflects vortices back into the domain - adequate for the steady cases validated here, and a real limitation for unsteady wakes. A convective outflow was deferred rather than adopted, because changing it would perturb the cylinder benchmark.

From `docs/M6-sources.md`: with a mass source running the flow is non-solenoidal ON PURPOSE at the cells it covers, so `max|div u|` there is q by design and the quantity that says whether the projection is working is the CONTINUITY ERROR, `max|div u - q|`. The two are the same number whenever no mass source is active, which is every case below. A momentum source cannot carry a face past its target in one step, which is what lets the timestep be sized against it; a boundary inlet has no such bound, so the first step of an impulsively started scenario is still taken outside the limit the driver believes it is enforcing - measured at CFL 5.145 on the sharp bend, and left recorded rather than fixed.

From `docs/M5-interactive-geometry.md`: drawn shapes are SAMPLED onto the existing uniform grid - cell centres tested against a region - not meshed, so the staircase limitation above applies to anything drawn as much as to the cylinder. Solid surfaces can now carry the full condition set where they are axis-aligned; on a staircase surface, which has no single normal, only wall and free-slip are allowed and a flux-prescribing condition is refused rather than approximated. A domain whose fluid splits into regions is solved when every region's flux can be absorbed and REJECTED WITH A REASON when it cannot, rather than reported as converged; the pre-M5 solver reported 8.1e-8 for a field whose actual max|div u| was 2.950e-1 in one such case. The outer domain stays a rectangle and per-region pressure solving is deferred.

**1 reference is still unverified** (cylinderWakeLength). Any claim resting on it is weaker than the rest of this document, and should be read that way. Each one records what closing it would take, so it stays a piece of open work rather than a permanent disclaimer:

- **cylinderWakeLength** — The 1977 paper is paywalled and its table could not be reached from any openly available source. Closing this needs either institutional or library access to the original, or a secondary paper that digitises and reproduces those exact figures. Recorded as a known limitation and left open deliberately, not pursued further.
