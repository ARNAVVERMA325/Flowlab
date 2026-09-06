# M5 — Interactive geometry

Working agreement item 7: *document the numerical method chosen and why —
stability, accuracy, implementation cost, and room to expand.*

The pipeline the roadmap asks for:

```
user geometry → grid/mesh → boundary conditions → solver → visualization
```

What "grid/mesh" means here is stated plainly up front, because the word
invites a bigger claim than the code makes: **drawn shapes are sampled onto the
existing uniform staggered grid.** Cell centres are tested against a region and
the cell is solid or it is not. There is no mesh generation, no cut cells, no
body-fitted anything. A drawn circle is a staircase to about one cell, exactly
as `stampCircle` always was. Everything downstream — the solver, the boundary
compiler, the validated cases — sees the same `grid.solid` array it has seen
since M0, which is what made byte-identity an achievable bar rather than an
aspiration.

---

## 1. Two circles, and what a comparison operator is worth

The first thing the work found was that this codebase already contained **two
different circle conventions**, and had since M0:

```
stampCircle      (x-cx)**2 + (y-cy)**2 <= r*r      squared distance, closed
the smooth bend  Math.hypot(x-cx, y-cy)  <  r      euclidean distance, open
```

A geometry model with one `disk` primitive has to pick one, and picking either
moves a benchmarked result. The initial explanation of the difference was the
*metric* — squared versus euclidean, a plausible story about floating-point
rounding in `hypot`. It was wrong, and mutation testing is what said so: a
mutation deleting the squared branch entirely **survived**.

Decomposing it properly:

| what varies | cells changed on the cylinder body (113 solid) |
|---|---|
| metric alone (squared vs euclidean) | **0** |
| boundary convention alone (`<=` vs `<`) | **3** |

Across 1,152,000 samples over 40 circles the two metrics disagreed on **not one
cell**. The entire difference is the three cell centres that land exactly on the
radius — `(43,31)`, `(37,37)`, `(43,43)` on the cylinder grid — and whether a
point on the boundary is inside it.

Three cells out of 113 is enough to move a benchmarked wake length. So both
conventions are kept, and both are **required to be stated**:

```js
{ kind: "disk", cx, cy, radius, metric: "squared", closed: true }
```

No defaults. A document records which expression it was built against, and
`validateDocument` refuses a disk that does not say. The `metric` parameter has
no measured effect and is kept anyway, for a reason worth stating: no
behavioural test can catch its removal, because on this engine nothing
distinguishes the two. `Math.hypot` is not required to be correctly rounded, so
the observed equivalence is a property of this JavaScript engine rather than a
guarantee. A cross-version canary test names the three cells and will fail on an
engine where that stops being true.

The alternative — unify on one convention, accept a three-cell change, regenerate
the cylinder benchmark — was offered and declined. The cylinder's continuity
since M0 is worth more than a tidier predicate.

## 2. Geometry as a document

A geometry is an ordered list of operations, not a mask:

```
document   { operations: [ { op: "add" | "subtract", region, label? } ] }
region     a primitive, or { all: [...] } | { any: [...] } | { not: region }
primitive  { kind: "disk" | "halfPlane" | "rect" | "polygon", ... }
```

`add` marks solid where the region holds; `subtract` clears it; later operations
win. That is the painter's model a drawing tool produces, and it is also
expressive enough for the analytic regions the existing scenarios use, which are
unions of intersections.

**Boolean composition introduces no arithmetic.** `all`, `any` and `not` are
pure logic over the primitives' results, so the only float-sensitive step in
sampling a document is the single comparison inside each primitive. That is what
makes byte-identity achievable at all: a document that is *structurally* a
different expression of the same predicate samples to the same bits, not merely
to the same answer within tolerance.

Each primitive states its own conventions explicitly:

- `disk` — `metric` and `closed`, both mandatory (§1).
- `rect` — half-open by default, closed on its low edges and open on its high
  edges, so abutting rectangles tile without overlap or seam. Each edge's
  comparison can still be named.
- `halfPlane` — one axis, one explicit comparison from `< <= > >=`. Never
  normalised: here `<` and `<=` are separate comparisons and the difference is
  not marginal.
- `polygon` — even-odd ray casting along `+x`. Its convention is stated *and*
  its limit is: a point exactly on an edge is **not** reliably classified,
  because the test compares a floating-point intersection abscissa. No scenario
  depends on a polygon, so nothing is pinned to it — but a drawing tool puts
  vertices on cell centres often, so it is worth knowing.

`label` is optional, carries no meaning to the sampler — `sampleDocument` reads
`op` and `region` and nothing else — and exists so the UI's shape list can say
"cylinder" rather than "any of 3".

## 3. The two gates

The six validated scenarios are expressed as documents and become a specific
case of the new system, not a legacy path. Both gates were held:

