# M6 — Sources and injection

Working agreement item 7: *document the numerical method chosen and why —
stability, accuracy, implementation cost, and room to expand.*

The roadmap asks for four things: a full-wall inlet, a point source, a mouse
momentum brush, and dye. One of them was already built.

---

## 0. What was actually new

**"Full-wall inlet" is a UI item, not a numerical one.** M4 delivered inflow,
flow-rate and pressure conditions on a whole side or a segment; M5 attached them
to drawn surfaces. What did not exist was any way to *change* one without
editing a scenario file. Saying so plainly is better than re-presenting M4's
work as new, so §5 is about a form and a stale cache rather than about physics.

What is genuinely new is **interior sources** — things that add momentum or mass
in the middle of the domain rather than at its edge — and the brush that drives
one from the pointer.

## 1. Two kinds, because they enter different equations

Everything here splits in two, and the split is the design rather than a
taxonomy:

**Momentum sources** are a body force. They add no mass, so whatever divergence
they create the projection removes, exactly as it removes advection's. There is
no configuration of them that makes the pressure problem unsolvable. The solver
has always had the term — `fx`/`fy`, applied uniformly — and a momentum source
is that term made spatially varying.

**Mass sources** make the flow deliberately non-solenoidal: `∇·u = q`. The
pressure equation becomes

```
∇²p = (ρ/dt)(∇·u* − q)
```

and brings a solvability condition with real teeth: on a pure-Neumann region the
integral of `q` must equal the net flux through that region's boundary, or **no
pressure field satisfies it**.

Keeping them as separate types rather than one with a flag is what lets each
carry its own failure mode, its own timestep contribution, and its own answer to
"what does the divergence readout mean now".

## 2. A brush is a target velocity, not a force

A raw force has no bound. `computeStableTimestep` sizes `dt` from the field
*before* the step, so a force applied during the step can leave the fluid moving
faster than that `dt` was chosen for. That is the limitation carried since M3,
except a brush would repeat it on every stroke rather than once per run.

Written as a relaxation instead:

```
Δu = α·(u_target − u),      α = min(1, dt/τ)
```

the source's contribution lands strictly between the current velocity and the
target, **for any τ and any dt**. The clamp is what makes it unconditional: a
relaxation time shorter than the timestep means "reach the target this step"
rather than overshooting past it.

Measured by deleting the clamp — at τ = 1e-9 against dt = 4.167e-3, one step
launched a face to **1,498,443** against a target of 0.5, and the CFL check
caught it at 315× the limit. With the clamp, the same step reaches 0.3596.

The increment is added *after* the `dt` bracket rather than folded in as an
acceleration: `f = α(target−u)/dt` multiplied by `dt` again is not exactly
`α(target−u)` in floating point, and adding it directly is the same operator
split without the round trip. The bound then holds exactly rather than nearly.

τ is a real time and does not change with the timestep, so a source behaves the
same way at any resolution. A dimensionless "strength per step" would not: it
would make the physics a function of whatever `dt` the driver happened to pick.

## 3. Where a source is sampled

Not everywhere at cell centres. On a staggered grid the three quantities live in
three different places:

| what | sampled at |
|---|---|
| momentum, x | u faces: `x = i·h`, `y = (j−0.5)·h` |
| momentum, y | v faces: `x = (i−0.5)·h`, `y = j·h` |
| mass | cell centres: `x = (i−0.5)·h`, `y = (j−0.5)·h` |

A source sampled at cell centres and applied to faces would be half a cell out
everywhere, which looks like sloppy placement rather than a bug. On the test
disk the correct sampling claims **38 u faces** against the **32** a cell-centre
sampling would have given, so the mistake is visible to a test.

Two consequences, both refused rather than silently allowed:

- **A selection catching nothing the solver would update.** Counted over the
  faces and cells the momentum loop actually visits, not over everything the
  region covers — a region drawn inside a wall covers plenty of cells and drives
  none of them.
- **A selection catching one face family and not the other.** Not hypothetical:
  a quarter-cell strip on `x = 0.5` catches **12 u faces and 0 v faces**,
  because the v faces on that row sit at 0.475 and 0.525. It would drive `u` and
  silently abandon `v`.

## 4. The flux balance did not count them — the sixth instance

`enforceFluxBalance` accumulated from boundary faces only. A mass source adds
volume in the *middle* of a region and crosses no boundary face, so it counted
for nothing and the outflow correction came out short by exactly the source
rate. A source of 0.05 in a box **with an outlet** — a perfectly solvable
configuration — was rejected as unsolvable.

| case | before | after |
|---|---|---|
| source, region has an outlet | 5.000e-2 → rejected | **1.645e-17 → runs** |
| source, sealed region | 5.000e-2 | 5.000e-2 → refused ✓ |
| source + equal sink, one sealed region | 4.239e-19 | 4.239e-19 → runs ✓ |
| source and sink in separate chambers | 1.091e-1 | 1.091e-1 → refused ✓ |

Four cases, four correct answers, and `assertRegionsAreSolvable` is **untouched**
— the detector was right that the region was unbalanced; the imbalance was the
flux balance's own. Its number is exactly `|rate| / region area`, checked across
three rates and two region sizes.

