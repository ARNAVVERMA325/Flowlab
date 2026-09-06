# Browser checks

Optional. **`npm test` does not need them** — its glob is `tests/*.js` and does
not reach this directory, so a clone of this repository stays testable by
someone who has not installed a browser.

```
npm run browser     # these checks
npm run verify      # npm test, then these
```

They skip with instructions when Playwright is absent, rather than failing.

## Setup

```
npm i --no-save playwright-core
npx playwright install chromium
```

`--no-save` is deliberate: Playwright is not a project dependency. If your
browser lives somewhere Playwright's own resolution will not find it, set
`FLOWLAB_CHROMIUM` to the binary, or `PLAYWRIGHT_BROWSERS_PATH` to the directory
holding them.

The checks serve the app themselves on a free port, so nothing needs to be
running first and they will not collide with a `npm run serve` you left open.

## Why they exist

Three integration bugs reached the running app past a green node suite. The
reason was structural rather than careless: **the node tests entered the system
one layer below where the app does.** They called `step()` and passed its
arguments explicitly; the app assembles those arguments in `SimulationSession`
and renders the result in `Harness`, and the bugs lived in the assembly and the
rendering.

| bug | what it needed |
|---|---|
| `SolverGeometryError` escaping into a `requestAnimationFrame` callback | a browser — `tick()` only exists inside the harness |
| sources compiled for the panel and never handed to `step()` | the session, reachable from node |
| `addSource` passing shape validation, then throwing from `draw()` | the session, reachable from node |

Only the first genuinely needs a browser. The other two are now also covered by
session-level node tests, which is the cheaper half of the fix. What a browser
adds that nothing else can is the run loop, the rendering and real pointer
events.

Each of the three is mutation-checked here: reverting the fix fails the check
that exists for it.

| mutation | check that fails |
|---|---|
| `tick()` stops catching `SolverGeometryError` | a domain the solver cannot solve reaches the banner, not the console |
| the session stops passing sources to `step()` | a mass source the panel shows is a mass source the solver runs; a brush stroke moves the fluid |
| `addSource` stops compiling the candidate | a source placed inside a wall is refused with a reason |

## What they assert

**Behaviour, not text.** The source bug produced no error and no obviously wrong
words — the panel faithfully reported a solver that was not running the source
it was drawing, and the only sign was the numbers coming out inverted. So the
assertions are on the physics and on the panel *agreeing with the solver*, read
together in one pass.

**Zero tolerance on page errors.** Every check ends by failing if the page
reported an uncaught exception or a console error. An exception thrown inside a
`requestAnimationFrame` callback reaches nothing an ordinary test looks at.

## A trap worth knowing

The first version of two of these checks used `await page.click(...).catch(() =>
{})` and `selectOption` with an id that did not exist. Playwright waits thirty
seconds for an element that never becomes ready, then throws — straight into the
swallowing `catch`. Both checks passed in 32 seconds having done nothing.

That is the same silent-no-op shape this project keeps finding elsewhere, so:
**no swallowing catches here.** If an interaction cannot happen, the check should
say so. Total runtime is about 35 seconds; a check taking tens of seconds is a
signal, not a cost of doing business.
