# M13 — Import / export

The roadmap asks for *save and load projects, export data/CSV/images/graphs.*

## 0. A project is the setup, and that is enough

A saved project (`io/project.js`, `.json`) holds:

- the scenario;
- the drawn geometry document;
- the boundary conditions;
- the placed sources;
- the probe positions;
- the fluid or Reynolds number;
- the view: mode, overlays, colour map, cell/smooth rendering, equation term.

It does **not** hold the flow field, and it doesn't need to. The solver is
deterministic, so the same setup run the same number of steps gives the same
field to the last bit. The central test demands exactly that. It builds a
session with drawn geometry, a changed wall, a momentum source, two probes and
air, saves it, loads it into a fresh session, runs both for 40 steps, and
requires u, v and p to be **byte-identical**. They are. That says more about a
saved project than "the arrays were written out and read back". It also keeps
a project small: under 5 kB, against 306 kB of raw u, v and p for the largest grid (the cylinder).

## 1. Loading is validated by building it

`SimulationSession.importProject(project)` first applies the whole project to
a scratch session, through the same operations an edit in the app goes
through: geometry append, boundary set, source add, fluid set. So a geometry,
boundary condition, source or fluid that the app would refuse is refused here
with the same message. Only if every part succeeds is the project applied to
the real session. A refusal therefore leaves the session exactly as it was,
not even reset, and the test checks this for ten kinds of bad file:

- invalid JSON;
- the wrong format;
- the wrong version;
- an unknown scenario;
- a bad probe list;
- a fluid and an Re together;
- an unknown geometry primitive;
- an unknown boundary type;
- a source that selects no face;
- a fluid the grid cannot resolve.

## 2. Exports

All exports are in `io/export.js`, and all of them are pure, so node tests
the content:

| button | file | contents |
|---|---|---|
| Field CSV | `…-field.csv` | one row per cell: i, j, x, y, solid, u, v, speed, p, vorticity |
| Probes CSV | `…-probes.csv` | one row per step, a column per probe × quantity |
| Residuals CSV | `…-residuals.csv` | the residual chart's data, per step |
| Experiment CSV | `flowlab-experiment-….csv` | comparison rows with verdicts, then how each run ended |
| Image PNG | `…-<view>.png` | the field as drawn, with a band holding the title, time and legend |
| Charts PNG | `…-charts.png` | the residual and probe charts, stacked |

The exports follow the same two rules as the readouts:

- **Full precision.** Numbers are written with `String(x)`, the shortest text
  that reads back as the identical double. The test reads every pressure back
  from the CSV and compares with `===`. The pipe experiment's exact reference
  is written as `0.9999999999999999`, which is the double it is, not a tidied
  `1`.
- **A bad value is what it is.** NaN is written `NaN`, never a blank or a zero.
  Solid cells stay in the file, marked `solid = 1`.

Every file opens with `#` lines of provenance:

- the scenario, Re, step and time;
- the fluid and its physical scale, or "scenario units";
- whether the pressure is a gauge;
- for residuals, the bound.

A CSV without them is a column of numbers nobody can interpret a week later.
Fields containing commas are quoted, and a test checks that the columns stay
aligned.

An image without its scale is a picture, not a result, so the PNG carries the
legend. The browser check asserts the image is the field canvas plus the 64 px
legend band.

## 3. Tests

- `tests/test23_m13_import_export.js` has 9 tests:
  - the byte-identical round trip;
  - a Reynolds-number project;
  - the ten refusals leaving the session untouched;
  - what a project contains;
  - the field CSV at full precision;
  - NaN written as NaN;
  - the probe, residual and experiment CSVs.
- Three browser checks drive `#projsave`, `#projfile`, and every export button
  through real downloads:
  - save, go somewhere else, load back (scenario, fluid, view mode and overlay
    restored);
  - a broken file refused with its reason and nothing changed;
  - each export offering the file it names, with its data, and never stepping
    the run.

Five mutants were run: loading without the scratch-session validation,
dropping the probes, dropping the sources, exporting at 12 significant figures
with NaN as a blank, and not quoting fields that contain commas. All five are
killed.
