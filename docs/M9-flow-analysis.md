# M9 — Flow analysis

Working agreement item 7: *document the numerical method chosen and why —
stability, accuracy, implementation cost, and room to expand.*

The roadmap asks for: *Reynolds number, velocity gradients, shear, separation
and recirculation indicators, pressure drop.*

Nearly all of it is one object — the velocity gradient tensor — read five
different ways. The milestone is therefore mostly about **naming**: three of
the five quantities have an obvious definition that answers a slightly
different question from the one the name promises, and two of them turn out to
be things this solver cannot honestly report at all.

---

## 0. Two refusals, both measured

**Integrated wall force is withheld.** Not drag, not lift, not total shear.

**Recirculation is not counted at Q > 0.** It is counted where rotation exceeds
strain by a stated margin.

Both are §3 and §5. Each is a number rather than a caution, which is the
difference between a refusal and a shrug.

## 1. Everything comes from one tensor

On a MAC grid the four components of ∇u are not in the same place, and two of
them are free while two are not:

```
du/dx = (u[i,j] − u[i−1,j]) / h      exact AT THE CELL CENTRE
dv/dy = (v[i,j] − v[i,j−1]) / h      exact AT THE CELL CENTRE
du/dy = (u[i,j+1] − u[i,j]) / h      exact AT THE CORNER
dv/dx = (v[i+1,j] − v[i,j]) / h      exact AT THE CORNER
```

The diagonal terms are centred differences of the two faces bracketing the
cell. The off-diagonals are centred on the corner — which is the same fact M7
recorded for vorticity, seen again, because vorticity *is* `dv/dx − du/dy`.

Bringing the tensor to one place needs the off-diagonals averaged from the four
corners. The consequence carries over unchanged: **second order in the
interior, one-sided and first order against a wall.**

### One quantity, one definition

Vorticity is now reachable two ways: from the corners directly
(`physics/probe.js`), or through the tensor. They are the same arithmetic and
**not the same floating-point operation** — averaging four corner vorticities
is not averaging `du/dy` and `dv/dx` separately and then subtracting. Measured
gap on a cylinder run: **1.8e-15**.

Small, and the beginning of two numbers called "vorticity" that a reader would
reasonably expect to be one. So `vorticityFromGradient` delegates to the
canonical one, and a test asserts they are bit-identical.

The Q-criterion deliberately does *not* delegate: it compares the rotation
tensor against the strain tensor, and both must come from the same tensor or
the comparison is between two slightly different fields. That is the one place
the tensor's own pair is the right pair, and the comment says so.

## 2. Shear rate is not vorticity

The two are the same two derivatives, **added** and **subtracted**:

```
shear rate  γ̇ = du/dy + dv/dx
vorticity   ω = dv/dx − du/dy
```

| field | γ̇ | ω |
|---|---:|---:|
| uniform shear, rate S | S | −S |
| solid-body rotation, rate W | 0 | 2W |

A shear layer is large in both. Solid-body rotation is large in one and exactly
zero in the other. Showing either under the other's name would make a shear
layer look like a vortex, which is the single distinction a viewer is most
often trying to make — so they are separate views with separate labels, and the
note on each says what the other one is.

## 3. Wall shear: computed per face, refused in total

Every surface face on this grid is **axis-aligned by construction** — a face
between a fluid cell and a solid one is a segment of a cell boundary. Its
normal is exact, its tangent is exact, and

```
τ = μ · d(u_tangential)/dn
```

is a proper velocity gradient there. Validated against plane Poiseuille, whose
wall stress is exactly `6μU/w`:

| cells across | relative error |
|---:|---:|
| 12 | 1.37e-2 |
| 24 | 3.46e-3 |
| 48 | 8.67e-4 |

**Second order** (rate 1.99). Worth knowing what that actually measures: the
discrete wall stress reads **0.300000 at every resolution**, because the
streamwise force balance pins it — the pressure drop across the channel has to
be carried by the two walls. What converges is the analytic value it is
compared against, through the flow rate.

### Why the total is withheld

Summing over surface faces sums the **staircase perimeter**, and for a curved
body that is not the perimeter of the body it represents. Measured on a circle
of diameter D:

