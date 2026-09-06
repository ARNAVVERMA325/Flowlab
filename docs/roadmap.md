# ROADMAP.md — FlowLab

This is the **actionable** document. `VISION.md` describes where this is going; this
describes what to build, in what order, and how to know each step actually worked.

Three layers: **NOW**, **NEXT**, **VISION**. Only NOW is scheduled.

---

## Working agreement for Claude Code

Read this before starting any implementation session.

1. **One milestone per session.** Do not implement ahead. Do not scaffold future
   milestones "while we're here."
2. **Inspect before writing.** Read the existing architecture first, explain the proposed
   change, then implement the smallest complete version of it.
3. **Every milestone ends with a test and a physical sanity check**, not just code that runs.
4. **Do not rewrite working systems** unless the milestone requires it.
5. **Do not implement anything from `docs/references/*.png`** unless the current milestone
   explicitly calls for it.
6. **No unnecessary dependencies.** Especially not in M0–M2.
7. **Document the numerical method chosen and why** — stability, accuracy, implementation
   cost, and room to expand. Do not pick a method because it is popular.
8. **Any feature that can add or remove volume, flux, mass or momentum anywhere in the
   domain must be checked against EVERY existing balance and conservation filter** — not
   only the ones that look related.

   This has now bitten six times, always in the same shape: a sum or a check filters on a
   *proxy* for the property it cares about, the proxy and the property coincide when the
   code is written, and a later feature separates them. The sum then keeps returning a
   healthy-looking number for a field that is wrong.

   | # | the filter used | the property actually meant | what broke it |
   |---|---|---|---|
   | 1 | `type === "outflow"` | does this face carry flux | opposed outlets — reported 8.115e-8 against an actual 2.950e-1 |
   | 2 | domain sides only | does this boundary take part in the balance | an all-zero-gradient domain — reported 9.889e-8 against 1.206e-2 |
   | 3 | domain sides only | which faces carry inflow | M5 surface inlets — delivered 0.15 exactly while producing div 5.3e-2 |
   | 4 | domain edges only | is anything entering this region | a region fed by a surface pressure reported "sealed" |
   | 5 | `!solid[...]` | can this face carry flow | the tracer skipped drawn outlets — dye +70.4% over 400 steps |
   | 6 | boundary faces only | does this region gain or lose volume | M6 interior mass sources — a legitimate source with an outlet was rejected |

   The general defence, when one exists, is a check that measures the CONSEQUENCE rather
   than auditing the causes — `assertRegionsAreSolvable` is that for the pressure equation,
   and it caught instances 1, 2 and 3 at once. Where no such check exists, the question has
   to be asked deliberately during the milestone rather than discovered afterwards.

### Directory separation

Exact structure is flexible, but keep equivalent separation of concerns:

```
/solver          numerical engine — no UI imports, ever
/geometry        domain, grid, masks, boundary definitions
/physics         fluid properties, derived quantities (Re, vorticity, divergence)
/visualization   rendering of fields; consumes solver output, never mutates it
/ui              controls, panels, interaction
/tests           unit tests + benchmark validation cases
/docs            VISION.md, ROADMAP.md, references/
```

---

# NOW — Build

## M0 — Numerical proof

**The entire first push. Nothing else matters until this passes.**

Scope:
- Fixed rectangular grid. No drawing tools.
- 2D incompressible Navier–Stokes solver.
- Minimal UI: `[Run] [Pause] [Reset]` plus raw readouts of ν, ρ, Δt, grid size, iteration.
- Crude visualization only — enough to see the field, nothing more.

Explicitly **out of scope for M0**: geometry editor, polished UI, turbulence models, 3D,
probes, engineering analysis, export, GPU.

**Governing equations**

```
Continuity:   ∇ · u = 0
Momentum:     ρ(∂u/∂t + u·∇u) = −∇p + μ∇²u + f
```

**Success criterion**

> Can we numerically solve a simple 2D incompressible Navier–Stokes problem and show the
> result agrees with known physical or benchmark behaviour?

### M0 test progression

Each test is a checkpoint. Do not move on until the current one passes.

**Test 1 — Still water**
Initialize `u = 0`. It must stay zero. Looks trivial; it is the fastest way to catch a
solver that manufactures numerical garbage out of nothing.

**Test 2 — Constant channel flow**
Uniform velocity through a rectangular channel. Check it remains stable and sensible, and
that divergence stays near zero.

