# M11 — Equation explorer

The roadmap asks for *governing equations in the UI; click a term (`∂u/∂t`,
`u·∇u`, `−∇p`, `μ∇²u`, `f`) to get an explanation **and** a highlight of where
that effect currently dominates.*

The explanation is the easy half. The highlight makes a claim about the flow
on screen ("viscosity dominates here"), and that claim is only worth anything
if the viscosity in the picture is the viscosity that moved the fluid. So the
milestone is built around one checkable fact: **the budget closes**.

---

## 0. The budget closes, to rounding

`physics/momentumBudget.js` computes each term of

```
∂u/∂t  =  −(u·∇)u  −  ∇p/ρ  +  ν∇²u  +  f
```

on every face the solver updated in its last step. Four of the terms use the
solver's own stencils, applied to the state the solver actually used:

- the start-of-step velocity, with its ghost values rebuilt by the same
  boundary pass `step()` runs first;
- the pressure the projection produced;
- the source relaxation and body force the step was given.

The fifth, `∂u/∂t`, is **not computed**. It is measured as the change the step
made divided by its timestep. The two sides must then agree:

| scenario | largest term | max \|∂u/∂t − Σ others\| | relative |
|---|---|---|---|
| bend-sharp | 12.6 | 1.7e-14 | 1.4e-15 |
| bend-smooth | 11.2 | 1.5e-14 | 1.3e-15 |
| cylinder | 2.79 | 1.2e-14 | 4.4e-15 |
| cavity | 11.3 | 1.4e-14 | 1.2e-15 |
| pressure-channel | 0.60 | 1.6e-14 | 2.6e-14 |
| jet | 1.30 | 1.5e-14 | 1.1e-14 |

The same holds with a momentum source, a source-sink pair and the brush all
running, and with a body force and ρ ≠ 1 (`tests/test21`). The panel prints
this number under every term ("Budget check: … to 4.5e-15 of the largest
term") and turns red if it ever exceeds 1e-9.

**Why the ghost pass matters.** After a step, the wall ghost values are *not*
what the next step's boundary pass makes them: measured up to 0.10 in the
cavity. A budget taken from the stored field as-is would use different wall
values from the ones the solver used, and would fail to close next to every
wall. Removing that pass is one of the mutants below, and the closure tests
kill it.

**Why the inputs are captured at step time.** A boundary edit or a brush
stroke between a step and the next repaint would otherwise have the budget
describe a step with a different right-hand side from the one that ran. The
session keeps the `bc` and parameters each step was given. Both are frozen or
rebuilt on change, never mutated, so holding the references is enough.

**Advection is computed in conservative form**, ∇·(uu), because that is what
the solver computes. It equals (u·∇)u only where ∇·u = 0, which the
projection holds to its stated bound, and the explanation says so.

## 1. "Dominates" needs a margin, and got one

The first version named whichever term was largest in each cell. It reported
the steady pressure-driven channel as **pressure-dominated in 100% of cells
and viscous in 0%**. Plane Poiseuille flow is exactly a balance between
pressure and viscosity: the two terms are equal and opposite on every face,
and "largest" was being decided by the last bit.

This is the same failure as M9's bare Q > 0 test, and it gets the same fix. A
term **dominates** a cell only when it is more than 10% larger than the next
largest. Anything closer is reported as a **balance**, naming both terms.
Cells whose five terms together are below 1e-6 of the busiest cell are left
out as still. The rule is printed under the equation.

What that gives, measured:

- **Developed channel**: every cell is a pressure + viscous balance, and
  pressure "dominates nowhere". Advection is 1.9e-7 of the largest term. It is
  not zero, because v and ∂u/∂x are only as small as the continuity bound
  allows.
- **Cylinder at t ≈ 5**: advection dominates 65% of the moving fluid and is
  balanced with pressure in most of the rest. That balance is Euler's
  (u·∇)u = −∇p/ρ in the nearly inviscid free stream. It appears in the picture
  as a flat mid-scale share across the channel.
- **Cavity, from rest to t = 1.5, at three Reynolds numbers**:

  | Re | Σ\|advection\| / Σ\|viscous\| | viscous dominates | pressure dominates |
  |---|---|---|---|
  | 10 | 0.074 | 15.8% | 17.3% |
  | 100 | 0.58 | 14.1% | 50.3% |
  | 1000 | 1.87 | 3.9% | 45.6% |

  The ratio grows 25× for a 100× rise in Re: steeply, but not in proportion,
  because at high Re the boundary layers thin and ∇²u grows with them. The
  test asserts the ordering and a factor above 10, not proportionality.

## 2. In the app

The **Equation explorer** card sits under the view tiles. The momentum
equation is written out in ρ/μ form. Each term is a button, and clicking one:

1. switches the picture to that term's **share** of the budget: |term| over the
   five together, per cell, on a fixed 0–1 scale in viridis (monotone in
   lightness, so more of the term reads as brighter);
2. **outlines** the cells where it dominates by the margin, with a light line
   over a dark one so it reads at both ends of the ramp;
3. shows what the term means physically, and a paragraph written from the
   measured shares: where it dominates, what it is in balance with, and which
   term leads the flow if this one doesn't;
4. prints the closure check.

`∇·u = 0` is written under the equation as a button too. It has no budget,
because it is the constraint the pressure exists to enforce, so clicking it
opens the continuity view that shows how well it holds.

The budget is a second pass over the field, so it is only computed while the
term view is showing, once per step however many frames ask for it. Every
other view costs exactly what it did before. Before the first step there is
no budget (it describes a step), and the panel says so instead of drawing
something.

Shares are the same in ρ/μ form and per unit mass: ρ multiplies every term.

## 3. Tests and mutants

`tests/test21_m11_equation_explorer.js` has 18 tests covering:

- closure in every scenario, with sources and the brush, with a relaxation
  clamped to one step, and with a body force;
- the ghost premise;
- a boundary edit after the step;
- that the budget writes nothing and is cached per step;
- the channel balance, and the Re trend;
- still water, the margin and the balance naming, and a tiny-but-nonzero
  cell counted as quiet;
- face averaging, the quiet threshold, the sentences, the outline, and the
  field view.

Three browser checks cover:

- every term button, each painting a different picture from a budget the page
  shows closing, with no step taken;
- the constraint button, and the tile defaulting to advection;
- the no-budget state before the first step.

Seventeen mutants were run: the ghost pass, two stencil offsets, the pressure
term's 1/ρ, the body force, the source clamp (u and v), a missing viscous
component, the margin, the quiet threshold, the face averaging, the
captured-inputs rule, the outline, the leader sentence and the unknown-term
guard. All seventeen are killed. Two survived the first run: the source clamp
(every test source relaxed slower than a step) and the quiet threshold (the
only quiet cells were exact zeros). Each now has a test that exercises it.
