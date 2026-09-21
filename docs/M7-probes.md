# M7 — Probes

Working agreement item 7: *document the numerical method chosen and why —
stability, accuracy, implementation cost, and room to expand.*

The roadmap asks for: *click anywhere for position, u, v, speed, pressure,
vorticity, local Re; plot any quantity over time.*

Almost none of that is numerics. The parts that are — vorticity, and what
"local Re" actually means — are where the whole milestone lives, because both
have an obvious implementation that produces a plausible number and answers a
different question than the label claims.

---

## 0. What a probe has to be

A probe is a **reading**. Nothing else it does matters if the number is wrong,
and nothing protects a reader from a wrong number except the thing itself being
built so that a wrong number is hard to produce.

So the design is governed by three refusals:

- a point that is not in the domain gets **no value**, not a clamped one;
- a cell with no fluid in it gets **no velocity**, not a zero;
- a quantity whose meaning depends on something else — pressure on its datum,
  Reynolds number on its length scale — is **never shown without it**.

Everything below is one of those three, or the machinery to make them cheap.

## 1. A probe reports a cell, not a point

Nothing lives where you click. On a MAC grid `u` sits on vertical faces, `v` on
horizontal faces, `p` at cell centres, and vorticity is naturally at the cell
corners: four different places, none of them the pointer.

Two honest options existed.

**(a) Bring everything to the cell centre and name the cell.** `u` and `v` from
that cell's own two faces, `p` as it stands, vorticity from the four surrounding
corners.

**(b) Bilinear interpolation at the exact pointer position**, from each field's
own staggered locations.

**(a) was chosen.** (b) reads more smoothly and hides the one thing a person
most needs to see. A probe that slides continuously across a three-cell-wide
shear layer suggests the simulation resolves it that way; it does not. This is
the same rule M5 applied to the drawing preview — show the sampled cells, not
the smooth outline they were dragged from — and it is the rule for the same
reason: the grid is the thing being trusted, so the grid should be visible.

The cost is a readout that steps rather than glides. That is the honest
behaviour and it is what the panel shows: the position printed is the **cell
centre**, not the pointer's own, which is why the browser check asserts "within
half a cell" rather than equality.

### The cells a probe refuses

A solid cell has no velocity. The faces around it are not a flow: the solver
holds surface faces at zero for no-penetration and *reflects* the adjacent fluid
value into the body for the tangential no-slip condition, and those are ghosts
serving the stencils one layer out. Averaging them yields a number — which is
exactly the danger, because it would read as **fluid at rest** rather than as
**no fluid**. So a probe in a body reports `solid` and NaN, and the panel says
"solid — no fluid here" in words rather than printing six NaNs, because NaN
reads as a broken simulation and this is the ordinary, correct answer.

A probe *outside* the domain is refused at the point of pinning instead. The
difference matters: a wall can be erased, so a probe in one can become useful,
while nothing an edit can do brings cells into being beyond the boundary.

## 2. Vorticity lives at the corners

`ω = ∂v/∂x − ∂u/∂y` is the one quantity here the staggered grid gives for free.
At the node `(i·h, j·h)`:

```
ω = (v[i+1,j] − v[i,j])/h  −  (u[i,j+1] − u[i,j])/h
```

Both differences are centred exactly on the node — the two `v` faces are half a
cell either side of it in `x` and exactly on it in `y`, and the `u` faces the
same in the other direction — with no averaging anywhere. That is why vorticity
belongs at corners and not at centres, and it is the reason a staggered grid is
worth its indexing.

A probe reports a cell, so the four corners are averaged. Measured against the
Taylor-Green field `u = −cos x sin y`, `v = sin x cos y`, whose vorticity is
`2 cos x cos y` exactly:

| n | node, max error | centre, max error |
|---:|---:|---:|
| 16 | 1.28e-2 | 8.51e-2 |
| 32 | 3.21e-3 | 2.22e-2 |
| 64 | 8.03e-4 | 5.60e-3 |

