# M12 — Materials

The roadmap asks for *water, air, custom fluid; density and viscosity must
genuinely affect the solver.*

"Genuinely" has a precise meaning for an incompressible fluid, and the
milestone is built to that meaning rather than to "the picture changes".

## 0. What ρ and μ do, measured

The equations hold two material numbers, and they reach the flow in two
different ways:

- **ν = μ/ρ reaches the velocity.** Where the boundary speeds are prescribed,
  it is the *only* way the material reaches the velocity field. Water, and a
  fluid with water's ν at ten times its density, give the same cylinder flow
  to **8.6e-16** after 60 steps. The pressure is exactly **10×** larger (to
  1e-8). That isn't a shortcut in the solver; it is what incompressible flow
  is. The test asserts both halves.
- **ρ and μ act separately where a pressure is prescribed.** Take the
  pressure-driven channel with the same pressure difference, filled with water
  and then with air, each run until developed. The flow-rate ratio is
  **54.9041**, against μ_water/μ_air = **54.9041** (agreement to 1e-8; the
  0.35% discretisation offset from exact Poiseuille cancels in the ratio).

## 1. The physical scale

The scenarios are built in their own units: a cavity of side 1 with a lid
speed of 1. A real fluid needs a real size, so each scenario is given one,
chosen so that **water at 20 °C moving at 1 cm/s reproduces the scenario
exactly as shipped**. For example:

| scenario | size | water Re | air Re | glycerol Re | mercury |
|---|---|---|---|---|---|
| cavity | 10.0 cm side | 1000 | 66.2 | 0.90 | **refused** (cell Re 139) |
| cylinder | 1.00 cm diameter | 100 | 6.6 | 0.09 | **refused** (74) |
| bends | 2.0 cm duct | 200 | 13.2 | 0.18 | **refused** (148) |
| jet | 8.4 mm inlet | 75 | 5.0 | 0.07 | **refused** (100) |
| pressure channel | 2.0 mm | 0.020 | 0.073 | ~1e-8 | 0.117 |

The pressure channel is held at its prescribed pressure difference. Its own
fluid has ρ = 1, so water, 1000× denser at the same ν, barely moves. Air, 55×
less viscous, moves 55× faster. That is the 1/μ law, not a bug.

Property values are at 20 °C and 1 atm from standard tables (water: IAPWS;
air: dry air). A test pins water's ν to 1.004e-6 and air's to 1.516e-5.

## 2. What is refused

A fluid that would put the grid past a **cell Reynolds number** |U|h/ν of
**20** is refused with its numbers, and nothing changes: not even a reset.
The limit is taken from the finest scale anything here has been checked at.
The cavity at Re 1000 runs at a cell Re of 15.6 and is validated against Ghia
et al. The bends run at 16.7. Central-difference advection is not monotone
above 2, and what keeps it usable beyond that is only ever an empirical margin.
Past the scale where that margin was measured, the app says so instead of
drawing something plausible. Mercury, with a quarter of water's ν, is refused
in every velocity-driven scenario and allowed in the pressure channel, where
it moves slowly enough to resolve.

At the other end, glycerol is **allowed** but slow. It is 1100× more viscous
than water, so the diffusive timestep limit shrinks by the same factor
(5.5e-5 in the cavity). The test checks that the timestep the session picks is
inside that limit.

## 3. In the session and the app

- `SimulationSession.setMaterial(fluid | null)` sets ρ, and ν in the solver's
  units, from the scale above.
  - It survives `reset()` and is cleared by `load()`.
  - It and `setReynolds` exclude each other. A Reynolds number without a fluid
    is dimensionless, so each replaces the other rather than stacking a second
    viscosity.
  - For the pressure channel, the reference speed is recomputed from the 1/μ
    law, so Re and the analysis panel describe the flow that will actually
    develop.
- The **Fluid** card offers water, air, olive oil, glycerol, mercury and a
  custom ρ/μ. It shows ρ, μ, ν, the apparatus size and speed, Re, and cell Re
  against its limit. A refusal is printed in red with the reason.
  - The title reads "Lid-driven cavity (Re 1000) — Air (20 °C, 1 atm), Re 66.2".
- Found by the browser check: the custom ρ/μ inputs were never hidden, because
  the row's `display: flex` beats the `hidden` attribute. Fixed, and the check
  now asserts the inputs are hidden before "custom" is chosen.

## 4. Tests

- `tests/test22_m12_materials.js` has 11 tests:
  - the scale;
  - ν-only dependence and ρ scaling of pressure;
  - water reproducing the shipped scenario;
  - air as a different flow at its own Re;
  - the 1/μ law;
  - the viscous timestep;
  - refusals;
  - the limit against every shipped scenario;
  - bad properties;
  - lifecycle;
  - the property table.
- One browser check covers `#fluid`, `#fluidapply`, `#fluidrho` and `#fluidmu`:
  a real fluid reaching the solver, a refusal changing nothing, custom water
  reproducing Re 1000, and a return to the scenario's own fluid.

Five mutants were run: the speed unit dropped from ν, ρ not passed to the
solver, the 1/μ law replaced by 1/ν, the refusal disabled, and `setMaterial`
not clearing a Reynolds override. All five are killed. The last one survived
at first, because the material outranks a stale override, so nothing
misbehaved until the fluid was removed and Re 400 came back. The lifecycle
test now removes the fluid and checks that Re returns to 1000.