| n | staircase perimeter | true circle | ratio |
|---:|---:|---:|---:|
| 16 | 2.0000 | 1.5708 | 1.2732 |
| 32 | 2.0000 | 1.5708 | 1.2732 |
| 64 | 2.0000 | 1.5708 | 1.2732 |
| 128 | 2.0000 | 1.5708 | 1.2732 |
| 256 | 2.0000 | 1.5708 | 1.2732 |

The ratio is **4/π exactly** and **it does not converge**. The staircase
perimeter of a convex shape is the perimeter of its bounding box at every
resolution — the classic staircase paradox — so an integrated drag on the
cylinder would be about 27% high and refining the grid would not reduce the
error at all. A number that wrong, in a way more resolution cannot fix, does
not belong beside correct ones.

This is the same refusal M5 makes for flux-prescribing conditions on drawn
surfaces, for the same underlying reason, with the same remedy: a cut-cell or
immersed-boundary treatment.

On an **axis-aligned** body the staircase perimeter is exact — measured at
12.00 for the sharp bend, its true wall length — so integration would be
legitimate there. It is still not offered, because deciding which case a domain
is in needs a classifier with a threshold in it, and a number that is sometimes
meaningful is worse than one that is never shown.

The refusal lives in the returned data (`integrable: false` plus the reason),
not only in a comment, so a caller cannot take the per-face numbers and quietly
add them up without meeting it.

## 4. A domain-boundary wall is a wall — instance 7

The first version keyed surface faces on `solid[i] !== solid[i+1]`.

That is a **proxy** for "the fluid meets a no-slip wall here", and the two come
apart for **half the scenarios in this project**: the cavity's lid and the
pressure channel's walls are *boundary conditions*, not solid cells. Both
reported zero surface faces and no wall shear at all — and the cavity's lid is
the single most interesting wall here.

Instance 7 of working agreement item 8, caught before it shipped. The property
actually meant is asked of the compiled boundary plan as well as of the mask.

Two details fell out of doing it properly:

- **A moving wall shears by the difference.** Fluid travelling at exactly the
  lid's speed is not being sheared by it. A formula that forgot the wall's own
  velocity would report the largest stress in the domain at precisely the place
  there is none.
- **Free-slip is excluded.** It carries zero tangential stress by construction,
  so including it would pad the surface with faces that can never separate and
  can never carry the peak — true zeros standing among measured values.

## 5. Recirculation: Q > 0 is a coin flip

Separation and recirculation are different things. **Separation** is a wall
phenomenon — the tangential stress passing through zero. **Recirculation** is a
property of the interior.

The obvious interior test is "the velocity is negative", and it cannot be made
geometry-independent: negative *relative to what*? Every choice of a direction
is a property of the domain rather than of the flow, which is why the existing
validated helpers (`separationBubble`, `wakeBubbleLength`) each know their own
scenario's centreline and cannot be promoted into a general feature.

The **Q-criterion** (Hunt, Wray & Moin 1988) needs nothing but the field:

```
Q = ½(|Ω|² − |S|²)
```

with three exact values that make it testable: solid-body rotation at rate W
gives `W²`, planar strain at rate a gives `−a²`, and **pure shear gives exactly
zero**.

That last one is the problem. Pure shear puts `|Ω|² = |S|²` *analytically*, so
Q's measured sign is decided by the last bits of a difference of two nearly
equal numbers. Measured on the pressure channel — a fully developed Poiseuille
flow containing no vortex at all — a bare `Q > 0` test reported **49.2% of the
fluid as rotating**.

So a cell counts as rotation-dominated when `|Ω|² > (1 + δ)|S|²` with δ = 10%.
A **relative** margin, so it is scale-free: there is no velocity or length in
it and it means the same thing in a cavity at Re 1000 and a channel at Re 20.
The panel states the margin, exactly as the pressure scale states its
percentile. Cells within the margin are counted as **balanced**, which is what a
shear layer is, rather than being pushed to one side.

| scenario | rotating | straining | balanced |
|---|---:|---:|---:|
| pressure-channel | **0.0%** | 0.0% | **100.0%** |
| cylinder | 6.1% | 91.2% | 2.6% |
| jet | 11.1% | 28.4% | 60.6% |
| cavity | 14.1% | 72.3% | 13.6% |
| bend-sharp | 15.0% | 35.5% | 49.6% |
| bend-smooth | 18.6% | 32.1% | 49.3% |