**Gate 1 — the mask.** Each document is sampled on the exact grid its scenario
uses and compared cell for cell against the hand-written predicate it replaces:

| scenario | cells | differing |
|---|---|---|
| cylinder | 113 solid of 12264 | 0 |
| sharp bend | 5184 solid of 7056 | 0 |
| smooth bend | 5277 solid of 7056 | 0 |

**Gate 2 — the fields.** `tests/fixtures/golden-fields.json` — SHA-256 of `u`,
`v` and `p` after 30 steps, generated from the solver before any M4 work —
comes back byte-identical for every case.

A detail worth recording from gate 1: **no cell centre lands on a bend radius**
across `cpw` 4 to 32, so on the bend `<` and `<=` are indistinguishable by
sampling. The bend's convention is therefore pinned by a structural test — its
`d > ro` is expressed as `not(closed disk)`, the complement of a *closed* disk
rather than an open one — and not by a cell count that would silently pass
either way. The solid fraction converging to 0.747833 under refinement (0.748299
at 6cpw, 0.747874 at 12, 0.747839 at 24, 0.747786 at 48) is the separate check
that the region is the intended one at all.

## 4. Disconnected fluid regions

Drawing a wall across a channel splits the domain, and the pressure Poisson
operator on a domain with two disconnected pure-Neumann regions has a
**two-dimensional null space** — one constant per region — where the solver's
`projectToZeroMean` removes only one.

The prediction was that this would break. **It did not**, and demonstrating
before designing is what established that. Sealed chambers (symmetric and
asymmetric), sealed pockets, an off-centre dividing wall: all run normally over
300 steps. A centred wall gives per-region mean pressures of 7.6e-18 and
7.6e-18 at max|div| 9.8e-8; an off-centre one gives 5.7e-15 and -2.1e-15 at
8.3e-8. Conjugate gradients started from a consistent right-hand side stay in
the range of the operator; the per-region constants are simply never excited.

The real problem was narrower and elsewhere: **flux balance was global.** A
single net-flux correction spread over all outflow faces cannot balance two
regions that each need a different correction. That is now per-region and
sign-aware:

```js
for (let r = 0; r < regionCount; r++) {
  if (outflowCounts[r] === 0) continue;
  deltas[r] = -nets[r] / (outflowCounts[r] * h);
}
for (const f of faces) f.arr[f.k] += f.sign * deltas[f.region];
```

Measured: a domain whose lower half carries 0.9167 and upper half 0.4583 now
runs at max|div| 8.64e-8.

Regions are found by **4-connectivity** flood fill — a diagonal touch is not a
connection, because two cells meeting at a corner share no face and no flux can
pass between them.

Three outcomes, and they are different:

- **Sealed region** — valid, reported, not rejected. A sealed chamber is a
  perfectly good thing to draw and it runs.
- **Region with an outlet or a pressure boundary** — normal.
- **Region carrying net flux nothing in it can absorb** — rejected with a
  diagnostic naming the region and the divergence it would force. The message
  says what to do about it.

Per-region *pressure solving* stays deferred: nothing measured requires it.

## 5. Boundary conditions on drawn surfaces

M4 attached conditions to domain edges. M5 attaches them to drawn solid
surfaces, selected by a region rather than by naming faces — a `where` region
that picks the faces it contains, which stays valid when the shape underneath
it moves.

The split is by **geometry, not by wishful approximation**:

| surface | conditions allowed |
|---|---|
| axis-aligned segment | the full M4 set — wall, free-slip, inflow, flow-rate inlet, pressure, outflow, zero-gradient |
| staircase (mixed normals) | wall and free-slip only |
| flux-prescribing condition on a staircase | **rejected with a reason** |

A staircase surface has no single normal. Prescribing a flow rate through it
would require deciding what fraction of the requested flux each facet carries,
and any answer to that is invented. Refusing is the honest option; the
alternative approximates and looks like it worked.

Measured on drawn surfaces: a blowing face delivered `0.150000000000` against a
requested 0.15 at max|div| 9.40e-8; a surface pressure of 1 → 0 drove a peak
speed of 0.4245; free-slip on a block ran 72.3% faster over it than no-slip; a
surface moving at u = 1 dragged the fluid above it to 0.6405 against 0.0 when
stationary.

## 6. One bug shape, six instances, and a detector

Three separate flux-balance bugs turned up over consecutive steps, and they
were the same bug wearing different clothes: **a sum filtered on a proxy
property instead of on the property of interest** — `type === "outflow"`,
`!solid[...]`, "is this a domain side" — where the question actually being asked
is *does this face carry flux*. Each was correct until a later feature broke the
coincidence.

A deliberate hunt for the shape found three more:

