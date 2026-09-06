// M5 step 6 - the drawing layer: coordinate mapping and gestures.
//
// The two things that can be wrong here are wrong in ways that look like user
// error rather than like bugs, which is why they are tested at all:
//
//   1. A coordinate transform that is off by the boundary-band margin puts
//      every shape a few cells from where it was drawn. Nothing throws, no
//      number goes bad; it just feels like the tool aims badly.
//   2. A preview that shows the OUTLINE rather than the SAMPLED cells promises
//      something the sampler will not deliver. The mismatch is worst exactly
//      where it matters - a thin feature that looks drawn and samples to
//      nothing - so the preview is checked against sampleDocument itself, not
//      against a redrawing of the same idea.
//
// Both modules are pure and take explicit numbers, so all of this runs in node
// with no browser. The browser check on top of it drives real pointer events
// and asserts the resulting document AND the resulting mask.

import test from "node:test";
import assert from "node:assert/strict";

import { StaggeredGrid, stampCircle } from "../geometry/grid.js";
import { applyDocument, sampleDocument } from "../geometry/document.js";
import { fluidRegions } from "../geometry/regions.js";
import {
  clampToDomain,
  isInsideDomain,
  physicalToCanvas,
  screenToPhysical,
} from "../ui/canvasMapping.js";
import { DRAW_TOOLS, DrawingController, describeOperation, regionTint } from "../ui/drawing.js";

// The harness's own numbers, so the mapping is tested against the geometry the
// application actually uses rather than a convenient one.
const BAND = 7;
const MARGIN = BAND + 2;

function layoutFor(grid, { displayScale = 1, left = 0, top = 0 } = {}) {
  const scale = Math.max(1, Math.min(9, Math.floor((760 - 2 * MARGIN) / grid.nx)));
  const canvasWidth = grid.nx * scale + 2 * MARGIN;
  const canvasHeight = grid.ny * scale + 2 * MARGIN;
  return {
    rect: {
      left,
      top,
      width: canvasWidth * displayScale,
      height: canvasHeight * displayScale,
    },
    canvasWidth,
    canvasHeight,
    margin: MARGIN,
    scale,
    h: grid.h,
    nx: grid.nx,
    ny: grid.ny,
  };
}

// A pointer position, in client pixels, for a physical point.
function clientFor(x, y, layout, { displayScale = 1 } = {}) {
  const { px, py } = physicalToCanvas(x, y, layout);
  return [layout.rect.left + px * displayScale, layout.rect.top + py * displayScale];
}

const grid64 = () => new StaggeredGrid(64, 32, 1 / 32);

test("the field's corners map to the domain's corners, margin included", () => {
  const grid = grid64();
  const layout = layoutFor(grid);
  const topLeft = screenToPhysical(MARGIN, MARGIN, layout);
  assert.equal(topLeft.x, 0);
  assert.equal(topLeft.y, grid.ny * grid.h);

  const bottomRight = screenToPhysical(
    layout.canvasWidth - MARGIN,
    layout.canvasHeight - MARGIN,
    layout
  );
  assert.ok(Math.abs(bottomRight.x - grid.nx * grid.h) < 1e-12);
  assert.ok(Math.abs(bottomRight.y) < 1e-12);
});

test("dropping the margin would shift every shape, so the margin is asserted", () => {
  const grid = grid64();
  const layout = layoutFor(grid);
  // Canvas origin is OUTSIDE the field: it is on the boundary band.
  const corner = screenToPhysical(0, 0, layout);
  assert.equal(isInsideDomain(corner, layout), false);
  // And the amount it is outside by is exactly the margin, in cells.
  assert.ok(Math.abs(corner.x + (MARGIN / layout.scale) * grid.h) < 1e-12);
});

