# M10 — Experiment mode

The roadmap asks for *guided scenarios: pipe flow, flow around a cylinder,
sharp vs. smooth bend, Reynolds-number sweep.*

An experiment here is a question a person could ask of a fluid, answered by
running the solver and **measuring**. Each measurement is then set beside
whatever reference exists, together with a plain statement of how much that
reference can be trusted. The four questions are in `experiments/definitions.js`.
The loop that runs them is `experiments/runner.js`, and the Experiments card
at the top of the right sidebar presents them.

---

## 0. What came out

Measured on a headless run in this container. The in-browser numbers are the
same because it is the same code; only the wall-clock time differs.

| Experiment | Runs | Result |
|---|---|---|
| **Pipe flow** | pressure channel, from rest to steady (t = 18.1, 4 s) | mean velocity 1.003 vs dp·w²/(12μL) = 1.000; worst profile error 0.17% of the centreline speed; wall shear 0.3000 vs 6μU/w = 0.3010 — **all three agree** to 1% |
| **Cylinder wake** | Re 20 and Re 40, each to steady (about 95 s each) | L/D = 0.750 and 1.745; growth 2.33× vs 2.47× for the unbounded reference — **comparison only** |
| **Sharp vs smooth bend** | each averaged over t = 20–35 | pressure drop 1.55 ± 0.16 vs 1.17 ± 0.03 (**24% less** for the smooth bend); separation points on the walls 6.3 ± 1.2 vs 0.6 ± 0.8 |
| **Reynolds sweep** | cavity at Re 100, 400, 1000, each to steady (192 s in total) | vortex centre 0.5, 0.3, 0.6 cells from Ghia et al. — **all agree** to two cells |

## 1. Two ways a run ends, and neither is "after N steps"

**Steady.** The field has stopped changing. The runner measures
max|Δu|,|Δv| / Δt over the last step (`session.changeRate`) and compares it
with the scenario's own scale U²/L. This is the same criterion the M2 cavity
benchmark uses.

Every steady run also has a time cap. **A run that reaches the cap is recorded
as NOT steady**, with the rate it had reached. Its numbers are still shown, but
they are marked in both the record (`steady: false`) and the panel. They are
never presented as converged. The caps were set from measured times to steady
state: pressure channel 4 s; cavity at Re 100/400/1000 49/64/87 s; cylinder
about 105 s.

**Averaged.** Some flows never settle, and both bends at Re 200 are among them.
Earlier milestones measured them still shedding from the corner at t = 68 and
t = 91, so "run to steady" would only run until the cap and then report one
arbitrary instant. Instead, each bend is sampled every tenth step over a window
after the start-up transient and reported as a mean with its standard
deviation. Taking the difference between the two means is only fair with the
spreads shown next to them. The sharp bend's pressure drop varies by ±10% over
the window.

## 2. The Reynolds override, and where it is refused

A sweep needs the same flow at a different Re. `SimulationSession.setReynolds(Re)`
sets ν = U·L/Re from the reference (U, L) that each scenario has declared since
M9. Nothing else changes: the geometry, the boundary conditions and the
reference speed stay the scenario's own. The override survives `reset()`, is
cleared by `load()`, and throws on anything that isn't a positive finite
number.

**It is refused for the pressure-driven channel.** There the speed is an output,
U = dp·w²/(12μL). Changing ν moves U as well, so Re = UL/ν goes as 1/ν², and
asking for Re 40 would produce something else, labelled 40. The scenario now
declares `reference.speedSetByViscosity`, and `setReynolds` refuses when that
flag is set rather than mislabelling the run. This was caught while reading the
scenarios during testing, before any experiment tried it.

While an override is active, the title reads "Lid-driven cavity (Re 1000) —
running at Re 100". Before this change, a sweep ran at Re 100 under a heading
that said 1000. The validation panel also notes when a case is running away
from the Re its benchmark was set up for.

## 3. Sentences are written from the numbers

Every summary that states a direction ("the bubble grew", "the smooth bend
separates less", "the vortex moved down and towards the middle") is computed
from that run's measurements. The first drafts of three of them were
unconditional: they described the expected physics, and would have printed the
same words over opposite data. The tests now feed each summary the reversed
case and check that the sentence changes with it:

- `conclude` for the cylinder says "did NOT grow" when L(40) ≤ L(20).
- The bends say "did NOT reduce separation" when the smooth bend has more
  separation points.
- The sweep describes only the motion it measured. If the centre wandered, it
  says so.

## 4. References, and how much weight each carries

- **Pipe** — closed-form plane Poiseuille flow. Nothing is transcribed, so this
  is a full pass/fail at 1%.
- **Sweep** — Ghia, Ghia & Shin (1982), marked VERIFIED in the registry. The
  table moved from `tests/support/ghia.js` to `validation/ghia.js` so the app can
  import it. The test file re-exports it, and a test asserts it is the same
  object, not a copy. The vortex-centre measurement moved to
  `physics/features.js` for the same reason, and the M2 test still gets
  (0.6172, 0.7422) through the re-export. The tolerance is two cells: the
  measurement is the cell of minimum speed, and Ghia's 129-point grid does not
  line up with this 64-point one.
- **Cylinder** — the reference lengths are for an **unbounded** cylinder and are
  themselves UNVERIFIED. This channel is 5.6 diameters wide (18% blockage). No
  pass or fail is claimed; the panel says "comparison only" and explains why.
  The direction of the trend is what should survive confinement, and it does.
- **Bends** — no external reference. Loss coefficients in the literature are for
  turbulent pipe elbows, not a laminar 2D duct at Re 200, and the summary says
  so rather than quoting one.

## 5. The app, and what interrupts an experiment

The runner never steps the solver. Whoever owns the loop calls
`session.advance()` and then `runner.afterStep()`: in the app that is the
harness's frame loop, and in the tests it is a `while` loop. So a whole
experiment can run in node, and the pipe experiment does, end to end, in the
test suite.

Experiments step at up to 40 solver steps per frame within a 90 ms budget,
against 4 steps and 24 ms for ordinary running. The display redraws every
frame, so the flow stays visible while it converges.

**A person's own action stops the experiment.** That covers Reset, a scenario
change, a geometry edit, a boundary edit, placing or clearing a source, and the
brush. The experiment could not have set up the flow those actions produce, so
nothing is reported from it. The status line names the action. The first
version cleared that reason on the next repaint, and the browser check written
for it caught this (§6).

## 6. Found by running it

- **The first browser run crashed as soon as it drew results**
  (`show is not defined`). The formatter had been lost in an edit, and nothing
  in node imports the harness. It is now in `ui/format.js` with a test.
- **The interruption reason vanished.** The panel repaints every frame, and the
  reason was held in a one-shot field that the first repaint cleared. It is now
  stored on the runner. A mutant that restores the clearing fails the browser
  check.
- **The pressure-channel Re override** (§2).

## 7. Tests

`tests/test20_m10_experiments.js` has 22 tests covering:

- the override: ν = UL/Re on a scenario with L ≠ 1, that the solver's timestep
  sees it, and the refusals;
- the change rate;
- every way a run can end: steady, capped, averaged, stopped, failed;
- the definitions;
- the reversed-data summaries;
- `physics/features.js`.

Four browser checks drive `#experiment`, `#expstart` and `#expstop`:

- describing an experiment starts nothing;
- the pipe experiment finishes with three "agrees";
- a sweep run is at the Re it claims, and Stop ends it;
- Reset interrupts it, and the reason survives later frames.

Fourteen mutants of the runner, the override, the change rate, the summaries
and the features were all killed.