The channel row is the proof, the same way the pressure channel was the proof
that M8's vorticity percentile is self-limiting.

### A separation point can be exactly zero

The detector walks runs of consecutive same-orientation faces looking for a
sign change in τ. The first version skipped faces where `τ === 0`, to keep the
interpolation safe — and that **lost the separation entirely** whenever the
crossing landed on a face: with stresses of +0.1, 0, −0.1 the zero killed both
adjacent sign tests and the reversal went unreported. The guard was protecting
the arithmetic from the one case the function exists to find. A zero face is
now reported at its own position, once.

## 6. Two Reynolds numbers, and a hole nothing was checking

A scenario's Reynolds number is an **input**: the build function picks Re and a
reference pair (U, L), and derives ν from them.

That pair was local to the builder and **not recorded anywhere**, so nothing in
the app could reconstruct the number — and nothing checked that a scenario
whose ν was edited still had a truthful Re label. `reference: { U, L, speed,
length }` is now declared beside `Re`, and a test asserts `Re = round(U·L/ν)`
for all six. They all pass today; nothing would have noticed if one had not.

The second figure is the **peak Reynolds number**, `u_max·L/ν`, using the same
length with the fastest fluid actually present. Measured on the sharp bend:
declared 200, peak **786** at |u| = 3.93 against an inlet speed of 1 — the
corner jet, which is a fact about the flow the declared number cannot show.

Both are named by the speed they use. M7's lesson unchanged: two quantities
that answer to one name must never be allowed to share it.

## 7. Pressure drop is between two points

With nothing prescribing a pressure the field is a gauge — M7's work — so only
differences mean anything. Two readouts:

- the **range** over the fluid, which needs no second point and is the largest
  honest statement available;
- **Δp between the first two pinned probes**, which reuses M7's machinery and
  is the form that means the same thing under every boundary condition. It
  refuses when either probe is in a wall or outside the domain, rather than
  building a number from a cell with no fluid in it.

## 8. The Q view is plotted as sign(Q)·√|Q|

Q is quadratic in the velocity gradients, so its raw range spans orders of
magnitude and a linear scale leaves everything but the strongest core at the
centre colour — confirmed by looking at the sharp bend, where the whole
downstream leg was black.

The square root is not a cosmetic squash: it returns the quantity to units of
**1/time**, the same units as vorticity and shear rate beside it, which is what
makes the three legends comparable. The view is labelled with the transform
rather than called "Q", and the note says what is plotted.

Vorticity, shear rate and √Q now share one implementation of the signed,
zero-centred, p99-clipped scale, so they cannot drift apart in how they scale.

## 9. Deferred, explicitly

- **Integrated drag and lift**, per §3. Needs cut cells or an immersed
  boundary, or a per-surface classifier — both bigger than this milestone.
- **Turbulent kinetic energy**, in the reference gallery. Needs a turbulence
  model: V3.
- **λ₂ and Δ vortex criteria.** Q is the one with three exact analytic values
  in 2D, which is why it went first; the others would be additions, not
  replacements.
- **Separation *lines*** rather than points — joining the zeros along a curved
  surface, which needs the same surface-tracing a cut-cell method would give.
- **Pressure drop between arbitrary sections** rather than two probes.
- **Boundary-inflow timestep coupling** — still open from M6, unchanged.

## What is worth remembering

**Half the scenarios had no walls.** Keying on solid cells is a proxy for
meeting a no-slip wall, and the case it missed was the cavity's lid — the most
interesting wall in the project. Seventh instance of item 8's shape, and the
first one caught by asking "which scenarios does this return nothing for?"
before shipping rather than after.

**A threshold at an analytic zero is a coin flip.** `Q > 0` is the textbook
statement and it reported half of a laminar channel as recirculating, because
the quantity it tests is exactly zero there and the sign is rounding. The same
shape as M8's continuity scale: a rule that is correct in principle and
meaningless at the precision the thing is actually computed to.

**The guard protected the arithmetic from the answer.** Skipping `τ === 0` to
keep an interpolation safe deleted the exact separation point — the one thing
the function exists to find.