test("a canvas displayed smaller than its backing store still aims true", () => {
  const grid = grid64();
  const displayScale = 0.5;
  const layout = layoutFor(grid, { displayScale, left: 37, top: 11 });
  const target = { x: 1.2345, y: 0.4321 };
  const [cx, cy] = clientFor(target.x, target.y, layout, { displayScale });
  const back = screenToPhysical(cx, cy, layout);
  assert.ok(Math.abs(back.x - target.x) < 1e-9, `x ${back.x}`);
  assert.ok(Math.abs(back.y - target.y) < 1e-9, `y ${back.y}`);
});

test("screenToPhysical and physicalToCanvas are inverses", () => {
  const grid = grid64();
  const layout = layoutFor(grid);
  for (const point of [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 0.5, y: 0.75 }]) {
    const { px, py } = physicalToCanvas(point.x, point.y, layout);
    const back = screenToPhysical(px, py, layout);
    assert.ok(Math.abs(back.x - point.x) < 1e-12);
    assert.ok(Math.abs(back.y - point.y) < 1e-12);
  }
});

test("clampToDomain holds a drag that leaves the canvas at the edge", () => {
  const grid = grid64();
  const layout = layoutFor(grid);
  const clamped = clampToDomain({ x: -3, y: 99 }, layout);
  assert.deepEqual(clamped, { x: 0, y: grid.ny * grid.h });
  const inside = clampToDomain({ x: 1, y: 0.5 }, layout);
  assert.deepEqual(inside, { x: 1, y: 0.5 });
});

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

function controllerFor(grid, options = {}) {
  const layout = layoutFor(grid, options);
  const committed = [];
  const controller = new DrawingController({
    getLayout: () => layout,
    onCommit: (operation) => committed.push(operation),
  });
  const at = (x, y) => clientFor(x, y, layout, options);
  return { controller, committed, layout, at };
}

test("a press on the boundary band is not a press on the fluid", () => {
  const grid = grid64();
  const { controller, layout } = controllerFor(grid);
  controller.setTool("rectangle");
  assert.equal(controller.down(layout.rect.left + 1, layout.rect.top + 1), false);
  assert.equal(controller.anchor, null);
  assert.equal(controller.pending, null);
});

test("the select tool draws nothing", () => {
  const grid = grid64();
  const { controller, at } = controllerFor(grid);
  assert.equal(controller.tool, "select");
  assert.equal(controller.down(...at(1, 0.5)), false);
  assert.equal(controller.pending, null);
});

test("a rectangle drag commits the same operation whichever way it is dragged", () => {
  const grid = grid64();
  const forward = controllerFor(grid);
  forward.controller.setTool("rectangle");
  forward.controller.down(...forward.at(0.25, 0.25));
  forward.controller.move(...forward.at(0.75, 0.6));
  assert.equal(forward.controller.up(), true);

  const backward = controllerFor(grid);
  backward.controller.setTool("rectangle");
  backward.controller.down(...backward.at(0.75, 0.6));
  backward.controller.move(...backward.at(0.25, 0.25));
  assert.equal(backward.controller.up(), true);

  assert.equal(forward.committed.length, 1);
  const a = forward.committed[0];
  const b = backward.committed[0];
  assert.equal(a.op, "add");
  assert.equal(a.region.kind, "rect");
  for (const field of ["x0", "y0", "x1", "y1"]) {
    assert.ok(Math.abs(a.region[field] - b.region[field]) < 1e-9, field);
  }
  assert.ok(Math.abs(a.region.x0 - 0.25) < 1e-9);
  assert.ok(Math.abs(a.region.y1 - 0.6) < 1e-9);
});

test("a circle's radius is the drag length, and its conventions are explicit", () => {
  const grid = grid64();
  const { controller, committed, at } = controllerFor(grid);
  controller.setTool("circle");
  controller.down(...at(1, 0.5));
  controller.move(...at(1.3, 0.9));
  controller.up();
  const { region } = committed[0];
  assert.equal(region.kind, "disk");
  assert.equal(region.metric, "squared");
  assert.equal(region.closed, true);
  assert.ok(Math.abs(region.radius - Math.hypot(0.3, 0.4)) < 1e-9);
});

