# M8 — Visualization modes

Working agreement item 7: *document the numerical method chosen and why —
stability, accuracy, implementation cost, and room to expand.*

The roadmap asks for six views: *velocity vectors, streamlines, pathlines,
vorticity, divergence, density — switchable without altering the simulation.*

Five were built. The sixth does not exist, and saying so is the first section.

---

## 0. There is no density field

`rho` is a **scalar parameter**, uniform by construction. This is an
incompressible solver: density does not vary in space, does not vary in time,
and is not stored per cell. A density view would be one flat colour in every
scenario at every instant.

So it is not built, and `tests/test17_m8_visualization.js` asserts the reason
rather than leaving the omission to be read as an oversight — every scenario is
checked to carry `rho` as a number and the grid to carry no density array. A
real density field needs a compressible or variable-density formulation, which
is V2 at the earliest; M12 (Materials) makes `rho` selectable per fluid, still
uniform.

This is M6's "full-wall inlet" again: the honest move is to say which part of a
milestone was already there or is not there at all, rather than to ship
something that has the right name.

## 1. Colour maps and overlays are different things

The five that were built split in two, and the split decides how they are
switched.

**Colour maps** — vorticity and continuity — join the existing `#mode`
selector beside velocity, pressure and dye. One at a time, because a pixel has
one colour.

**Overlays** — vectors, streamlines, pathlines — are independent checkboxes
drawn *over* whatever colour map is showing. Three reasons: the reference
gallery's own first panel is velocity magnitude with streamlines over it, so
making them mutually exclusive would forbid the most useful combination;
`#showregions` already works exactly this way; and an overlay answers a
different question from the field underneath, which is the case for showing
both at once rather than against it.

All five are pure display changes — M3's rule — and the browser check asserts
it by comparing the iteration count either side of every toggle.

## 2. Vorticity: a scale centred on a physical zero

`ω = ∂v/∂x − ∂u/∂y` already existed and was validated in M7. What M8 adds is
the picture, and the picture needed one decision.

The pressure view is drawn **relative to the domain mean**, because pressure's
datum is arbitrary. Vorticity's is not: zero means irrotational, and shifting
the centre to the field's mean would paint still fluid as rotating. So the
vorticity scale is centred on **zero**, and the sign carries the direction of
rotation.

The clip is the same p99 machinery pressure uses, for a weaker reason.
Measured over 400 steps:

| scenario | max\|ω\| | p99 | rms | max/p99 | max/rms |
|---|---:|---:|---:|---:|---:|
| bend-sharp | 35.76 | 15.17 | 4.48 | 2.4 | 8.0 |
| bend-smooth | 31.05 | 11.75 | 4.08 | 2.6 | 7.6 |
| cylinder | 12.32 | 2.70 | 0.67 | 4.6 | 18.3 |
| cavity | 59.44 | 22.57 | 4.99 | 2.6 | 11.9 |
| pressure-channel | 3.28 | 3.28 | 1.75 | **1.0** | 1.9 |
| jet | 10.57 | 7.74 | 2.31 | 1.4 | 4.6 |

Vorticity is **less** concentrated than pressure (whose max/rms runs 8.9 to
20.3), because a vorticity extreme is usually a wall layer — an extended
structure that is the point of the view — rather than the two corner cells that
set the pressure scale on the mitre bend.

The percentile is self-limiting for exactly that reason, and the
pressure-channel row is the proof: where the extreme is a full row of wall
cells, **p99 is the maximum** and nothing is clipped at all. Where it is
concentrated — the cylinder's staircase surface — 1% of cells clip, the
clipping is reported in the legend as it is for pressure, and the rest of the
field gets 4.6× more of the ramp.

## 3. The continuity view, and a fix with the fault it was fixing

This is the part of M8 worth reading.

The view shows `∇·u − q`: how far the projection is from delivering the
divergence the sources ask for. It is labelled **continuity error** and not
"divergence" whether or not a mass source is running, for M6's reason — with
one running, `max|∇·u|` is `q` by design and reads about 1.8 where the bound is
1e-7, so a view called "divergence" would light up red for a source working
perfectly.

Every other view fits its scale to the field. Doing that here is obviously
wrong: the quantity is supposed to be zero, so a fitted scale paints the
rounding noise of a converged solve at full contrast and a viewer concludes the
simulation is failing.

**So the scale was fixed to the solver's own divergence tolerance. That
produced the identical picture.**

The reason is in a table that had already been measured, before the scale was
written, and was not checked against it:

| scenario | max\|∇·u\| | p99 | bound |
|---|---:|---:|---:|
| bend-sharp | 7.75e-8 | 5.81e-8 | 1e-7 |
| bend-smooth | 8.80e-8 | 6.40e-8 | 1e-7 |
| cylinder | 9.48e-8 | 5.34e-8 | 1e-7 |
| cavity | 9.76e-8 | 6.07e-8 | 1e-7 |
| pressure-channel | 7.84e-8 | 6.90e-8 | 1e-7 |
| jet | 7.74e-8 | 5.29e-8 | 1e-7 |

