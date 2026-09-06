# M4 — Boundary conditions

Working agreement item 7: *document the numerical method chosen and why —
stability, accuracy, implementation cost, and room to expand.*

Boundary conditions become first-class configurable data instead of four
duplicated `if`/`else` chains in the solver, with two genuinely new numerical
capabilities — flow-rate inlets and pressure boundaries — and a picture of
which condition is applied where.

---

## 1. What the refactor had to prove, and how

The four per-side chains were duplicated because their index arithmetic is
genuinely asymmetric:

| side | normal component | tangential ghost | reflected against |
|---|---|---|---|
| left | `u` at ghost face `i=0` | `v` at `i=0` | `i=1` |
| right | `u` at face `i=nx` | `v` at `i=nx+1` | `i=nx` |
| bottom | `v` at ghost face `j=0` | `u` at `j=0` | `j=1` |
| top | `v` at face `j=ny` | `u` at `j=ny+1` | `j=ny` |

On the left and bottom the normal component sits at the ghost index; on the
right and top it sits at the last *real* face and only the tangential ghost lies
outside. Confusing the two puts a wall half a cell out of place, which still
produces a flow that looks like a cavity flow.

So the standard was not "the tests still pass". `tests/fixtures/golden-fields.json`
records SHA-256 hashes of `u`, `v` and `p` after 30 steps for fourteen cases,
generated from the solver **before** any M4 work: four validated configurations
built from the same boundary-specification objects the M0 tests use, and ten
coverage cases putting every type in every position. After the refactor all
fourteen came back byte-identical.

The guard was mutation-tested rather than trusted:

| mutation | caught | peak \|u\| | peak \|v\| |
|---|---|---|---|
| right tangential ghost at `nx` not `nx+1` | yes | 0.656 → 0.654 | 0.367 → **0.522** |
| wall reflection → direct assignment | yes | 0.656 → **0.441** | 0.367 → 0.221 |
| horizontal sides applied before vertical | yes | 0.656 → 0.656 | 0.367 → 0.367 |

The third is the one that makes the case for hashes over tolerances. Peak
velocities are **identical to six decimals**; only the four corner ghosts moved.
No scalar diagnostic anywhere in the suite would have seen it.

That ordering is now a documented constraint rather than an accident: each
corner ghost is written by two sides, so the vertical sides must run before the
horizontal ones, which read what the vertical pass wrote. The accumulation
order in `enforceGlobalFluxBalance` is preserved for the same reason — `net` is
a running float sum.

A second test asserts the fixture's coverage is complete, and found two holes
immediately: `inflow` was never applied to the bottom side, `outflow` never to
the top. A fixture claiming protection it does not have is worse than none.

## 2. The data model

Conditions are **plain data**, not objects with methods. A condition carrying
code would be code handed to the solver, free to write wherever it liked; inert
data keeps the solver the only thing that writes to a field, makes the
specification serialisable for M5 and M13, and lets the UI render it without
executing anything.

A side takes one condition or a list of segments in physical coordinates:

```js
left: { type: "wall" }
left: [ { from: 0,    to: 0.33, type: "wall" },
        { from: 0.33, to: 0.67, type: "flowInlet", flowRate: 0.3, profile: "parabolic" },
        { from: 0.67, to: 1,    type: "wall" } ]
```

The single-condition form is not a compatibility shim — it is the whole-side
case written without ceremony, which is why all six validated scenarios are
unchanged.

`compileBoundaryConditions` produces one `Int32Array` per side, indexed by the
face index the solver's loops already use, holding an index into a deduplicated
condition table. O(1) in the hot path, one place for validation, and — the part
that matters for the display — the UI draws from the same array.

### The velocity convention

`u` and `v` are **Cartesian components**, not inward-normal speeds. This looks
like a wart until you notice Test 2 depends on it: the uniform channel puts
`inflow` with `u = U0` on *both* the left and right, which under this convention
is flow passing straight through and under an inward-normal convention would be
two streams colliding head-on. A fixture case pins it.