| site | what it reported | what was true |
|---|---|---|
| `measureBoundaryFlux` | net −0.300 | net 6.11e-16 (balanced) |
| `analyseRegions` | "sealed — nothing enters or leaves" | had a pressure boundary on a drawn surface |
| tracer `advance()` | dye +70.4% over 400 steps | dye conserved; it skipped every solid-adjacent face, which since §5 can carry real flux |

Six patches would have left the seventh. The fix is a **detector that measures
the consequence instead of auditing the causes**.

Every row of the pure-Neumann pressure operator sums to zero, so for the
discrete Laplacian `sum(residual) ≡ sum(rhs)` at every iteration. An
inconsistent right-hand side therefore sits in the RHS *unchanged*, whatever
caused it — and `projectToZeroMean` is exactly what hides it from the reported
residual. So the check is made on the accumulated per-region RHS, before the
projection:

```js
const forcedDivergence = (Math.abs(regionSums[r]) * dt) / (rho * cellCount);
if (forcedDivergence > divergenceTol) unsolvable.push({ region: r, cellCount, forcedDivergence });
```

Healthy configurations sit at 1e-17. The surface-inflow bug showed 5.28e-2
against an actual divergence of 5.28e-2 — it measures the thing itself, not a
signature of one cause. Mutation-checked against all three original bug shapes
and against disabling the check: each is caught. Regions carrying a prescribed
pressure are exempt, because their operator is not singular and the row-sum
identity does not hold for them.

Two pre-existing failures this exposed, both of which had been reporting healthy
numbers:

- opposed outlets: reported 8.115e-8, actual max|div| **2.950e-1**;
- an all-zero-gradient domain: reported 9.889e-8 and "converged", actual
  **1.206e-2**.

Both are now rejected with a reason rather than reported as fine.

## 7. What happens to the field when the geometry changes

**The field is discarded and the run restarts.** Not repaired, not carried over,
not animated.

The tempting alternative is to keep the flow and patch the difference: zero the
cells that became solid, seed the ones that became fluid, carry on. It would
look continuous and it would be wrong in a way that is hard to see. Cells that
became fluid have no history to carry; cells that became solid were carrying
momentum that has to go somewhere; and the patched field is not divergence-free
anywhere near the change, so the next step would solve from an initial condition
that satisfies nothing. The divergence bound `step()` promises would be met,
technically, about a field nobody should read.

The reason underneath: **a domain that changes shape while fluid moves through
it is a moving-boundary problem, and this is a fixed-grid method.** Animating
the transition would be inventing behaviour the simulation did not compute —
the same failure as fake turbulence in different clothes.

So: an edit stops the run, the mask is resampled, and the scenario is *rebuilt*
so the initial condition is exactly what the scenario specifies rather than an
approximation of it reconstructed elsewhere. The document is handed to the
builder rather than applied afterwards, so cells an erasure exposes hold the
seeded stream instead of whatever their array slots contained.

The guard is mechanical, not disciplinary:

```js
get fieldIsStale() {
  return this.scenario.grid.maskVersion !== this.maskVersionAtReset;
}
```

It asks the **grid**, so a mask changed by any route counts — including one
changed behind the session's back, which is what the adversarial test does.
Stepping a stale field is refused with an error, not merely discouraged.

Undo is **snapshot-based**, not inverse-operation-based. An inverse scheme has
to get every inverse right, and one wrong inverse corrupts the document silently
and only on the undo path — the code exercised least and trusted most.
Documents are tens of shapes; a snapshot costs nothing worth optimising. Undo
and redo across four masks reproduce them byte for byte.

## 8. Drawing

Two rules.

**The preview is the sampled result, not the drawn outline.** While a shape is
dragged out, the highlighted cells are the cells that will actually change,
evaluated with the same `testRegion` call the sampler will make on the same cell
centres. A smooth outline that then samples to a staircase promises something
the solver will not deliver, and the mismatch is worst exactly where it matters:
a thin feature that looks drawn and samples to nothing. Asserted by comparing
the tint cell for cell against `sampleDocument` — 208 of 208 on a drawn circle —
and in the browser by comparing the resulting mask against the committed
document: 288 cells previewed, 288 added, same set.

**The gesture is not the document.** Nothing reaches the editor until release,
so a cancelled drag leaves no history and the undo stack holds only finished
actions.

A consequence of sampling, made visible rather than hidden: a drag narrower
than a cell, or a shape drawn entirely inside an existing wall, is a perfectly
valid shape that changes **no cells**. The readout says so before release —
flagged, not merely printed — because otherwise it looks like the tool is
broken.

Against the roadmap's list of tools, what is actually delivered:

