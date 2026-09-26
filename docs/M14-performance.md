# M14 — Performance

The roadmap asks for *Web Workers, WebGL/WebGPU, adaptive resolution. UI must
stay responsive; the sim loop must never freeze the app.*

The first thing done was to measure where the time goes. The answer decided
which of the three named techniques were worth building.

## 0. Where the time goes

Measured in the browser: the median and worst of 40 steps after warm-up, and
the median of 15 draws.

| scenario | cells | step (median / worst) | CG iterations | draw, smooth / cells |
|---|---|---|---|---|
| cylinder | 12,264 | **91.6 / 168.5 ms** | 310 | 9.4 / 5.6 ms |
| cavity | 4,096 | 19.9 / 44.5 ms | 185 | 9.3 / 3.3 ms |
| bend-sharp | 7,056 | 11.2 / 13.7 ms | 243 | 4.9 / 2.5 ms |
| bend-smooth | 7,056 | 10.4 / 18.1 ms | 229 | 4.5 / 2.5 ms |
| jet | 2,000 | 8.9 / 10.2 ms | 176 | 6.6 / 3.5 ms |
| pressure channel | 3,456 | 0.7 / 2.5 ms | 0 | 8.3 / 4.1 ms |

The frame budget is 24 ms. **One cylinder step blows it 4–7 times over**, and
the loop always takes at least one step per frame. So while the cylinder ran,
the page could neither repaint nor answer a click for 100–170 ms at a time.
**Drawing is never the problem:** 9.4 ms at worst. So:

- **the solver leaves the main thread (§1);**
- **WebGL rendering is not built (§3)**, because it would speed up something
  that already fits the frame;
- **a GPU solver is not built but flagged (§3)**, because it would change the
  numbers.

## 1. The solver runs in a Web Worker

The app's `SimulationSession` stays the authority for everything a person sees
and edits. A worker holds a copy that only steps (`ui/stepperCore.js`,
`ui/solverWorker.js`, `ui/remoteStepper.js`). The main thread draws whatever
state last arrived and never waits on the solver.

