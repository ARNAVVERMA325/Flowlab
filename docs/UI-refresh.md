# UI refresh — layout, colour, rendering

The request, verbatim in intent: *improve the UI, the mechanism, higher quality
of the system and fluid, accurate colours instead of sharp yellow and blue, and
take the UI from the reference images.*

That overrides working-agreement item 5 — "do not build from the reference
images" — for this piece of work. The override is the user's to make and it is
recorded in `docs/roadmap.md` beside the rule, so the rule's history is visible
rather than quietly relaxed.

Three things changed, and each replaced a choice that had been made on purpose.
Those reasons are stated with what replaced them, because the old choices were
not mistakes and the new ones have costs.

---

## 1. Layout

After `ui-reference.png`: a full-height app shell rather than a scrolling
document.

- **Top bar** — brand, scenario, transport (Run / Pause / Reset), and the
  readouts the reference puts there: status, simulated time, Δt, iteration.
- **Left sidebar** — the reference's tool column: geometry tools with icons,
  boundary conditions, sources and brush, fluid properties, simulation
  settings, and the dye tracer.
- **Centre** — the field on a dark, faintly gridded stage, with its legend and a
  scale bar underneath; the **visualization mode tiles** below it; then the
  reference's three cards: **Residuals**, **Monitor points**, **Quick metrics**.
- **Right sidebar** — probes (with "+ Add probe"), the validation record, and an
  **Explanation** card that carries the view's note.
- **Status bar** — run state, the method, and a measured frames-and-steps rate.

**Every element id the harness and the browser checks rely on was kept** — the
id diff between the old and new page shows nothing dropped. What moved is where
each lives and how it looks.

The long explanatory paragraphs that are this project's signature — why the
brush speed is a control, why the pressure has a datum, what a probe reports —
were not deleted. They sit behind a *details* disclosure in the card they
explain, so the panel reads like the reference and the reasoning is one click
away.

### What the reference has that this does not

Left out rather than mocked up, because each needs a milestone that is not
built: New / Open / Save / Export (M13), the equation panel and term explorer
(M11), material presets (M12), turbulent kinetic energy (V3), wall shear stress
*as a view* (refused in M9 for curved bodies), and "WebGPU Active" (M14). A
button that does nothing is worse than no button.

### Residuals: one line, deliberately

The reference plots three residuals — continuity and two momentum. This plots
one, the per-step continuity error `max|∇·u − q|`, with the solver's tolerance
dashed across it. A projection method has **no momentum residual**: the
momentum equation is advanced explicitly, not iterated to convergence, so there
is nothing converging to draw. A second line would have been invented.

And the axis is **fixed**, four decades below the bound to three above. Fitted to
the data the chart was a scribble: every step converges *to* its tolerance, so
the series spans about a fifth of a decade (6.6e-8 to 9.98e-8 on the smooth
bend) and its rounding noise filled the whole height. That is the continuity
view's mistake from M8, made again one panel over and caught the same way — by
looking at it. On the fixed axis the truth reads correctly: a flat band just
under a dashed line.

## 2. Colour

### What it was, and why

Every magnitude was drawn in **one hue, monotone in lightness**, on the sound
principle that a rainbow invents boundaries that are not in the data. Signed
fields used blue against amber around a **dark** centre, so that nothing
happening receded into the page; pathlines were yellow. That is the "sharp
yellow and blue" the request named.

### What it is now

| field | ramp | source |
|---|---|---|
| velocity magnitude | **Turbo** (default) or **Viridis** | Mikhailov 2019; van der Walt & Smith 2015 |
| pressure, vorticity, shear, √Q, continuity | **Coolwarm** | Moreland 2009 |
| dye | unchanged single-hue green | — |

All three new tables are **generated from matplotlib's reference
implementation** at 33 stops and embedded, not transcribed. Linear
interpolation between the stops stays within 5.3/255 of the full 1024-entry map
for all three. matplotlib was installed in the working container only to
generate them; it is not a project dependency, and the node test checks the
published endpoints instead.

### The trade Turbo makes, measured

Turbo is what was asked for — the conventional CFD colours of the reference —
and it is the best version of them: jet's banding at cyan and yellow is removed.
It is still a rainbow. Its OKLab lightness runs **0.250 → 0.902 → 0.366**: up,
then down. In greyscale, in print, and for some colour-vision deficiencies, the
top of the scale reads like the lower middle.

So **Viridis stays one control away** — the colour-map selector under the
legend — monotone from 0.285 to 0.918, and the right choice whenever order has
to survive a photocopier. Each map's note, which the Explanation card shows, says
what it costs. The magnitude choice affects velocity only; signed fields have
one map.

### Coolwarm