This is instance six of the shape recorded as working agreement item 8: the
filter was "is this a boundary face", the property is "does this region gain or
lose volume".

## 5. The divergence contract

With a mass source running, `∇·u = q` by design, so the raw divergence reads
**1.8e+0** where the bound is 1e-7. Shown as it always was, that tells a viewer
who does not know a source is running that the solver has failed — the exact
failure the validation panel exists to prevent.

**Rejected:** making `computeDivergence` return something else when handed an
extra argument. That is one name with two meanings depending on a call site's
details, which is the shape of the six bugs item 8 is about. Building it in
deliberately, immediately after writing the rule down, would have been absurd.

**Adopted:** `computeContinuityError(grid, sources)` = `max|∇·u − q|`, beside an
unchanged `computeDivergence`. The precedent is `ui/fieldHealth.js`, which keeps
the raw peak speed separate from the one the panel may show, for this reason.

The property that makes it cheap: **with no mass source the two are identical**
— the same subtraction of the same numbers minus zero — so every existing test,
harness and validation claim keeps its meaning untouched.

`step()`'s returned `divergence` is renamed `continuityError`, because that is
what it has always been. The M1 identity `div_k − q_k = −(dt/ρ)·r_k` holds per
cell whether or not `q` is zero, and was only ever written as "divergence"
because `q` had always been zero. Pinned now on a case where the two differ by
seven orders of magnitude:

```
raw max|div u|             1.8000e+0
max|div u − q|             8.5702e-8
step() reported            8.5702e-8       agreeing to 1.21e-18
```

**The case that settles it.** Set `divergenceTol` above the divergence a
configuration forces and both guards pass, because the caller has said that much
error is acceptable. What the solver produces is not a blow-up — it is
worse-looking-fine: the solve meets the loose bound at `p = 0`, nothing moves,
and the source delivers nothing.

```
peak |u| = 0        raw max|div u| = 0        continuity error = 1.800
```

Every readout that existed before this milestone says the field is perfect. The
continuity error, reading the *entire unmet demand*, is the only number that
says otherwise. That is not a hypothetical benefit of the design; it is the
measurement that justifies it.

## 6. The timestep knows what the brush is about to do

The relaxation bound is known before the step, which is what makes it usable:
the speed after the step is at most `max(field peak, target)`.

A brush switched on in still water, CFL taken from the field each step
*produced* against the `dt` it was given:

| target | uncoupled | coupled |
|---|---|---|
| 0.5 | 0.303 (step 119) | 0.303 (step 119) |
| 1 | 0.442 (step 3) | 0.390 (step 119) |
| 2 | 0.585 (step 1) | 0.389 (step 119) |
| **5** | **1.130 (step 0)** | 0.367 (step 119) |
| **10** | **2.259 (step 0)** | 0.321 (step 119) |

Uncoupled, targets of 5 and 10 run the first step past the hard limit of 1.
Coupled, the worst case stops being the switch-on step at all. Cost, as
simulated time reached in 120 steps: 1.000× at target 0.5, 0.938× at 1, 0.891×
at 2, 0.786× at 5.

Two decisions worth naming:

**It goes in the choice, not the rejection.** The advection this step evaluates
uses the velocity the field has *now*, so the current CFL is the correct
criterion for this step and `assertTimestepIsStable` would be wrong to refuse
it. What the coupling buys is that the *next* step's field is already inside the
`dt` that was chosen. Nothing is rejected that would have worked.

**The norm matters.** The convective limit is stated on `|u| + |v|`, because a
flow running diagonally through a cell is constrained by both components at
once. A source carries both numbers: `targetSpeed` is `hypot` for reading,
`cflSpeed` is `|u|+|v|` for the limit. Sizing a diagonal brush by `hypot` gives
a `dt` **41% too large** — 1.414e-2 against 1.000e-2.

## 7. Boundary editing, and a cache that goes stale

A geometry edit rebuilds the field because the domain it described is gone. A
**boundary edit does not**, and that was measured rather than assumed. On a
settled channel, 120 steps after the change:

| change | max\|div u\| | CFL | outcome |
|---|---|---|---|
| wall → inlet (opening a valve) | 1.00e-7 | 0.595 | runs |
| inlet 1 → 4 (turning a pump up) | 9.98e-8 | 0.948 | runs |
| inlet → wall (closing the inlet) | 1.00e-7 | 0.217 | runs |
| wall → free-slip | 9.99e-8 | 0.293 | runs |
| outlet → wall (sealing it) | — | — | **refused** |

Every legitimate change holds the bound with no restart, and the one
illegitimate change is refused by the detector that already exists.

**The trap.** `boundaryPlanFor` caches compiled plans on the specification
object and validates the cache against grid dimensions and mask version —
neither of which changes when a condition's value does:

```js
const before = boundaryPlanFor(grid, bc);   // left inflow u = 1
bc.left.u = 7;
boundaryPlanFor(grid, bc)                   // same object, still u = 1
```