- **Handing the flow over.** At every Run, the worker gets the setup as a saved
  project (M13's format, reused) and the moving state from
  `captureState()`: the fields, dye, pathlines, clocks and last-step report.
  After every batch, the new state comes back and `installState()` puts it in
  place. `applyStepRecords()` then replays each step's residual and probe
  samples, so the charts keep one point per step. The pathlines' random
  generator used to live in a closure. It is now state that crosses too, with
  the same arithmetic.
- **Lockstep batches.** One batch is in flight at a time. The worker steps
  until 16 ms have passed, and always takes at least one step.
- **Edits made mid-run** (brush, boundary conditions, sources, probes) are
  applied here at once, so the picture answers immediately, and queued. The
  next batch carries them to the worker before it steps.
  - A proxy around the session does the forwarding, so no call site had to
    change.
  - Boundary undo/redo is sent as the specification it produced
    (`setBoundarySpec`), because the worker's edit history is not the app's.
  - The worker adopts the app's probe numbering, so readings land on the
    right probe.
- **Dye** is the exception, because a seed is a function and can't be sent. A
  batch computed before the dye was reseeded or cleared keeps the app's dye,
  and the next batch carries the app's dye to the worker.
- **Resets** (geometry edits, scenario changes, fluid, Re, Reset itself) bump
  an epoch. A reply computed before the reset is recognised and discarded, not
  painted over the new flow.
- **Failures** come back as data and are rebuilt as the same error class, so
  the app classifies them through the same `classifyRunFailure` as a failure
  on its own thread. The existing NaN-halting and failure-banner browser
  checks pass unchanged in worker mode.
- **Fallback.** Without module workers, or with `?compute=main`, everything
  runs on the main thread as before. If the worker ever faults, the run
  carries on here. The status bar says where the solver is running.

**It changes nothing about the simulation, and that is proved, not assumed.**
Node drives the real `StepperCore` through the real `RemoteStepper`, with a
fake Worker that clones and delivers asynchronously as `postMessage` does. It
edits the boundary, adds a probe and sets the brush mid-flight, then clears the
dye while a batch is in flight. The result must be **byte-identical** to the
same flow stepped directly with the same edits at the same steps: fields, dye,
pathlines, time, and residual and probe histories. It is. The browser check
does the same with the real Worker: it steps the cylinder in the worker, then
steps a fresh session on the page to the same count, and compares bytes.

**What it bought, measured on the cylinder over about 6 s:**

| | frames | p95 frame gap | worst gap | click → view changed | steps/s |
|---|---|---|---|---|---|
| main thread | 91–98 (~15 fps) | 114–142 ms | 124–215 ms | 1273–1329 ms | ~10.7 |
| **worker** | 380–384 (~60 fps) | **20–24 ms** | 52–60 ms | **96–116 ms** | ~9.8 |

About 8% of throughput is spent on the handoff, 6.2 ms per batch. It started
at 10.6 ms: the 300 pathline parcels were being cloned three times per batch,
and `captureState({copy: false})` plus `installState({owned: true})` now let
`postMessage` make the only copy. A bare-step benchmark shows the worker steps
at the same speed as the main thread (109 against 107 ms), so what remains is
the copy. The first worker version also repainted 60 times a second whether or
not anything new had arrived. It now redraws only when a batch lands; every
interaction draws for itself.

**Known gap: experiments still step on the main thread.** The M10 runner
decides after every single step, and a batch would end a run on the wrong
step. A cylinder experiment therefore still draws at about 10 fps, as before
M14. The fix is to run the runner inside the worker and mirror its state. That
is designed but not built.

## 2. Adaptive display resolution

The smooth renderer's budget of 120k buffer pixels was measured on one
machine. The renderer now times its own smooth frames. When the running
average passes 12 ms it halves the budget, down to a floor of 15k (two pixels
per cell on the cavity). When the average drops under 4 ms it doubles back,
never past the measured default. The status bar shows the render time and the
pixels per cell. On this machine it stays at the default.

**Only the display's resolution adapts. The simulation's grid never does.** A
coarser grid is a different computation, not a cheaper picture of the same
one, and it would move every validated number.

## 3. What was measured and not built

- **WebGL / WebGPU rendering.** Drawing takes at most 9.4 ms of a 16 ms frame,
  and with the solver gone, drawing is all the main thread does. A GPU renderer
  would speed up the part that already fits. The adaptive budget covers slower
  machines at a fraction of the complexity.
- **A GPU solver, or a preconditioned pressure solve.** The cylinder spends
  its step in 310 conjugate-gradient iterations. A multigrid or
  incomplete-Cholesky preconditioner, or a WebGPU solver, would likely cut the
  step several-fold, but **every one of them changes the arithmetic**.
  WebGPU compute is float32. A preconditioner changes the iterates. Either
  would break the byte-identical golden fields, and the validation record
  would need re-running. Per the project's rule, numerics are not changed
  without asking, so this is **flagged for a decision rather than done.** It
  is the largest remaining speed-up.

## 4. Tests

- `tests/test24_m14_worker.js` has 12 tests covering:
  - the exact handoff, including the pathline generator;
  - the size check;
  - step records replayed as charts;
  - core versus direct stepping;
  - stale epochs and unforwarded calls;
  - the full asynchronous protocol with edits and dye mid-flight;
  - a brush already held when Run is pressed;
  - a reset discarding an in-flight batch;
  - a worker failure coming back as the same error;
  - the proxy's forwarding and invalidation;
  - whole-spec boundary replacement;
  - the adaptive budget.
- Two browser checks:
  - the real Worker against the main thread on the same page (byte-identical
    flow, and p95 frame gap under half);
  - adaptive display resolution with the grid untouched.
- The existing 41 browser checks all pass in worker mode, which is now the
  default.

Twelve mutants were run: keeping the dye, the epoch check, invalidation on
reset, forwarding a boundary edit as its specification, applying forwarded
calls, adopting probe numbering, the held brush, the generator state, the dye
array, replaying probe samples, and budget halving. All twelve are killed. The
held brush survived at first, because every test set the brush after Run. A
test now holds it from the start.