test("a click with no drag commits nothing", () => {
  const grid = grid64();
  const { controller, committed, at } = controllerFor(grid);
  controller.setTool("rectangle");
  controller.down(...at(1, 0.5));
  assert.equal(controller.pending, null); // degenerate, not an error
  assert.equal(controller.up(), false);
  assert.equal(committed.length, 0);
});

test("cancel and tool switching discard a gesture without committing it", () => {
  const grid = grid64();
  const { controller, committed, at } = controllerFor(grid);
  controller.setTool("rectangle");
  controller.down(...at(0.5, 0.5));
  controller.move(...at(1, 1));
  assert.notEqual(controller.pending, null);
  assert.equal(controller.cancel(), true);
  assert.equal(controller.pending, null);
  assert.equal(controller.up(), false);

  controller.down(...at(0.5, 0.5));
  controller.move(...at(1, 1));
  controller.setTool("circle");
  assert.equal(controller.pending, null);
  assert.equal(controller.up(), false);
  assert.equal(committed.length, 0);
});

test("a drag off the canvas clamps into the domain rather than off the grid", () => {
  const grid = grid64();
  const { controller, committed, at, layout } = controllerFor(grid);
  controller.setTool("rectangle");
  controller.down(...at(1, 0.5));
  controller.move(layout.rect.left + 10000, layout.rect.top - 10000);
  controller.up();
  const { region } = committed[0];
  assert.ok(region.x1 <= grid.nx * grid.h + 1e-12);
  assert.ok(region.y1 <= grid.ny * grid.h + 1e-12);
  assert.ok(region.x0 >= -1e-12 && region.y0 >= -1e-12);
});

// ---------------------------------------------------------------------------
// The preview is the sampled result
// ---------------------------------------------------------------------------

test("the preview highlights exactly the cells the sampler will change", () => {
  const grid = grid64();
  const { controller, committed, at } = controllerFor(grid);
  controller.setTool("circle");
  controller.down(...at(1, 0.5));
  controller.move(...at(1.25, 0.5));

  const tint = controller.tintFor(grid);
  assert.notEqual(tint, null);

  // What the preview says.
  const previewed = new Set();
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) if (tint(i, j) !== null) previewed.add(grid.idx(i, j));
  }

  // What the sampler will actually do, taken from sampleDocument on the
  // committed operation - the same call the session makes.
  controller.up();
  const sampled = sampleDocument({ operations: committed }, grid);
  const marked = new Set();
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) {
      if (sampled[grid.idx(i, j)] === 1) marked.add(grid.idx(i, j));
    }
  }

  assert.ok(previewed.size > 0);
  assert.deepEqual([...previewed].sort(), [...marked].sort());
  console.log(
    `[M5 drawing] preview and sampler agree on all ${previewed.size} cells of a drawn circle`
  );
});

test("a drawn circle samples identically to stampCircle, the validated predicate", () => {
  // The drawing tool must not quietly introduce a third circle convention.
  // M5 step 1 measured what the conventions are worth: `<=` against `<` is
  // three cells on the cylinder body, enough to move a benchmarked wake
  // length. So the tool is pinned to stampCircle cell for cell.
  const grid = grid64();
  const { controller, committed, at } = controllerFor(grid);
  controller.setTool("circle");
  controller.down(...at(0.5, 0.5));
  controller.move(...at(0.5 + 0.15, 0.5));
  controller.up();

  const drawn = new StaggeredGrid(grid.nx, grid.ny, grid.h);
  applyDocument(drawn, { operations: committed });

  const stamped = new StaggeredGrid(grid.nx, grid.ny, grid.h);
  const count = stampCircle(stamped, 0.5, 0.5, committed[0].region.radius);

  assert.ok(count > 0);
  for (let k = 0; k < drawn.solid.length; k++) {
    assert.equal(drawn.solid[k], stamped.solid[k], `cell ${k}`);
  }
});