**Test 3 — Viscous diffusion**
Give part of the field a velocity and watch it spread. Isolates and tests the `μ∇²u` term.
Compare the spreading rate against the analytical diffusion solution.

**Test 4 — Lid-driven cavity  ← the real go/no-go gate**
Top wall moves, other three walls no-slip. This is the standard CFD benchmark; published
reference velocity profiles exist for comparison at several Reynolds numbers.

If the centreline velocity profiles are reasonably close to reference results, this is a
real solver. If not, it is an animation — and nothing further should be built on it.

**Test 5 — Flow around an obstacle**
Fixed circular obstacle in the channel. First point where results get visually
interesting: acceleration around the body, pressure difference, wake, vorticity, possible
recirculation.

**Test 6 — Bend**
90° channel bend. Observe velocity redistribution, pressure variation, separation and
recirculation at the corner. Compare sharp vs. smooth bend. This is where the original
project idea starts paying off — on a validated base.

## M1 — Solver hardening

Stability across a wider parameter range. Timestep/CFL handling. Divergence control.
Clear failure behaviour instead of silent blow-up. Documented method and limitations.

## M2 — Validation

Turn the M0 tests into a real, repeatable test suite. Record benchmark comparisons in
`/docs`. Establish the distinction, in code and in UI, between *visual demonstration* and
*validated numerical result*.

## M3 — Basic visualization

Velocity magnitude colour map, pressure map, basic dye/tracer. Tracer must be stored and
computed **separately** from the fluid state. Rendering layer consumes solver output; it
never writes to it.

## M4 — Obstacles and boundary conditions

Real boundary conditions as first-class, configurable objects:
- Wall — no-slip, `u = 0`
- Inlet — constant velocity; pressure inlet; flow rate where practical
- Outlet — appropriate outflow condition
- Closed domain
- Moving wall with prescribed velocity

The user must be able to see which boundary condition is applied where. Geometry stays out
of the solver.

## M5 — Interactive geometry

**The major architectural transition.** Before this point the grid is predefined; after it,
the pipeline is:

```
user geometry → grid/mesh → boundary conditions → solver → visualization
```

Tools: wall, line, rectangle, circle, polygon, obstacle, eraser, select, move.
The system must automatically classify fluid region / solid region / boundary / inlet / outlet.

Expect this to be substantially harder than it looks. Do not begin it before M0–M4 are solid.

---

# NEXT — Expand

Not scheduled. Do not start any of these while a NOW milestone is open.

- **M6 — Sources and injection**: full-wall inlet, point source, mouse momentum brush, dye
- **M7 — Probes**: click anywhere for position, u, v, speed, pressure, vorticity, local Re;
  plot any quantity over time
- **M8 — Visualization modes**: velocity vectors, streamlines, pathlines, vorticity,
  divergence, density — switchable without altering the simulation
- **M9 — Flow analysis**: Reynolds number, velocity gradients, shear, separation and
  recirculation indicators, pressure drop
- **M10 — Experiment mode**: guided scenarios — pipe flow, flow around a cylinder, sharp vs.
  smooth bend, Reynolds-number sweep
- **M11 — Equation explorer**: governing equations in the UI; click a term
  (`∂u/∂t`, `u·∇u`, `−∇p`, `μ∇²u`, `f`) to get an explanation *and* a highlight of where
  that effect currently dominates
- **M12 — Materials**: water, air, custom fluid; density and viscosity must genuinely
  affect the solver
- **M13 — Import / export**: save and load projects, export data/CSV/images/graphs
- **M14 — Performance**: Web Workers, WebGL/WebGPU, adaptive resolution. UI must stay
  responsive; the sim loop must never freeze the app

---

# VISION — Not yet

See `VISION.md`. Listed here only so it stays out of the NOW list.

- **V2** — Advanced 2D CFD: finer meshes, complex boundaries, higher Re, benchmark validation
- **V3** — Real turbulence modelling (RANS / LES)
- **V4** — 3D: architecture, then a limited solver on simple geometries, then arbitrary geometry
- **V5** — Broader physics platform: heat, waves, diffusion, EM, acoustics, quantum

---

## Progress note

There are a lot of milestones listed above. That is intentional — it is the destination,
not a backlog you are behind on.

**M0 through M5 is the actual project.** Everything after that is expansion of something
that already works.