**Both second order** (rate 2.00). The average costs a constant of about 7×, not
an order — which is the justification for reporting it at all.

Solid-body rotation is checked separately and **exactly**: `u = −ω₀y`,
`v = ω₀x` is linear, so the difference quotients have no truncation error and
the answer is `2ω₀` to 1e-14 with no tolerance to hide behind. A linear field
pins the *formula and its sign*; a non-linear one pins the *order*. Both are
needed, and a sign error is the failure that most deserves catching: on a
staggered grid it produces a perfectly plausible-looking field.

Simple shear (`u = Sy`, `v = 0` → `ω = −S`) pins the convention on its own, so
a swapped subtraction cannot pass by also flipping the rotation's sign.

### What is not claimed

At a wall, the corner values are built from the surface faces, so the estimate
there is the usual **one-sided, first-order** wall vorticity sitting among
second-order values. That is where vorticity is generated and it is worth
showing; it is not worth pretending it has the same accuracy. This is stated in
the code, in the registry's caveat, and here — and it is not measured.

## 3. Pressure has a datum, and it is not always the same one

`p = 0.37` is not a measurement. It is a measurement *plus* a statement about
what zero means, and on this solver that statement is not constant across
scenarios:

- With **nothing prescribing a pressure**, the Poisson problem is pure Neumann.
  The solution has a constant null space, the solver projects it out, and what
  comes back is a **gauge**: differences between cells mean something, the value
  at one cell does not.
- With a **pressure boundary** — or a pressure attached to a drawn surface —
  the solution is unique and the value is **absolute**.

The solver already knew this: it is the `singular` flag that decides whether to
zero-mean. The temptation was to re-derive it in the display layer, which is
how two copies of a rule start disagreeing. Instead `pressureIsGauge(plan)` was
**exported from the solver** and the internal use rewritten to call it, so there
is one definition and the panel cannot claim a datum the solve is not using.

Measured, over twelve steps: the cavity (four walls, nothing prescribed) has
mean pressure `3.5e-19` — zero to rounding, a gauge. The pressure channel has
mean `1.800e+0`, seventeen orders of magnitude away: its boundaries put it
there, and subtracting the mean would be discarding part of the answer.

## 4. "Local Re" names two different numbers

The roadmap says "local Re". Two quantities answer to that name and they differ
by about two orders of magnitude:

- **Cell Reynolds number**, `Re_h = |u|h/ν`. Genuinely local. Compares
  advection to diffusion *across one cell* and is a property of the
  discretisation as much as of the flow.
- **Characteristic-length Re**, `|u|L/ν` with `L` a body diameter or channel
  width. What "Reynolds number" ordinarily means — but it is not local at all,
  and substituting a local velocity into it produces a hybrid that describes
  nothing.

Measured, peak over fluid cells after 60 steps:

| scenario | peak cell Re | scenario Re | factor |
|---|---:|---:|---:|
| bend-sharp | 31.6 | 200 | 6 |
| bend-smooth | 26.4 | 200 | 8 |
| cylinder | 13.0 | 100 | 8 |
| cavity | 12.6 | 1000 | 80 |
| pressure-channel | 0.10 | 20 | 192 |
| jet | 17.9 | 75 | 4 |

So the decision: **report `Re_h`, label it "cell Re", and never call it "local
Re" anywhere a reader can see it** — enforced by a test that asserts the label
matches `/cell/i` and not `/local/i`. The scenario's own Reynolds number is
already displayed separately, which is also what the reference mockup does: a
global "Reynolds Number" in its metrics panel, and no per-probe Re at all.

This is a seventh case of the project's recurring bug shape (working agreement
item 8) — a label standing in for a property it is not. It is deliberately kept
out of that item's numbered table, because unlike the six there **nothing
broke**: it was caught while deciding what to call the readout rather than after
shipping it, which is the first time that has happened.

## 5. Sampled per step, not per repaint