test("the eraser is a subtract of the same shape, tinted differently", () => {
  const grid = grid64();
  const { controller, committed, at } = controllerFor(grid);
  controller.setTool("eraseRectangle");
  controller.down(...at(0.25, 0.25));
  controller.move(...at(0.75, 0.6));
  const eraseTint = controller.tintFor(grid);
  // A cell the shape actually covers, found rather than guessed at: the tint
  // is only interesting where it is painted.
  const covered = (() => {
    for (let j = 1; j <= grid.ny; j++) {
      for (let i = 1; i <= grid.nx; i++) if (eraseTint(i, j) !== null) return [i, j];
    }
    return null;
  })();
  assert.notEqual(covered, null);
  const painted = eraseTint(...covered);
  controller.up();

  assert.equal(committed[0].op, "subtract");
  assert.equal(committed[0].region.kind, "rect");
  assert.notEqual(painted, null);

  const addController = controllerFor(grid);
  addController.controller.setTool("rectangle");
  addController.controller.down(...addController.at(0.25, 0.25));
  addController.controller.move(...addController.at(0.75, 0.6));
  const addPainted = addController.controller.tintFor(grid)(...covered);
  assert.notEqual(addPainted, null);
  assert.notDeepEqual(painted, addPainted);
});

test("every tool has a label, and one that makes no geometry says what it does", () => {
  // `makes: null` used to mean "this is the select tool". M6 added a brush and
  // a source placer, which also make no geometry but are not select - so the
  // rule is now that a tool either builds a document operation or declares the
  // `kind` of thing it does instead. A tool that did neither would be a palette
  // button wired to nothing, which is what this is guarding.
  for (const [id, tool] of Object.entries(DRAW_TOOLS)) {
    assert.equal(typeof tool.label, "string");
    assert.ok(tool.label.length > 0, id);
    if (tool.makes === null) {
      assert.ok(
        id === "select" || typeof tool.kind === "string",
        `${id} makes no geometry and does not say what it does instead`
      );
    } else {
      assert.equal(typeof tool.makes, "function", id);
    }
  }
  assert.equal(DRAW_TOOLS.brush.kind, "momentum");
  assert.equal(DRAW_TOOLS.placeSource.kind, "place");
});

test("describeOperation names what was drawn", () => {
  assert.match(
    describeOperation({ op: "add", region: { kind: "rect", x0: 0, y0: 0, x1: 1, y1: 1 } }),
    /^solid rect /
  );
  assert.match(
    describeOperation({
      op: "subtract",
      region: { kind: "disk", cx: 1, cy: 1, radius: 0.2, metric: "squared", closed: true },
    }),
    /^erase circle r=0\.20 /
  );
});

// ---------------------------------------------------------------------------
// The region overlay
// ---------------------------------------------------------------------------

test("region tinting stays off until the domain is actually split", () => {
  const grid = grid64();
  assert.equal(regionTint(grid, fluidRegions(grid)), null);

  // A full-height wall cuts the domain in two.
  const wall = { operations: [{ op: "add", region: { kind: "rect", x0: 0.9, y0: 0, x1: 1.1, y1: 1 } }] };
  applyDocument(grid, wall);
  const regions = fluidRegions(grid);
  assert.equal(regions.count, 2);

  const tint = regionTint(grid, regions);
  assert.notEqual(tint, null);
  // Left of the wall and right of it are labelled differently, and the tint
  // follows the labelling rather than a second guess at connectivity.
  const left = regions.label[grid.idx(2, 2)];
  const right = regions.label[grid.idx(grid.nx - 1, 2)];
  assert.notEqual(left, right);
  assert.notDeepEqual(tint(2, 2), tint(grid.nx - 1, 2));
  // Solid cells belong to no region and are not tinted.
  const inWall = (() => {
    for (let i = 1; i <= grid.nx; i++) if (grid.solid[grid.idx(i, 2)]) return i;
    return null;
  })();
  assert.notEqual(inWall, null);
  assert.equal(tint(inWall, 2), null);
});