Blue, a **neutral grey** at zero, red. Its two ends are matched in lightness
(0.475 and 0.487) so neither sign reads as stronger, and the midpoint is a grey
rather than a hue — which is what a diverging map should do, and what the
reference's vorticity and divergence panels show. The light midpoint is the
opposite of the old dark one: the eye reads "no deviation" as the absence of
colour.

### Everything else that is colour

- **Solids** are near-black with a light **outline** along the faces the solver
  treats as surface — the reference's treatment. The fill was re-chosen by
  sweeping candidates against every ramp (the same method as the previous fix);
  the binding constraint is still the dye ramp's dark end, now at 49.7 against a
  test threshold of 40. The outline does what no single fill can: it separates
  solid from fluid at every surface, whatever colour the adjacent fluid is.
- **Probe identities** are the validated categorical palette's dark steps, in
  its fixed order — run through the palette validator against this UI's panel
  surface: all eight pass on adjacent pairs, the first three all-pairs, and every
  probe carries its P-label beside its marker as the secondary encoding the rules
  require past three.
- **Pathlines** are near-white instead of yellow. Yellow sat on the brightest part
  of the new ramp — M8's invisible-arrows lesson, which would have recurred.

## 3. Rendering

### Smooth by default, cells one checkbox away

Until now one cell was one flat block, on the principle that the resolution the
answer was computed at should be visible. That principle stands, and **"show
computed cells"** restores exactly that picture. The default is now smooth,
because a higher-quality fluid picture was asked for. Three rules keep it honest:

1. **Values are interpolated, never colours.** Blending two Turbo colours passes
   through hues that belong to neither value — blue and yellow average to a grey
   that means nothing on that scale.
2. **Only fluid cells contribute.** A solid slot holds a ghost or nothing; letting
   it into the stencil paints a dark halo along every wall that reads as a
   boundary layer the flow does not have.
3. **Solids stay crisp at cell resolution.** The staircase *is* the domain the
   solver is solving; drawing the smooth circle it approximates would show a
   shape that is not being simulated — M5's rule, applied to the picture.

And the oldest rule survives it: a non-finite cell paints every pixel whose
stencil touches it in the not-finite colour. A NaN spreads; it is never averaged
away. Both rules are mutation-tested — letting a solid into the blend, or
ignoring a broken value, fails the node test.

### The cost, and what it was spent on

Measured on the 64×64 cavity drawn at 14 pixels a cell, with the canvas flushed
after each render so deferred work is counted:

| buffer | blit quality | ms per render |
|---|---|---:|
| 4 px/cell | low (bilinear) | 6.6 |
| 6 px/cell | low | 9.6 |
| 8 px/cell | low | 15.3 |
| 14 px/cell (every display pixel) | — | 36.4 |
| 4 px/cell | high | 23.1 |
| flat cells | nearest | 1.1 |

Two findings. Rendering every display pixel is the **slow** option, not the
careful one — the loop costs about 45 ns a pixel. And "high"-quality resampling
cost **16 ms on its own** for no visible gain on a field that is already smooth.
The renderer now fills a fixed budget of about 120k buffer pixels and lets the
browser's plain bilinear upscale do the rest. That final step does blend
colours — rule 1 forbids that *between cells* — but here it blends buffer pixels
a quarter of a cell or less apart, whose colours are already nearly equal.

A full frame on the cavity went from 26 ms to 15 ms with the budget, against
4 ms for flat cells.

## 4. What the refresh found

**A wrong highlight, present since M6.** The tool list highlighted the drawing
controller's tool, which is parked on "select" whenever a tool that makes no
geometry is armed. So arming the brush, the source placer or the probe has
always shown **Select** as active. Found by the new check for "+ Add probe",
which asserts what the tool list shows.

**Four checks that timed the wrong thing.** The brush check failed
intermittently after the refresh made frames heavier: it waited 700 ms and
expected the fluid to have responded, so its verdict depended on how many
solver steps fit in 700 ms on that machine. Three more checks had the same
shape — a fixed wait, then a demand for a number of steps. All four now wait for
**solver steps** (`runForSteps`), which is what their claims are about.

**The tint callback counts.** Evaluating the drawing preview's tint per *pixel*
in the smooth renderer would have multiplied the preview's promised cell count
by the square of the subsample factor, because that callback also counts the
cells a shape will change. It is evaluated once per cell, and the browser check
that holds the mask to the promise passed first time because of it.

**A hard-coded colour in a check.** The continuity check measured distance from
the old ramp's dark centre as a literal. It passed against the new ramp for the
wrong reason and would have gone on meaning nothing; it now reads the centre from
the module the renderer uses.

## 5. Not changed

The solver, its numerics and every validated number. No golden field moved. The
performance of a solver step is unchanged — the cylinder still takes 90 to 110 ms
a step, which is the pressure solve on its largest grid and belongs to M14.