**A converged iterative solve stops AT its tolerance, not far below it.**
Typical cells sit at 50–98% of the bound, so normalising against the bound puts
them at 50–98% of the ramp. The cylinder rendered as a full-contrast noise
field covering the entire domain — a picture of catastrophic failure, for a run
whose worst cell was inside its promise.

The anchor is now a **decade past** the bound. A healthy field occupies the
innermost tenth of the ramp and reads as near-uniform, which is the correct
picture; the tolerance itself falls a tenth of the way out, so a field at the
limit is a visible tint rather than an alarm; and a field an order of magnitude
past the promise saturates, which is when an alarm is deserved. Cells past the
bound are counted and named — **against the bound, not against the scale**,
since the scale is a display choice and the bound is what the solver undertook.

Two regression tests, one in node and one in the browser, assert that a healthy
run does not paint as a broken one. Setting the headroom back to 1 turns both
red, reporting 97% of the ramp and 44.8% of the canvas respectively.

## 4. Streamlines are not pathlines

A **streamline** is tangent to the field at one instant: freeze the flow,
follow the arrows. A **pathline** is the trajectory of one parcel through time,
integrated as the field changes underneath it.

In a steady flow they are the same curve. In an unsteady one they can look
nothing alike — which is why the roadmap asks for both, and why a pathline
cannot be computed from a snapshot. It is **state**: the session advances every
parcel on every solver step, with the timestep the solver actually took, and
discards the trails whenever the field is rebuilt. Same rule as the probe
histories, and for the same reason — a trail drawn across a reset is two
simulations shown as one curve.

The coincidence in steady flow is tested rather than assumed. In solid-body
rotation, whose exact streamlines are circles: the streamline drifts 3.5e-4 of
a radius, the pathline 1.3e-8.

Parcels are seeded **uniformly over the fluid**, not at the inlet. Releasing
everything from an inlet is the more literal reading of the reference's
"particles released from inlet" and it produces a domain that is empty wherever
the flow has not reached and crowded at the entrance — so the density of the
picture would carry information about the seeding rather than about the flow. A
parcel that leaves through an outlet is respawned uniformly rather than clamped
to the edge; clamping piles parcels against every wall and reads as fluid
accumulating there.

Seeding is deterministic (a small seeded PRNG), so the same scenario reset
twice gives the same picture and a test can assert something exact about one.

## 5. Interpolating, where the probe refuses to

M7's probe reports the **cell** under the pointer and deliberately does not
interpolate, because a reading that slides smoothly between cells hides the
resolution it was computed at.

`physics/velocityField.js` does the opposite, and the difference is the
consumer. A streamline is not a reading, it is a **trajectory**, produced by
integrating between cell centres. Integrating a piecewise-constant field does
not preserve the resolution — it manufactures a staircase that is not in the
flow, which is a worse lie than a smooth curve. The parcel is genuinely between
cells, so the field it sees has to be too.

Both are honest about a different thing, and neither is the default for the
other's job.

The interpolation is bilinear from each component's **own** staggered
positions — `u` at `(i·h, (j−½)h)`, `v` at `((i−½)h, j·h)` — so the two use
different index offsets. Getting one wrong shifts that component by half a cell
and still draws a plausible flow, so the test is exactness on a linear field,
where any half-cell slip becomes a constant error. Measured: **4.4e-16**.

What it knows about walls is written down rather than papered over. Faces on a
body's surface hold zero, which is no-penetration and exactly right; faces
*inside* a body hold a reflection the solver keeps for its tangential no-slip
stencil, which is not a velocity. A stencil anchored in fluid can reach one
within half a cell of a surface. Rather than special-casing it — which needs a
wall normal a staircase surface does not have — every trajectory **stops at the
first solid cell**, so the reflected value can only affect the last half-cell
of a curve that was ending anyway. Across all six scenarios, 15,475 traced
points, **none outside the fluid**.

## 6. Midpoint, not Euler — measured

Solid-body rotation is the case that decides this, because a streamline through
a vortex is what these are most used to look at and it is where a first-order
scheme fails visibly rather than subtly.

Over 900 steps at `ds = h/2` on a circle of radius 0.5:

| integrator | radius drift |
|---|---:|
| forward Euler | **80.3%** |
| midpoint (RK2) | **0.04%** |

Euler draws a recirculation that is decaying when the simulation's is not — an
artefact of the drawing presented as a property of the flow. RK4 was not
chosen: four evaluations per step for an accuracy not visible at these step
sizes, where halving the step with RK2 is cheaper and more predictable.

Steps are in **arc length**, not time, so points along a streamline are evenly
spaced regardless of local speed. Pathlines do the opposite and step in time —
their spacing *is* the speed, and that shortness is the measurement.

## 7. Even spacing, approximately — and two ways it leaked

Seeding on a lattice and tracing every seed bundles lines wherever the flow
converges and leaves bare patches where it diverges, so the visual density of
lines reads as a property of the flow when it is an artefact of the seeds.