The harness runs up to **four solver steps per animation frame**. A probe
sampled in `draw()` would therefore keep one reading in four.

For the flows currently in this project that would be nearly invisible — none of
them oscillates near the step rate, and decimating a real cavity run by four
changes the range of `|u|` from 2.567e-1 to 2.556e-1. The argument is not about
these scenarios. It is arithmetic about what decimation does:

| oscillation period | amplitude, per step | amplitude, every 4th |
|---:|---:|---:|
| 40 steps | 1.000 | 0.951 |
| 12 steps | 1.000 | 0.866 |
| **8 steps** | **1.000** | **0.000** |

A signal at exactly four times the sample rate vanishes completely. An aliased
plot is worse than no plot, because it looks like data — and shedding is
precisely what this project is eventually meant to show.

So the sampling lives in `SimulationSession.advance()`, not in the harness's
repaint. That also makes the x-axis exact: the time recorded is the session's
own accumulated `simulatedTime`, the same number the panel displays, rather than
wall-clock time that has nothing to do with the flow.

**It costs nothing.** Measured: 0.32 µs per probe per step; eight probes take
2.54 µs against an 86 ms cylinder step, or **0.003% of a step**. There was never
a performance reason to sample less often, and the cheaper option was the wrong
one anyway.

This is the one claim in M7 that only a browser can check, since nothing else
runs the animation loop — so the browser check asserts
`probeSamples === iteration` after a real run, which a per-repaint
implementation would fail by roughly a factor of four.

### All quantities are stored, not just the plotted one

Six doubles per sample rather than one. Storing only the selected quantity would
blank the chart the moment someone changed the selector — the moment they most
want to compare. A ring of 3000 samples is about 192 KB per probe and buys
roughly twelve seconds of wall clock at four steps a frame.

## 6. What clears the history

**Anything that rebuilds the field.** A geometry edit or a Reset discards the
flow and starts a new one from the scenario's initial condition, and a curve
drawn continuously across that join is two different simulations shown as one
line. The probe stays pinned — the point is still a point — and its history does
not survive.

**A scenario change discards the probes themselves**, exactly as it discards the
geometry document and the sources: a place in one domain is not a place in
another of a different size and shape.

This is the same rule the session already applies to the field itself, and it is
implemented in the same place, so a future path that rebuilds the field
inherits it rather than having to remember it.

## 7. A broken sample breaks the line

`lineTo(NaN, NaN)` neither throws nor draws. A plot that ignores the difference
shows a straight line from the last good sample to the next one, **straight
through a hole in the data**, and it looks exactly like a measurement. This is
`physics/fieldStats.js`'s rule in a more dangerous setting: there, a bare
comparison produced a wrong range; here it produces a wrong *picture*.

So: every value is classified with `Number.isFinite`, the range is built from
the finite ones, non-finite samples are counted and drawn as **gaps** in the
stroke, and the count is reported in words underneath — because a gap in a line
is not self-explanatory.

Two edge cases have their own handling for the same reason. A **constant** series
would divide by zero; it is padded proportionally and labelled "constant", so a
constant 1000 and a constant 1e-9 both read as flat rather than one of them
looking like noise at full scale. A **single** sample has no time span; it is
drawn at the right-hand edge, where the newest reading belongs, rather than
floating in the middle of an axis it does not span.

## 8. The hover readout, and a staleness that never shipped

The hover readout follows the pointer. The obvious implementation stores the
*sample* taken when the pointer last moved — and then a running simulation shows
a **stale measurement under a live cursor**, which is precisely the thing this
harness is required to be incapable of.

So the harness stores the **point** and re-reads the field on every repaint. One
cell lookup per frame. The browser check runs the simulation without moving the
pointer and asserts the text changes while the cell stays the same, which is the
only way to tell the two implementations apart from outside.

Writing that check turned up a second thing: `page.click("#run")` moves the mouse
to the button, which leaves the canvas, which correctly clears the readout. The
check now dispatches the button's own click instead — otherwise it would have
been a test of `pointerleave` wearing a staleness test's name.