The honest name for what most conditions do is *prescribed velocity*; "inlet"
is a label for the case where that velocity points inward.

### What validation now rejects

Each of these was previously either a silent `NaN` discovered many steps later,
or a parameter that looked like it took effect and did not:

- a gap or overlap between segments, or a side not covered end to end;
- an inlet missing the component normal to its side (`undefined` into a
  `Float64Array`);
- a wall given a normal component — a wall fluid passes through is an inlet,
  and the old code ignored the field silently;
- misspelled or inapplicable parameters.

## 3. Flow-rate inlets

`{ type: "flowInlet", flowRate: Q, profile: "uniform" | "parabolic" }`.

The rate is delivered through the **open** faces of the segment, so an inlet
half covered by an obstacle pushes twice as hard through what is left rather
than quietly delivering half the flow.

Both profiles are **renormalised after sampling** rather than evaluated from
closed form: the sampled shape's discrete integral is divided into the
requested rate. The flux therefore equals the request exactly at any
resolution — measured to 1e-14 at 8, 16 and 33 cells. Sampling a parabola at
face centres and trusting the algebra leaves an O(h²) shortfall, and "almost the
requested flow" is not worth shipping when the exact version costs one division.

Shape is checked separately from total, since an exact integral would also be
satisfied by a uniform profile:

| cells across | peak / mean |
|---|---|
| 16 | 1.4912 |
| 32 | 1.4978 |
| 64 | 1.4995 |

approaching the continuum 1.5 from below.

A fully blocked inlet, and a parabolic inlet split into two openings by an
obstacle, are both rejected with a reason. Two openings have no single centre to
span, and guessing one would invent a profile nobody asked for.

## 4. Pressure boundaries

`{ type: "pressure", p: value }`, usable at either end. This is **not an
additive feature** — it replaces the pure-Neumann pressure problem, which is
singular up to a constant and requires total inflow and outflow to match, with
one that has a unique solution and determines its own flux. Three parts of the
solver change:

**Operator assembly.** Eliminating the reflected ghost `p_g = 2·p_b − p_k` turns
that direction's contribution from the dropped Neumann term into
`(p_g − p_k) = 2·p_b − 2·p_k`, so the cell's diagonal gains 2 and a known
`2·p_b/h²` moves to the right-hand side. Folding the diagonal into `counts`
keeps the CG inner loop exactly what it was, and with no pressure boundary the
code does not execute at all.

**Null space.** The zero-mean projection is skipped when a pressure is
prescribed, where it would discard part of the answer rather than a spurious
mode.

**Velocity correction.** Faces with a prescribed pressure are corrected like
interior faces, since the velocity through them is a degree of freedom. The
factor of two in that gradient is the half cell between the last pressure node
and the face where the condition is imposed, and it is exactly what makes the
corrected field's divergence equal the assembled Laplacian — the
divergence-control identity in `step()` depends on the two agreeing.

Mixing `outflow` with `pressure` is rejected: the flux rescale exists to make a
pure-Neumann problem solvable and would overwrite velocities the pressure solve
is entitled to set, every step.

### Validation

Plane channel, Δp = 3.6 over L = 6, ν = 0.05. Exact steady answer
`U_mean = Δp·w²/(12·μ·L) = 1`.

| cells across | measured `U_mean` | error |
|---|---|---|
| 12 | 1.013889 | +1.389% |
| 16 | 1.007813 | +0.781% |
| 32 | 1.001953 | +0.195% |

**Observed convergence order 2.00.** The order carries more weight than any
single error figure: a wrongly implemented boundary can be accidentally close on
one grid, but it does not converge at second order to the right answer.

Classified `benchmarked` against a `derived` reference (plane Poiseuille), per
a rule fixed before the measurement was taken: within about 1% ships as
benchmarked, worse ships as self-validated with the discrepancy shown.