test("a press aimed at the outermost row of cells starts a gesture", () => {
  // The exact edge is a coin flip in floating point, so this is asserted with
  // a point deliberately a fraction outside: a wall drawn from one channel
  // wall to the other has to be startable without sub-pixel accuracy.
  const grid = grid64();
  const { controller, committed, layout, at } = controllerFor(grid);
  controller.setTool("rectangle");

  const justOutside = clientFor(0, -grid.h * 0.4, layout);
  assert.equal(controller.down(...justOutside), true);
  // Clamped, so the anchor is a point in the domain rather than one below it.
  assert.equal(controller.anchor.y, 0);
  controller.move(...at(0.2, 1));
  controller.up();
  assert.equal(committed[0].region.y0, 0);

  // And the tolerance is narrower than the band, so a press meant for the band
  // is still a press on the band.
  assert.equal(controller.down(layout.rect.left + 1, layout.rect.top + 1), false);
});

// ---------------------------------------------------------------------------
// Whether the domain is still the one that was validated
// ---------------------------------------------------------------------------
//
// The panel withdraws a scenario's recorded measurements once the geometry no
// longer matches, so the test of "no longer matches" has to be the mask - not
// the edit count, and not the document. Both proxies are wrong on an ordinary
// gesture, and both are wrong in the direction that makes the panel cry wolf.

test("an edited domain is reported by comparing masks, not counting edits", async () => {
  const { SimulationSession } = await import("../ui/session.js");
  const { TOOLS } = await import("../geometry/editor.js");
  const session = new SimulationSession("cylinder");
  assert.equal(session.geometryMatchesScenario, true);
  const pristine = Uint8Array.from(session.grid.solid);

  // A shape that changes the domain.
  session.applyEdit(TOOLS.rectangle(6, 2, 7, 4));
  assert.equal(session.geometryMatchesScenario, false);
  assert.equal(session.editor.revision > 0, true);

  // Undone back: the document has been edited twice and the domain is the
  // scenario's own again. An edit counter would still call this edited.
  session.undo();
  assert.equal(session.geometryMatchesScenario, true);
  assert.deepEqual(Array.from(session.grid.solid), Array.from(pristine));

  // A shape that changes nothing: a disc drawn well inside the cylinder body,
  // which is already solid. The document differs from the scenario's; the
  // domain does not. Comparing documents would call this edited too.
  const { cx, cy } = { cx: 3.5, cy: 73 / 24 };
  session.applyEdit(TOOLS.circle(cx, cy, 0.1));
  assert.equal(session.editor.size, 2);
  assert.deepEqual(Array.from(session.grid.solid), Array.from(pristine));
  assert.equal(session.geometryMatchesScenario, true);

  // And erasing the scenario's own shape is unambiguously a different domain.
  session.removeEdit(0);
  assert.equal(session.geometryMatchesScenario, false);
});

test("a shape too thin to catch a cell is valid and changes nothing", () => {
  // Sampling is at cell centres, so a drag narrower than a cell produces a
  // well-formed rectangle covering no cells - as does one drawn entirely
  // inside an existing wall. Both are legal; the readout is what has to say
  // they will do nothing, before the release rather than after it.
  const grid = grid64();
  const { controller, at } = controllerFor(grid);
  controller.setTool("rectangle");
  controller.down(...at(0.5, 0.1));
  controller.move(...at(0.5 + grid.h / 8, 0.9));
  const thin = controller.pending;
  assert.notEqual(thin, null, "a sub-cell rectangle is still a valid shape");
  const tint = controller.tintFor(grid);
  let covered = 0;
  for (let j = 1; j <= grid.ny; j++) {
    for (let i = 1; i <= grid.nx; i++) if (tint(i, j) !== null) covered++;
  }
  assert.equal(covered, 0);
  controller.cancel();

  // And a drag with no width at all is not a shape at all.
  controller.down(...at(0.5, 0.1));
  controller.move(...at(0.5, 0.9));
  assert.equal(controller.pending, null);
});