## 9. What item 9 caught, twice

The rule added last session — *a feature reachable through the session is tested
through the session; a UI milestone is not complete until a committed browser
check covers the interaction* — was mechanical for the first time this milestone,
and it fired twice.

First, immediately after the session wiring: four operations with no
session-level test (`addProbe`, `removeProbe`, `clearProbes`, `readProbe`) and
three controls no browser check touched (`#clearprobes`, `#probepick`,
`#probequantity`).

Then **again**, after the first round of tests was written — because those tests
had gone through `ProbeSet` directly rather than through the session, so
`removeProbe` and `clearProbes` were still uncovered at the layer the app uses.
That is exactly the failure the rule was written about: tests entering the
system one layer below where the app does. A person would have called it covered.

## 10. What neither layer caught: running it

Both suites were green — 235 node tests, 20 browser checks — when the app was
opened by hand and a probe pinned inside the cylinder. Its chart said:

> P3 omega: **no samples yet — press Run**

after the run had already taken sixty-three steps. The probe *had* sixty-three
samples. They were all NaN, correctly, because the cell is inside a body — and
the plot, finding no finite point to draw, reported the one situation it knew
about: an empty history.

Nothing was wrong with the physics, the sampling, or the plot. What was wrong
was that **"nothing recorded" and "everything recorded is NaN" shared a
message**, which is this project's oldest failure mode in miniature: a readout
describing a state the app is not in. It told its reader to press a button they
had already pressed.

Neither layer could have caught it as written. The node tests exercise
`layoutSeries`, which correctly returns zero drawable points; the browser checks
pinned probes in fluid, because that is what a probe is for. The case needed a
probe in a wall *and* a run *and* someone reading the sentence. There is now a
check that does all three — and it fails if the message regresses.

Two smaller things from the same session: the pressure datum was eight wrapped
lines tall in a side panel, burying the numbers under it, and the probe rows
wrapped to five lines each. Both are only visible in a picture.

**The honest conclusion**: committed browser checks moved the failure rate a lot
and did not take it to zero. They assert what someone thought to assert. Opening
the thing and looking at it remains a different test, and the third milestone in
a row where it found something.

## 11. Deferred, explicitly

- **Probe markers as a drag target.** A pinned probe cannot be moved; it is
  removed and re-pinned. Dragging one would need hit-testing against the
  markers and a gesture that does not collide with the drawing tools.
- **Export.** The histories are the obvious thing to write to CSV, and that is
  M13's job, not a tangent here.
- **Wall vorticity as a first-class quantity.** The one-sided estimate at a
  surface is shown but not validated, and a proper treatment means a wall model
  rather than a probe change.
- **A second series on one plot.** Comparing two probes means switching between
  them today. Worth doing when there is a case that needs it rather than on
  spec.
- **Interpolated probes as an option.** Rejected as a default above; if a later
  milestone wants sub-cell readings it should be a deliberate mode that says so,
  not a quiet upgrade.
- **Boundary-inflow timestep coupling** — still open from M6, unchanged.

## What is worth remembering

**The reference was wrong, not the code.** The first Taylor-Green measurement
reported a max vorticity error of exactly 2.0 that refused to converge under
refinement. The instinct was to go looking for an index bug; the actual fault
was the analytic formula it was being compared against — `2 sin x sin y` instead
of `2 cos x cos y`. The non-convergence is what gave it away, and it is the
reason the rotation test exists alongside: a linear field has an answer nobody
can get wrong twice.

**Green is not the same as looked at.** Two suites passed and a probe in a wall
still told its owner to press Run after the run had happened. §10.

**Three quantities in this milestone needed a label before they needed a
value** — pressure and its datum, `Re_h` and its length scale, a solid cell and
its absence of fluid. In each case the number was easy and the honest name was
the work — item 8's shape again, and the first time it has been caught while
designing rather than while debugging.