| roadmap tool | delivered |
|---|---|
| rectangle | yes |
| circle | yes |
| wall, obstacle | yes — a rectangle; there is no separate primitive, and a wall drawn edge to edge is what splits a domain in §4 |
| eraser | yes — erase-rect and erase-circle, which are the same shapes with `op: "subtract"` |
| select | as a no-draw mode; removing a shape is done from the shape list, not by clicking it on the canvas |
| polygon | in the document model and the editor's tool set, with no click-to-place gesture in the UI |
| line | no. A zero-width line samples to nothing on a cell-centre test; the equivalent is a thin rectangle, and the preview says when one is too thin to catch a cell |
| move | no — see §10 |

Coordinate mapping is a separate pure module because three transforms sit
between a pointer and the fluid — CSS pixels to intrinsic canvas pixels, the M4
inset margin, and the y flip — and an error in any of them shifts every shape by
a plausible-looking amount. It looks like sloppy aiming rather than a bug. All
three are tested in node with no browser.

The live overlay tints connected fluid regions from **the same labelling the
solver reads**, not a second computation of connectivity — the rule the M4
boundary bands already follow.

## 9. A drawn domain is not a validated domain

The sharpest consequence of drawing, and it is not a numerical one.

Once geometry can be edited, the domain on screen need not be the domain
anything was measured on. A recorded cylinder wake length displayed beside a
cylinder the viewer has just erased is precisely the failure the validation
panel exists to prevent, wearing the panel's own clothes.

So when the domain no longer matches the scenario's own, the measurements are
**withdrawn, not annotated**. A caveat under a table of numbers is read after
the numbers.

"No longer matches" is decided by comparing the sampled **mask** against the
scenario's own — not an edit counter, and not a document comparison. Both
proxies are wrong on ordinary gestures, in the direction that cries wolf:

- a document edited and undone back has a nonzero revision and an identical
  domain;
- a shape drawn inside an existing wall changes the document and no cells.

Both cases are tested. This is the same lesson as §6, applied before it could
become a seventh instance: ask the property of interest, not a proxy for it.

The registry records the rule rather than leaving it to the UI: every
classification in `validation/registry.js` describes that case's own geometry
and nothing else, and `docs/VALIDATION.md` now says so where a reader meets the
numbers.

M5 also adds one case of its own, `drawn-geometry`, classified
**self-validated** — invariants, no external reference, because there is no
external reference for a shape someone just drew:

| claim | tolerance | measured |
|---|---|---|
| cells differing between document and original predicate, 3 scenarios | 0 | **0** |
| surface flow rate delivered vs requested | 1e-12 | **0** |
| velocity on drawn solid surfaces | 0 | **0** |
| max\|div u\| with a surface inlet driving the flow | 1e-7 | 9.40e-8 |

The first row is the claim every other case in the record silently depends on.
A benchmark measured on one domain says nothing about another, so "the document
reproduces the mask the results were measured with" is what keeps the rest of
the record meaningful — and it is now measured by the validation run rather
than only asserted in a test. The predicates it compares against live in
`tests/support/geometry.js`, written out once and shared by the test and the
measurement, so the two cannot describe different computations.

## 10. Deferred, explicitly

- **Real meshing.** Cut cells, immersed boundaries, body-fitted grids. The
  staircase error is about one cell for a curved body and is the dominant
  geometric error; nothing in M5 reduces it.
- **Non-rectangular domains.** The outer domain stays a rectangle; solids are
  drawn inside it.
- **Per-region pressure solving.** Deferred on evidence (§4), not on hope.
- **Move, canvas select, polygon and line gestures.** See the table in §8 for
  exactly what that means. Moving a shape is a UI gesture the document model
  already supports through `replace` — the editor's `replace(index, operation)`
  is the whole mechanism — and nothing numerical waits on any of them.
- **Flux-prescribing conditions on staircase surfaces.** Refused rather than
  approximated (§5).
- **Convective outflow** — still open from M4, unchanged.

*M6 note:* the flux balance described in §4 counts boundary faces, and interior
mass sources cross none — the sixth instance of §6's bug shape, found and fixed
in M6. See `docs/M6-sources.md` §4.

## Two things worth recording

**A wrong explanation that was plausible.** The circle-convention difference was
first attributed to the distance metric. The story was coherent, the numbers
were real, and it was wrong. What caught it was mutation testing the claim
rather than trusting it: deleting the branch the story blamed changed nothing.
The code comments and tests now record the decomposition, not the first reading
of it.

**A prediction that was wrong in the useful direction.** Two disconnected
regions were expected to break `projectToZeroMean`. They do not. Demonstrating
the failure before designing around it turned a speculative redesign into a
narrow, measured fix in a different place.

## Handover

M5 completes the roadmap's NOW block. The pipeline is end to end: a shape drawn
on the canvas becomes a document, samples to a mask, compiles to a boundary
plan, is classified into fluid regions, and is either solved or rejected with a
reason — with the validated cases still byte-identical through all of it.

The open item from M3 stands unchanged: the first step of a run from rest is
taken outside the stability limit the driver believes it is enforcing. Nothing
in M4 or M5 touched the timestep logic.