The residual is the **no-slip wall treatment, not the pressure ends**.
Reflecting no-slip into the ghost is exact for a linear profile and O(h²) for a
parabolic one, and the local `dp/dx` error in the developed region tracks the
global flow-rate error to three digits (−0.775% against +0.781%; −0.195%
against +0.195%), placing the discrepancy in the channel's resistance rather
than at its ends.

Two caveats carried into the registry: the agreement is **resolution-qualified**
(1.389% at 12 cells), and what is prescribed is the **projection variable**,
accurate to O(Δt) with a known error layer near walls — the flow it drives is
right, the pressure number itself is not an engineering-grade static pressure.

## 5. Showing which condition is applied where

The requirement has a trap in it. The obvious implementation reads the
specification and works out where each condition lands — a second implementation
of the rule the compiler already applies. The two drift, and the drift is
invisible, because the picture is the only one anyone looks at.

So the bands are derived from the **compiled plan**: the same `Int32Array` the
solver reads, run-length encoded into spans. A test walks every pixel row of
every band and asserts it names the condition the solver has at the face that
row covers.

One visible consequence: the segmented jet scenario asks for thirds and the
panel reports `0.00–0.35, 0.65–1.00`. The edges rounded onto the cell grid, and
the panel shows where they *actually landed* rather than what was typed.

Bands sit in a margin **beside** the field, never over its outermost cells —
those hold the boundary layer, which is the part of the picture the boundary
condition is most responsible for, and covering it to label it would be a poor
trade.

Flux is **measured** from the velocity field, not read back off the
specification. That is the whole point on a pressure boundary, where nothing was
prescribed and the flux is the answer; and it lets a flow-rate inlet be checked
against its own promise. Non-finite faces are counted, never summed, so a broken
field cannot report a plausible flux. The net across all four sides is shown
because an unbalanced specification is a real error and this is where it becomes
visible.

## 6. Deferred, explicitly

- **Convective outflow** `∂u/∂t + U_c·∂u/∂n = 0`. The present outlet is
  zero-gradient plus a flux rescale (global here; made per-region in M5, see
  `docs/M5-interactive-geometry.md` §4), adequate for the validated cases but
  it **reflects vortices at the outlet**. Replacing it would perturb Test 5, a
  validated benchmark, for a benefit nothing in M4 asks for.
- **Boundary conditions on obstacle surfaces.** Obstacle surfaces remain uniform
  no-slip. Segment-parameterising an interior staircase boundary is a
  substantially harder problem than the domain edges.
  *Delivered in M5* — the full condition set on axis-aligned surface segments,
  wall and free-slip only on staircase surfaces, and flux-prescribing conditions
  on mixed normals refused rather than approximated. See
  `docs/M5-interactive-geometry.md` §5.
- **Time-varying and arbitrary-profile inlets** — M6 territory.
  *M6 delivered neither.* What it added was a way to EDIT a boundary condition
  from the UI, which the numerics here already supported; time-varying inlets
  remain deferred. See `docs/M6-sources.md` §0 and §7.

## Two bugs worth recording

Both were the same shape: **a hand-maintained list of things to remember.**

The fixture's coverage started with two type-by-side combinations unguarded,
found by the test that asserts coverage is complete.

The condition table deduplicates identical conditions so the legend lists each
once, and its key was a hand-written list of fields — `type, u, v, label`. When
`pressure` arrived with its own `p`, both ends of a channel hashed to the same
key and merged into one condition: the same pressure at both ends. It solved
cleanly, converged in four iterations, and sat at exactly zero flow. Nothing
about it looked wrong; the Poiseuille measurement simply returned 0.000000 and
−100%. The key is now built from every property of the condition, sorted, so it
cannot be forgotten when the next parameter is added.

## Handover to M5

M4 is complete as scoped. The pieces M5 will find useful: the specification is
plain serialisable data, segments already attach conditions to parts of a
boundary, and `compileBoundaryConditions` is where a specification built
interactively would be validated before it ever reaches the solver.

The open item from M3 stands unchanged — the first step of a run from rest is
taken outside the stability limit the driver believes it is enforcing. Nothing
in M4 touched the timestep logic.