An editor that mutated in place would leave the solver running the previous
boundary condition, and the only evidence would be a flow that did not change.
So every edit returns a **new, frozen** object: in an ES module — which
everything here is — the naive mutation is then a `TypeError` where it is made,
rather than a stale plan discovered later. That is a defence, not a convention,
and the strict-mode behaviour was verified in a real module rather than assumed.

The same rule governs the source array, for the same reason and with a measured
cost: **0.872 ms** to compile on the largest grid here against **0.0003 ms** for
a cache hit. Rebuilding the array on every read would miss the cache eight times
a frame; rebuilt only when something changes, it is one compile per pointer
move, about 5% of a frame while the pointer is actually moving.

## 8. The brush, and why its speed is a control

"The fluid moves with your hand" is the obvious behaviour and it cannot be
implemented honestly. Screen displacement maps to physical displacement exactly.
**Time does not**: pointer events are wall-clock and the fluid advances in
simulated seconds, and the ratio varies by more than thirty times across the
scenarios here. Any hand-speed-to-fluid-speed mapping needs an invented
constant, and the same gesture would drive the cavity and the cylinder at
unrelated speeds.

So the brush takes its **direction** from the drag, which is exact, and its
**magnitude** from a control, which is honest. A press with no movement drives
nothing rather than inventing a direction — "no movement means stop the fluid"
would make press-and-hold into a brake, which is a different tool wearing this
one's clothes.

A brush is a separate controller from the geometry tools because the lifecycles
are opposite: a geometry gesture commits on release and nothing reaches the
document before that; a brush exists only *while* the pointer is down and leaves
nothing behind.

A stroke dragged over a wall covers no fluid face. That is not an error to
report — it is the brush not pushing anything, which is what should happen — so
it holds no source, and the panel says "armed" rather than "pushing".

## 9. Dye, and the seal

A source may carry `dye`. `sources/` never looks at it: the selection and the
release live in `tracer/sourceDye.js`, so deleting `tracer/` leaves the
simulation bit for bit unchanged — asserted directly, a source with dye 0.5 or
50 produces the same `u`, `v` and `p` as one with none.

`tests/test9`'s structural seal now covers `sources/` and `boundaries/` as well,
which it should have since M4 and M5 moved physics configuration out of
`scenarios/`. Extending it immediately fired on a **comment** in
`sources/kinds.js` explaining why the dye is invisible there — a false positive
on the prose documenting the very rule being enforced. A test that fires on its
own explanation gets loosened, so it strips comments and checks the code.

Dye is released **per unit time**: the total is `dye·dt` whether the tracer
subdivided its step once or eleven times. Releasing `dye·dt` inside the substep
loop would multiply it by the substep count, which varies with the flow.
Measured agreement across 2, 10, 11 and 100 substeps: worst difference
**1.39e-16** against a release of 0.2, which is summation order and nothing
else. Accumulation is clamped to the colour scale's ceiling — a cell allowed to
run without bound would flatten the scale and show nothing.

## 10. What the browser checks caught

Twice in this milestone, a bug that no node test could structurally have seen.

**A source displayed and never applied.** `step()` takes sources through
`params`, the scenario carries them at `scenario.sources`, and the session
passed `{ ...params, dt }`. So the harness compiled a plan to *draw* with while
the solver received none. The signature was the numbers coming out inverted:
continuity 3.20e-1 against a raw divergence of 7.8e-8, exactly the reverse of a
working source. Every node test calls `step()` directly and passes sources
explicitly, so none of them could see it. The regression test asserts the
**field** rather than the call.

**A source placed inside a wall threw an uncaught page error.** `addSource`
validated the source's *shape*, which passed; whether it selects any face the
solver would update is a question about the **grid**, answered by
`compileSources`, which ran later from inside `draw()` where no caller was
guarding. Both source paths now compile the candidate before accepting it.

## 11. Deferred, explicitly

- **Time-varying sources.** Constant-in-time sources you can turn on and off.
  Waveforms are a separate feature with their own stability question.
- **Sources that move with the flow** — a Lagrangian object, not a fixed-grid
  one.
- **Heat or scalar sources with feedback.** Dye stays passive; anything that
  feeds back is M12.
- **Extending the timestep coupling to boundary inflows.** Measured and left
  alone deliberately: it would take the sharp bend's first-step CFL from
  **5.145** to **1.235**, which is a large improvement and still above 1,
  because a boundary inlet has no bound of the kind the relaxation gives — the
  corner jet reaches about 2.9×U from an inlet of 1. Folding a heuristic into
  the parameter that carries a guarantee would be item 8's shape again, so it is
  recorded here rather than done as a tangent.
- **Convective outflow** — still open from M4, unchanged.

## What is worth remembering

**Two predictions and one rule.** The prediction that M5's detector would just
work was wrong in a useful way — it caught the unsolvable case *and* the
legitimate one, which is how the flux-balance gap was found. The claim that no
setting lets an unsolvable source run quietly was simply false, and the case
that disproves it turned out to be the best argument for the continuity-error
design.

The rule that held throughout: **when a filter and the property it stands for
can come apart, ask the property.** Six instances before this milestone, one
during it, and one avoided by refusing to give `computeDivergence` a second
meaning.