The fix in the literature is Jobard & Lefebvre (1997): trace a line, then
refuse to let a later line come within a chosen distance of it. What is
implemented is the cheap approximation — an **occupancy grid** where a line
stops on entering a cell another line holds. It is coarser (per-cell rather
than a true distance) and is recorded as an approximation rather than presented
as the method.

Two lengths, not one. Seeds are laid out at `spacing`; the distance at which a
line stops for another is **half** of it. With a single length the first line
traced claims a corridor a full seed pitch wide and almost nothing else fits —
measured at 4 lines on the smooth bend against 13 with the pair.

Writing the test that asserts "no two lines share a cell" found two ways the
rule was leaking:

- **A rejected line kept its cells.** Lines shorter than four points are
  discarded as debris, but their claims stayed, blocking seeds on behalf of
  curves nobody could see. Ids are now unique per *attempt* and a discarded
  line's cells are released.
- **The seed point was never claimed.** It is pushed into the polyline directly
  rather than through the marching loop, so exactly one point per line sat
  outside the separation rule — and where the backward march produced nothing,
  that point was the line's first. Measured at 72 such points on the sharp bend
  and 606 on the cylinder: invisible in the picture, and a rule with an
  exception nobody had written down.

After both: **0 shared points** across all six scenarios.

Current line counts at `spacing = 6h`, `ds = h/2`: cylinder 127, cavity 53, jet
35, bend-sharp 19, pressure-channel 15, bend-smooth 14.

## 8. Arrows that could not be seen

The vector overlay was written to colour each arrow by magnitude through the
velocity ramp, which is what the reference gallery does. It drew 332 arrows,
reported 332 arrows, and **none of them were visible**.

Over the velocity view — the default, and the one they are most wanted with —
an arrow's colour is that ramp evaluated at very nearly the same speed as the
cell it sits on. Every arrow was painted in exactly the colour of its own
background.

The reference's vector panel has no colour map underneath: it is a view, not an
overlay. Different constraint, different answer. Arrows are now drawn in one
high-contrast colour over a dark halo, which also makes them legible over
pressure, vorticity and dye. Magnitude is carried by the **length** and by the
picture underneath; the arrow's job is direction.

Two smaller decisions, both measured:

- **Spacing is in display pixels, not cells.** A fixed cell stride gives a
  different picture on every grid — an unreadable mat at 128×36 and a scatter
  of six at 24×24. The stride is derived from the zoom, targeting a 22-pixel
  gap, with a hard cap on the total that does not depend on another module's
  clamp.
- **The reference speed is scanned over every fluid cell**, not over the
  strided subset. It was the latter, and a coarser sample missed the true peak:
  1.396 against 1.489 for the same field, so arrow colours shifted with the
  zoom while the picture beneath them did not.

## 9. Cost

| | |
|---|---:|
| streamline tracing, cylinder (largest grid) | 4.4 ms per repaint |
| pathline advance, 300 parcels | 85 µs per step |
| one cylinder solver step | 86 ms |

Streamlines are re-traced on **every repaint**, because they are instantaneous:
the curve tangent to the field a moment ago is not the curve tangent to it now,
and caching one shows a picture of a field that no longer exists. At 5% of a
step that is affordable.

Pathlines are advanced on every step **whether or not the overlay is on**.
Making it conditional would mean turning the checkbox on starts accumulating a
trail rather than showing one, and at 0.1% of a step there is nothing to save.

## 10. Deferred, explicitly

- **Line integral convolution**, which is what the reference's streamline panel
  actually looks like. It is a texture method, not a curve method, and belongs
  with a shader rather than a 2D context.
- **True Jobard–Lefebvre spacing**, with a distance test rather than a cell
  test. The approximation is good enough that the difference is not visible at
  these grid sizes.
- **Streamline seeding by hand.** Clicking to place a seed is the obvious
  extension and collides with the probe and brush tools for the pointer.
- **Turbulent kinetic energy and wall shear stress**, both in the reference
  gallery. The first needs a turbulence model (V3); the second needs a wall
  normal, which a staircase surface does not have — the same obstruction M5
  recorded for flux-prescribing conditions on drawn surfaces.
- **Density**, per §0.
- **Boundary-inflow timestep coupling** — still open from M6, unchanged.

## What is worth remembering

**A fix can have the fault it is fixing.** The continuity scale was fixed
rather than fitted for exactly the right reason and produced exactly the same
broken picture, because "anchor it to the solver's promise" sounds like a
principle and a converged solve stops *at* its promise. The numbers that showed
this had been measured before the scale was written and were not checked
against it. Measuring something is not the same as consulting it.

**Two things were invisible until a screenshot.** 332 arrows drawn in the
colour of their own background, and a healthy solve painted as a catastrophe.
Neither was a numerical error; both were correct code producing a wrong
picture, and no assertion that had been thought of would have caught either.
That is the third milestone running where opening the app found something the
tests did not.

**Writing the invariant found the leak.** "No two streamlines share a cell" was
written as a test of an algorithm believed to be finished, and it was false in
two independent ways. Neither was visible in the picture. Both were rules with
unwritten exceptions, which is the same shape as working agreement item 8
wearing different clothes.
