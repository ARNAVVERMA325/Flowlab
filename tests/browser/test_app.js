// The committed browser checks.
//
// These assert BEHAVIOUR through the running app - the run loop, the rendering,
// and real pointer events - rather than the presence of text in a panel. Each
// one ends by asserting the page reported no uncaught exception and no console
// error, which is bug A's entire class: an exception inside a
// requestAnimationFrame callback reaches nothing an ordinary test looks at.
//
// See tests/browser/support/browser.js for what these are for and why they are
// not a project dependency.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";

import {
  SKIP_MESSAGE, clientFor, drag, launchBrowser, loadPlaywright, openApp,
  readState, startServer,
} from "./support/browser.js";

const chromium = await loadPlaywright();
const skip = chromium === null ? SKIP_MESSAGE : false;

let browser = null;
let server = null;

before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await launchBrowser(chromium);
});

after(async () => {
  await browser?.close();
  server?.stop();
});

// Each check gets a fresh page, so one failure cannot leave state for the next.
async function withApp(body) {
  const app = await openApp(browser, server.url);
  try {
    await body(app);
    app.assertNoErrors("the check");
  } finally {
    await app.page.close();
  }
}

// Views are chosen with the mode TILES now, after the reference layout, rather
// than a dropdown. A click on the tile a person would click, not a call into
// setMode - and no catch, so a missing tile fails rather than timing out into
// a pass.
async function chooseMode(page, mode) {
  await page.click(`#mode .modetile[data-mode="${mode}"]`);
  await page.waitForTimeout(150);
  const chosen = await page.evaluate(() => window.__flowlab.mode);
  if (chosen !== mode) throw new Error(`clicking the ${mode} tile left the view on ${chosen}`);
}

// Runs until at least `steps` SOLVER STEPS have happened, then pauses.
//
// For checks whose claim is about steps - one sample per step, trails that
// grow per step, a fluid that responds within N steps. Waiting a fixed number
// of milliseconds instead ties the verdict to how fast the machine renders:
// after the UI refresh made frames heavier, the brush check began failing
// intermittently for exactly that reason, and three others were one slow CI
// runner away from the same.
async function runForSteps(page, steps, timeout = 60000) {
  const from = await page.evaluate(() => window.__flowlab.session.iteration);
  await page.click("#run");
  await page.waitForFunction((target) => window.__flowlab.session.iteration >= target, from + steps, { timeout });
  await page.click("#pause");
  await page.waitForTimeout(100);
}

describe("browser", { skip }, () => {
  // -------------------------------------------------------------------------
  // The run loop and the failure states
  // -------------------------------------------------------------------------

  test("the app runs, and the panel agrees with the solver", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);
      await page.click("#run");
      await page.waitForTimeout(2000);
      await page.click("#pause");

      const { panel, solver } = await readState(page);
      assert.equal(panel.status, "PAUSED");
      assert.ok(solver.iteration > 0, "the run loop must actually step");
      assert.equal(panel.iteration, solver.iteration, "the panel and the solver must agree");
      assert.match(panel.field, /^finite/);
      // The continuity bound is the solver's central promise; the panel is
      // where anyone would read it.
      assert.ok(Number(panel.divmax) <= 1e-7, `continuity error reads ${panel.divmax}`);
    });
  });

  test("one NaN in one fluid cell halts the run and is reported as NaN", async () => {
    await withApp(async ({ page }) => {
      await page.click("#run");
      await page.waitForTimeout(800);
      const injected = await page.evaluate(() => {
        const g = window.__flowlab.scenario.grid;
        for (let j = 1; j <= g.ny; j++) {
          for (let i = 2; i < g.nx; i++) {
            if (!g.solid[g.idx(i, j)] && !g.solid[g.idx(i - 1, j)]) {
              g.u[g.idx(i, j)] = NaN;
              window.__flowlab.draw();
              return { i, j };
            }
          }
        }
        return null;
      });
      assert.notEqual(injected, null);

      const { panel } = await readState(page);
      assert.equal(panel.status, "FAILED");
      assert.match(panel.field, /NOT FINITE/);
      assert.match(panel.divmax, /NaN/, "a broken field must not report a healthy number");
      assert.ok(panel.banner, "a failure must say so at the top of the page");

      // And Run must refuse to restart it - only Reset clears a failure.
      //
      // Asserted against the GUARD, not by clicking. The button is disabled, so
      // a click would wait for it to become enabled and time out after thirty
      // seconds - which the first version of this check swallowed in a
      // `.catch(() => {})` and reported as a pass. Calling run() directly is
      // both faster and the stronger test: it exercises the refusal rather than
      // the button's attribute.
      assert.equal(
        await page.evaluate(() => document.querySelector("#run").disabled), true,
        "Run must be disabled on a failed field"
      );
      await page.evaluate(() => window.__flowlab.run());
      await page.waitForTimeout(300);
      const stillFailed = await readState(page);
      assert.equal(stillFailed.panel.status, "FAILED", "run() must refuse a failed field");
      assert.equal(stillFailed.solver.state, "failed");

      await page.click("#reset");
      await page.waitForTimeout(200);
      const after = await readState(page);
      assert.equal(after.panel.status, "PAUSED");
      assert.equal(after.solver.iteration, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Bug A's class: an unhandled solver failure inside the animation loop
  // -------------------------------------------------------------------------

  test("a domain the solver cannot solve reaches the banner, not the console", async () => {
    // SolverGeometryError once escaped into a requestAnimationFrame callback
    // because tick() caught three error types and this was not one of them.
    // The page-error trap in withApp is what makes this a failing test rather
    // than a check nobody reads.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);
      await page.click('button.tool[data-tool="rectangle"]');
      // A wall from the bottom of the channel to the top, cutting the inlet
      // off from every outlet.
      await drag(page, [7.0, 0.0], [7.3, 6.1]);

      const drawn = await readState(page);
      assert.match(drawn.panel.regions, /2 regions/, "the wall must split the domain");

      await page.click("#run");
      await page.waitForTimeout(1000);
      const { panel } = await readState(page);
      assert.equal(panel.status, "FAILED");
      assert.match(panel.banner, /GEOMETRY REJECTED/);
      // The field is the untouched initial condition: it refused before stepping.
      assert.equal(panel.iteration, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Bug B's class: something displayed that the solver is not running
  // -------------------------------------------------------------------------

  test("a mass source the panel shows is a mass source the solver runs", async () => {
    // The failure this replaces produced no error and no obviously wrong text.
    // The panel faithfully reported a solver that was not running the source it
    // was drawing, and the only visible sign was the numbers coming out
    // INVERTED: continuity 3.20e-1 against a raw divergence of 7.8e-8.
    //
    // So the assertion is on the physics. A source that reached the solver
    // leaves the field carrying the divergence it imposes and the continuity
    // error small; one that did not leaves exactly the reverse.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "pressure-channel");
      await page.waitForTimeout(200);
      const imposed = await page.evaluate(() => {
        const h = window.__flowlab;
        const g = h.scenario.grid;
        const mx = (g.nx / 2) * g.h;
        const my = (g.ny / 2) * g.h;
        h.session.addSource({
          kind: "mass",
          where: {
            kind: "rect",
            x0: mx - 3 * g.h, y0: my - 3 * g.h, x1: mx + 3 * g.h, y1: my + 3 * g.h,
          },
          rate: 0.02,
        });
        h.draw();
        return h.sourcePlan.mass.table[0].q;
      });

      await page.click("#run");
      await page.waitForTimeout(2500);
      await page.click("#pause");

      const measured = await page.evaluate(async () => {
        const { computeDivergence, computeContinuityError } = await import("./solver/ns2d.js");
        const h = window.__flowlab;
        return {
          raw: computeDivergence(h.scenario.grid).max,
          continuity: computeContinuityError(h.scenario.grid, h.sourcePlan).max,
        };
      });
      const { panel, solver } = await readState(page);

      assert.ok(solver.iteration > 0, "the run must have stepped");
      assert.ok(
        Math.abs(measured.raw - imposed) < 1e-6,
        `the field should carry the imposed divergence ${imposed}; it reads ` +
        `${measured.raw.toExponential(3)}, which means the source never reached the solver`
      );
      assert.ok(
        measured.continuity < 1e-6,
        `continuity error ${measured.continuity.toExponential(3)} - the source is ` +
        `being displayed, not applied`
      );
      // And the panel shows the continuity error, not the raw divergence.
      assert.ok(Number(panel.divmax) < 1e-6, `panel reads ${panel.divmax}`);
      assert.equal(panel.imposedHidden, false, "an imposed divergence must be named");
      assert.match(panel.imposed, /over \d+ cells/);
    });
  });

  // -------------------------------------------------------------------------
  // Bug C's class: a rejection thrown from somewhere no caller was guarding
  // -------------------------------------------------------------------------

  test("a source placed inside a wall is refused with a reason, not a page error", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);
      await page.click('button.tool[data-tool="placeSource"]');
      const [x, y] = await clientFor(page, 3.5, 73 / 24);  // the cylinder body
      await page.mouse.click(x, y);
      await page.waitForTimeout(200);

      const { panel, solver } = await readState(page);
      assert.match(panel.drawstatus, /source rejected/);
      assert.match(panel.drawstatus, /selects no/);
      assert.equal(solver.placedCount, 0, "and nothing must have been recorded");
      // The app is still usable afterwards.
      await page.click("#run");
      await page.waitForTimeout(600);
      assert.equal((await readState(page)).panel.status, "RUNNING");
    });
  });

  // -------------------------------------------------------------------------
  // The interactions themselves
  // -------------------------------------------------------------------------

  test("a drawn shape changes exactly the cells the preview promised", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);
      await page.click("#run");
      await page.waitForTimeout(1200);
      await page.click('button.tool[data-tool="rectangle"]');

      const before = await readState(page);
      await drag(page, [6.0, 2.0], [7.0, 4.0], { hold: true });
      const promised = (await readState(page)).panel.drawstatus;
      assert.match(promised, /^\d+ cells become solid$/);
      const promisedCells = Number(promised.split(" ")[0]);

      await page.mouse.up();
      await page.waitForTimeout(200);
      const after = await readState(page);

      assert.equal(
        after.solver.solidCells - before.solver.solidCells, promisedCells,
        "the mask must change by exactly what the preview said"
      );
      // A geometry edit stops the run and rebuilds the field.
      assert.equal(after.panel.status, "PAUSED");
      assert.equal(after.solver.iteration, 0);
      // And the validation record is withdrawn, because the domain is not the
      // one anything was measured on.
      assert.equal(after.panel.vclass, "does not apply");

      // Undo restores both the domain and the record.
      await page.click("#undo");
      await page.waitForTimeout(200);
      const undone = await readState(page);
      assert.equal(undone.solver.solidCells, before.solver.solidCells);
      assert.equal(undone.panel.vclass, "benchmarked");
    });
  });

  test("a brush stroke moves the fluid and leaves nothing behind", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);
      await page.click('button.tool[data-tool="brush"]');
      await page.click("#run");
      await page.waitForTimeout(1200);

      const before = await readState(page);
      const [x0, y0] = await clientFor(page, 0.3, 0.5);
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.waitForTimeout(120);
      // A press with no movement has no direction, so it must drive nothing.
      assert.equal(
        (await readState(page)).solver.brushLive, false,
        "a press alone must not invent a direction"
      );

      const [x1] = await clientFor(page, 0.75, 0.5);
      for (let n = 1; n <= 6; n++) {
        await page.mouse.move(x0 + ((x1 - x0) * n) / 6, y0);
        await page.waitForTimeout(40);
      }
      const stroking = await readState(page);
      assert.equal(stroking.solver.brushLive, true);
      assert.match(stroking.panel.srcbrush, /^pushing/);

      // Wait for SOLVER STEPS with the brush held, not for wall-clock time.
      //
      // This waited 700 ms and failed intermittently after the UI refresh made
      // each frame heavier: fewer steps fitted into the same 700 ms, so the
      // fluid had less simulated time to respond, and the check's verdict
      // depended on how fast the machine rendered rather than on whether the
      // brush pushes. The physics claim is per step, so the wait is too.
      const startedAt = stroking.solver.iteration;
      await page.waitForFunction(
        (from) => window.__flowlab.session.iteration >= from + 40,
        startedAt, { timeout: 30000 }
      );
      const during = await readState(page);
      assert.ok(
        during.solver.peakSpeed > before.solver.peakSpeed * 1.2,
        `the stroke must move the fluid within 40 steps: ${before.solver.peakSpeed} -> ` +
        `${during.solver.peakSpeed} over ${during.solver.iteration - startedAt} steps`
      );
      assert.ok(Number(during.panel.divmax) <= 1e-7, "and the projection must still hold");

      await page.mouse.up();
      await page.waitForTimeout(200);
      const released = await readState(page);
      assert.equal(released.solver.brushLive, false);
      assert.equal(released.solver.sourceCount, 0, "the stroke must leave nothing behind");
    });
  });

  test("a boundary edit applies mid-run without restarting it", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);
      await page.click("#run");
      await page.waitForTimeout(1500);
      const before = await readState(page);
      assert.equal(before.panel.status, "RUNNING");

      await page.selectOption("#bcside", "top");
      await page.selectOption("#bctype", "inflow");
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        document.querySelector('#bcfields input[data-field="v"]').value = "-0.4";
      });
      await page.click("#bcapply");
      await page.waitForTimeout(1200);

      const after = await readState(page);
      assert.equal(after.panel.status, "RUNNING", "a boundary edit must not stop the run");
      assert.ok(
        after.solver.iteration > before.solver.iteration,
        "and must not reset the iteration count"
      );
      assert.equal(after.solver.bc.top.type, "inflow");
      assert.equal(after.solver.bc.top.v, -0.4);
      // The flux readout must still balance, which is what says the new inlet
      // is genuinely part of the same solve.
      assert.ok(Math.abs(Number(after.panel.net)) < 1e-6, `net flux ${after.panel.net}`);
    });
  });

  test("a required boundary field left blank is refused, and changes nothing", async () => {
    await withApp(async ({ page }) => {
      const before = await readState(page);
      await page.selectOption("#bcside", "top");
      await page.selectOption("#bctype", "pressure");
      await page.waitForTimeout(100);
      await page.click("#bcapply");
      await page.waitForTimeout(200);

      const after = await readState(page);
      const hint = await page.evaluate(() => document.querySelector("#bcedithint").textContent);
      assert.match(hint, /required/);
      assert.deepEqual(after.solver.bc, before.solver.bc, "a refused edit must change nothing");
    });
  });

  test("the dye controls paint dye and nothing else", async () => {
    // #reseed and #cleardye only ever touch the tracer: the flow keeps whatever
    // state it has. Driven here because a control nothing drives is a control
    // nobody has checked - working agreement item 9.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);
      await page.click("#run");
      await page.waitForTimeout(1500);
      await page.click("#pause");

      const seeded = await readState(page);
      assert.ok(seeded.solver.dye > 0, "the cavity seeds dye at t = 0");

      await page.click("#cleardye");
      await page.waitForTimeout(200);
      const cleared = await readState(page);
      assert.equal(cleared.solver.dye, 0, "clearing must remove the dye");
      assert.equal(
        cleared.solver.iteration, seeded.solver.iteration,
        "and must not reset or advance the run"
      );

      await page.click("#reseed");
      await page.waitForTimeout(200);
      const reseeded = await readState(page);
      assert.ok(reseeded.solver.dye > 0, "reseeding must put it back");
      assert.equal(reseeded.solver.iteration, seeded.solver.iteration);

      // On a scenario with no initial pattern the control says why it is
      // unavailable rather than clearing the dye and appearing to do nothing.
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(300);
      assert.equal(
        await page.evaluate(() => document.querySelector("#reseed").disabled), true,
        "an injection-only scenario has nothing to reseed, and must say so"
      );
    });
  });

  test("redo and clear-shapes work on a drawn document", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);
      const pristine = (await readState(page)).solver.solidCells;

      await page.click('button.tool[data-tool="rectangle"]');
      await drag(page, [6.0, 2.0], [7.0, 4.0]);
      const drawn = (await readState(page)).solver.solidCells;
      assert.ok(drawn > pristine);

      await page.click("#undo");
      await page.waitForTimeout(200);
      assert.equal((await readState(page)).solver.solidCells, pristine);

      await page.click("#redo");
      await page.waitForTimeout(200);
      assert.equal((await readState(page)).solver.solidCells, drawn, "redo must bring it back");

      // Clear removes the scenario's own shape too - erasing the cylinder is a
      // legitimate edit, and the solver is told about it like any other.
      await page.click("#clearshapes");
      await page.waitForTimeout(200);
      const cleared = await readState(page);
      assert.equal(cleared.solver.solidCells, 0, "clear removes every shape, the cylinder included");
      assert.equal(cleared.solver.operations, 0);
      assert.equal(
        await page.evaluate(() => document.querySelector("#clearshapes").disabled), true,
        "and disables itself once there is nothing left to clear"
      );
    });
  });

  test("the region tint toggle changes the picture and not the simulation", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);
      // A wall across the channel, so there are two regions to tint.
      await page.click('button.tool[data-tool="rectangle"]');
      await drag(page, [7.0, 0.0], [7.3, 6.1]);
      const split = await readState(page);
      assert.match(split.panel.regions, /2 regions/);

      // A checksum of the painted canvas, so "the toggle does something" is
      // measured rather than assumed from the checkbox's state.
      const checksum = () => page.evaluate(() => {
        const c = document.querySelector("#field");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 401) sum = (sum * 31 + d[i]) >>> 0;
        return sum;
      });

      const tinted = await checksum();
      await page.uncheck("#showregions");
      await page.waitForTimeout(200);
      const plain = await readState(page);
      assert.notEqual(await checksum(), tinted, "turning the tint off must change the picture");
      assert.equal(plain.solver.iteration, split.solver.iteration, "and must not touch the run");
      assert.equal(plain.solver.solidCells, split.solver.solidCells);

      await page.check("#showregions");
      await page.waitForTimeout(200);
      assert.equal(await checksum(), tinted, "and turning it back on must restore it");
    });
  });

  test("boundary undo and redo step through the history without stopping the run", async () => {
    // The two history buttons are the only path back from a boundary edit, and
    // they are wired to a different commit path than #bcapply - commitBoundary
    // re-derives the plan and re-syncs the form, and either step could be
    // missed while the apply path still looked right.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);

      const disabled = (id) => page.evaluate((s) => document.querySelector(s).disabled, id);
      assert.equal(await disabled("#bcundo"), true, "nothing has been edited yet");
      assert.equal(await disabled("#bcredo"), true);

      const before = await readState(page);
      await page.click("#run");
      await page.waitForTimeout(800);

      await page.selectOption("#bcside", "top");
      await page.selectOption("#bctype", "inflow");
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        document.querySelector('#bcfields input[data-field="v"]').value = "-0.3";
      });
      await page.click("#bcapply");
      await page.waitForTimeout(600);

      const edited = await readState(page);
      assert.equal(edited.solver.bc.top.type, "inflow");
      assert.equal(await disabled("#bcundo"), false, "an edit must be undoable");
      assert.equal(await disabled("#bcredo"), true, "and there is nothing ahead of it");

      await page.click("#bcundo");
      await page.waitForTimeout(600);
      const undone = await readState(page);
      assert.deepEqual(
        undone.solver.bc, before.solver.bc,
        "undo must restore the whole specification, not just the edited side"
      );
      // commitBoundary re-syncs the form, so the type selector must follow the
      // history rather than keep showing the undone edit.
      assert.equal(
        await page.evaluate(() => document.querySelector("#bctype").value),
        before.solver.bc.top.type
      );
      assert.equal(await disabled("#bcredo"), false, "and the edit must be ahead of us now");

      await page.click("#bcredo");
      await page.waitForTimeout(600);
      const redone = await readState(page);
      assert.deepEqual(redone.solver.bc, edited.solver.bc, "redo must bring the edit back");

      // None of that touched the run - a boundary edit is not a geometry edit.
      assert.equal(redone.panel.status, "RUNNING");
      assert.ok(
        redone.solver.iteration > edited.solver.iteration,
        "stepping through the history must not reset or stall the run"
      );
      assert.ok(Math.abs(Number(redone.panel.net)) < 1e-6, `net flux ${redone.panel.net}`);
    });
  });

  test("the brush controls are the numbers a placed source carries", async () => {
    // speed, radius, relax and dye are read by BOTH the brush and the place
    // tool, which is the point of having one set of controls - so a placed
    // source is where all four can be read back as numbers rather than
    // inferred from how the fluid moved.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);

      // fill() then an explicit change event: the harness binds on `change`,
      // which a real user fires by leaving the field.
      const setControl = async (id, value) => {
        await page.fill(id, String(value));
        await page.dispatchEvent(id, "change");
      };
      await setControl("#brushspeed", 2.5);
      await setControl("#brushradius", 5);
      await setControl("#brushrelax", 0.2);
      await setControl("#brushdye", 0.4);

      assert.deepEqual(
        await page.evaluate(() => window.__flowlab.brush.settings),
        { speed: 2.5, radius: 5, relaxationTime: 0.2 },
        "the three brush settings must reach the controller"
      );

      await page.click('button.tool[data-tool="placeSource"]');
      const [x, y] = await clientFor(page, 0.5, 0.5);
      await page.mouse.click(x, y);
      await page.waitForTimeout(200);

      const placed = await page.evaluate(() => {
        const h = window.__flowlab;
        return { source: h.session.placedSources[0] ?? null, h: h.scenario.grid.h };
      });
      assert.ok(placed.source, "the click must have placed a source");
      assert.equal(placed.source.u, 2.5, "speed must reach the placed source");
      assert.equal(placed.source.v, 0);
      assert.equal(placed.source.relaxationTime, 0.2);
      assert.ok(
        Math.abs(placed.source.where.radius - 5 * placed.h) < 1e-12,
        `radius is in cells: expected ${5 * placed.h}, got ${placed.source.where.radius}`
      );
      // #brushdye is the one control the brush itself ignores: a stroke leaves
      // nothing behind, so dye only means anything on something persistent.
      assert.equal(placed.source.dye, 0.4);

      // And a value the brush cannot use is refused by putting the old one
      // back, rather than accepted and silently ignored.
      await setControl("#brushradius", -1);
      assert.equal(
        await page.evaluate(() => document.querySelector("#brushradius").value), "5",
        "a rejected setting must show the value actually in force"
      );
      assert.equal(
        await page.evaluate(() => window.__flowlab.brush.settings.radius), 5
      );
    });
  });

  test("clear sources removes every placed source and then disables itself", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);
      assert.equal(
        await page.evaluate(() => document.querySelector("#clearsources").disabled), true,
        "there is nothing to clear before anything is placed"
      );

      await page.click('button.tool[data-tool="placeSource"]');
      for (const [x, y] of [[0.35, 0.5], [0.65, 0.5]]) {
        const [px, py] = await clientFor(page, x, y);
        await page.mouse.click(px, py);
        await page.waitForTimeout(150);
      }
      const placed = await readState(page);
      assert.equal(placed.solver.placedCount, 2);
      assert.equal(placed.panel.srccount, "2");
      assert.equal(
        await page.evaluate(() => document.querySelector("#clearsources").disabled), false
      );

      // The sources must be reaching the solver, or clearing them proves
      // nothing about the solver's state.
      await page.click("#run");
      await page.waitForTimeout(1000);
      assert.equal((await readState(page)).solver.sourceCount, 2);

      await page.click("#clearsources");
      await page.waitForTimeout(400);
      const cleared = await readState(page);
      assert.equal(cleared.solver.placedCount, 0);
      assert.equal(cleared.solver.sourceCount, 0, "and the solver must stop being handed them");
      assert.equal(cleared.panel.srccount, "none");
      assert.equal(
        await page.evaluate(() => document.querySelector("#clearsources").disabled), true
      );
      // Clearing a source is not a geometry edit: the run carries on.
      assert.equal(cleared.panel.status, "RUNNING");
    });
  });

  // -------------------------------------------------------------------------
  // M7: probes
  // -------------------------------------------------------------------------

  test("a pinned probe samples once per solver step, not once per repaint", async () => {
    // The check the design turns on. The harness runs up to four solver steps
    // per animation frame, so a probe sampled in draw() would keep one reading
    // in four - invisible on a smooth signal, aliasing on anything varying near
    // the step rate. Equality with the iteration count is the only way to see
    // that from outside, and it is only observable in a browser because nothing
    // else runs the animation loop.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);
      await page.click('button.tool[data-tool="probe"]');
      const [x, y] = await clientFor(page, 0.5, 0.5);
      await page.mouse.click(x, y);
      await page.waitForTimeout(200);

      const pinned = await readState(page);
      assert.equal(pinned.solver.probeCount, 1);
      assert.equal(pinned.solver.probeSamples, 0, "pinning is not a measurement");
      assert.match(pinned.panel.probeaxis, /no samples yet/);

      await runForSteps(page, 60);

      const ran = await readState(page);
      assert.ok(ran.solver.iteration >= 60, `only ${ran.solver.iteration} steps ran`);
      assert.equal(
        ran.solver.probeSamples, ran.solver.iteration,
        "one sample per solver step - a sample taken on repaint would be about a quarter of these"
      );
      assert.match(ran.panel.probeaxis, /P1 \|u\|/);
      assert.match(ran.panel.probeaxis, /samples/);
      assert.doesNotMatch(ran.panel.probeaxis, /NOT FINITE/);
    });
  });

  test("the hover readout reads the cell under the pointer, and keeps reading it", async () => {
    // Two things. The readout must follow the pointer, and it must stay LIVE
    // while the run advances without the pointer moving - which is why the
    // harness remembers the point rather than the sample. Storing the sample
    // would freeze the numbers at the last pointer move and show a stale
    // measurement under a live cursor.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);

      const h = await page.evaluate(() => window.__flowlab.scenario.grid.h);
      // The readout names the CELL, so the position it prints is that cell's
      // centre rather than the pointer's own - which is the design, and the
      // reason this asserts "within half a cell" instead of equality.
      const at = (text) => {
        const matched = text.match(/^\(([-\d.]+), ([-\d.]+)\) cell (\d+),(\d+)/);
        assert.ok(matched, `hover reads "${text}", which names no cell`);
        return { x: Number(matched[1]), y: Number(matched[2]), cell: `${matched[3]},${matched[4]}` };
      };
      // Half a cell, plus the two decimal places the readout is rounded to.
      const near = h / 2 + 0.005;

      const [x0, y0] = await clientFor(page, 0.25, 0.75);
      await page.mouse.move(x0, y0);
      await page.waitForTimeout(150);
      const first = (await readState(page)).panel.probehover;
      const firstAt = at(first);
      assert.ok(Math.abs(firstAt.x - 0.25) <= near, `x reads ${firstAt.x} for a point at 0.25`);
      assert.ok(Math.abs(firstAt.y - 0.75) <= near, `y reads ${firstAt.y} for a point at 0.75`);
      assert.match(first, /cell Re/);

      const [x1, y1] = await clientFor(page, 0.75, 0.25);
      await page.mouse.move(x1, y1);
      await page.waitForTimeout(150);
      const second = (await readState(page)).panel.probehover;
      const secondAt = at(second);
      assert.ok(Math.abs(secondAt.x - 0.75) <= near, `x reads ${secondAt.x} for a point at 0.75`);
      assert.ok(Math.abs(secondAt.y - 0.25) <= near);
      assert.notEqual(secondAt.cell, firstAt.cell, "the readout must follow the pointer");

      // Now run WITHOUT moving the pointer. The cell is the same; the numbers
      // in it are not.
      //
      // Started by dispatching the button's own click rather than by clicking
      // it, because moving the mouse to the button leaves the canvas - which
      // correctly clears the readout, and would make this check about
      // pointerleave instead of about staleness.
      await page.evaluate(() => document.querySelector("#run").click());
      await page.waitForTimeout(1500);
      const live = (await readState(page)).panel.probehover;
      assert.equal(at(live).cell, secondAt.cell, "still the same cell");
      assert.notEqual(
        live, second,
        "the readout must re-read the field, not replay the sample taken when the pointer moved"
      );

      // And leaving the canvas clears it rather than leaving a number behind.
      await page.mouse.move(5, 5);
      await page.waitForTimeout(200);
      assert.match((await readState(page)).panel.probehover, /hover the field/);
    });
  });

  test("the probe and quantity selectors change the plot and not the simulation", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);
      await page.click('button.tool[data-tool="probe"]');
      for (const [px, py] of [[0.3, 0.8], [0.7, 0.2]]) {
        const [cx, cy] = await clientFor(page, px, py);
        await page.mouse.click(cx, cy);
        await page.waitForTimeout(150);
      }
      await page.click("#run");
      await page.waitForTimeout(1800);
      await page.click("#pause");

      const two = await readState(page);
      assert.equal(two.solver.probeCount, 2);
      assert.equal(two.solver.probeSelection, 2, "the newest probe is the one plotted");

      // A checksum of the chart, so "the selector did something" is measured
      // rather than assumed from the select's value.
      const chart = () => page.evaluate(() => {
        const c = document.querySelector("#probechart");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 97) sum = (sum * 31 + d[i]) >>> 0;
        return sum;
      });

      const p2 = await chart();
      await page.selectOption("#probepick", "1");
      await page.waitForTimeout(200);
      const onP1 = await readState(page);
      assert.equal(onP1.solver.probeSelection, 1);
      assert.notEqual(await chart(), p2, "switching probe must change the plot");
      assert.match(onP1.panel.probeaxis, /^P1 /);

      // The quantities come from the module that defines them, so the two
      // cannot drift - the same rule the view-mode check follows.
      const quantities = await page.evaluate(() =>
        [...document.querySelectorAll("#probequantity option")].map((o) => o.value));
      assert.deepEqual(quantities, ["speed", "u", "v", "pressure", "vorticity", "cellRe"]);

      const before = onP1.solver.iteration;
      for (const quantity of quantities) {
        await page.selectOption("#probequantity", quantity);
        await page.waitForTimeout(120);
        const state = await readState(page);
        assert.equal(state.solver.iteration, before, `plotting ${quantity} stepped the simulation`);
        assert.equal(state.solver.probeSamples, onP1.solver.probeSamples,
          `plotting ${quantity} changed the history`);
      }
      // Pressure is the one quantity whose number is meaningless without its
      // datum, so the plot says which it is.
      await page.selectOption("#probequantity", "pressure");
      await page.waitForTimeout(150);
      const onPressure = await readState(page);
      assert.match(onPressure.panel.probeaxis, /datum/);
      assert.match(onPressure.panel.pdatum, /gauge/, "the cavity prescribes no pressure anywhere");
    });
  });

  test("a probe in a wall says solid, and clear removes every probe", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);
      assert.equal(
        await page.evaluate(() => document.querySelector("#clearprobes").disabled), true,
        "nothing to clear before anything is pinned"
      );
      // A pressure boundary sets the datum here, so the panel must not call it
      // a gauge.
      await page.selectOption("#scenario", "pressure-channel");
      await page.waitForTimeout(250);
      assert.match((await readState(page)).panel.pdatum, /absolute/);

      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(250);
      await page.click('button.tool[data-tool="probe"]');
      const [wx, wy] = await clientFor(page, 3.5, 73 / 24);  // the cylinder body
      await page.mouse.click(wx, wy);
      const [fx, fy] = await clientFor(page, 8.0, 2.0);      // open channel
      await page.mouse.click(fx, fy);
      await page.waitForTimeout(250);

      const pinned = await readState(page);
      assert.equal(pinned.solver.probeCount, 2, "a probe inside a body is legitimate");
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll("#probelist .probrow")].map((r) => r.textContent));
      assert.equal(rows.length, 2);
      assert.match(rows[0], /solid - no fluid here/, "P1 is inside the cylinder");
      assert.doesNotMatch(rows[0], /NaN/, "and says so in words rather than printing NaNs");
      assert.match(rows[1], /cell Re/, "P2 is in the fluid and reports numbers");

      await page.click("#run");
      await page.waitForTimeout(1200);
      await page.click("#pause");
      const ran = await readState(page);
      assert.ok(ran.solver.iteration > 0);

      // The chart for a probe inside a wall. It HAS samples - one per step, all
      // NaN, which is the correct reading there - so the note must say that
      // rather than "no samples yet - press Run", which is what it said until
      // the app was run by hand and the message read. "Nothing recorded" and
      // "everything recorded is NaN" are different states and this is the only
      // check that can tell them apart.
      await page.selectOption("#probepick", "1");
      await page.waitForTimeout(200);
      const onSolid = await readState(page);
      assert.match(onSolid.panel.probeaxis, /samples, all inside a wall/);
      assert.doesNotMatch(
        onSolid.panel.probeaxis, /no samples yet/,
        "the run already happened; telling anyone to press Run describes a state the app is not in"
      );
      assert.doesNotMatch(onSolid.panel.probeaxis, /NONE FINITE/,
        "a solid cell is the ordinary correct answer, not a failure");
      // And the fluid probe beside it plots normally.
      await page.selectOption("#probepick", "2");
      await page.waitForTimeout(200);
      assert.match((await readState(page)).panel.probeaxis, /P2 \|u\|: .* samples/);

      await page.click("#clearprobes");
      await page.waitForTimeout(250);
      const cleared = await readState(page);
      assert.equal(cleared.solver.probeCount, 0);
      assert.equal(cleared.solver.probeSelection, null);
      assert.match(cleared.panel.probeaxis, /no probe pinned/);
      assert.equal(
        await page.evaluate(() => document.querySelector("#clearprobes").disabled), true
      );
      // Clearing a probe is not a simulation event: the run is where it was.
      assert.ok(cleared.solver.iteration > 0, "clearing probes must not reset the run");
    });
  });

  // -------------------------------------------------------------------------
  // M8: overlays and the two new colour maps
  // -------------------------------------------------------------------------

  test("each overlay changes the picture and none of them touches the run", async () => {
    // Overlays are independent of the colour map, not alternatives to it, so
    // each is checked on its own AND all three together. The assertion is on a
    // CHECKSUM of the canvas rather than on the checkbox's state: the first
    // version of the vector overlay drew 332 arrows in the same colour as the
    // field underneath them, reported 332 in the readout, and was invisible.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);
      await page.click("#run");
      await page.waitForTimeout(2500);
      await page.click("#pause");

      const checksum = () => page.evaluate(() => {
        const c = document.querySelector("#field");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 53) sum = (sum * 31 + d[i]) >>> 0;
        return sum;
      });

      const plain = await readState(page);
      const bare = await checksum();
      assert.match(plain.panel.overlaynote, /none/);

      for (const [control, name, pattern] of [
        ["#showvectors", "vectors", /\d+ arrows every \d+ cells/],
        ["#showstreamlines", "streamlines", /\d+ streamlines \(this instant\)/],
        ["#showpathlines", "pathlines", /\d+ of \d+ parcels/],
      ]) {
        await page.check(control);
        await page.waitForTimeout(300);
        const on = await readState(page);
        assert.equal(on.solver.overlays[name], true);
        assert.match(on.panel.overlaynote, pattern, `${name} readout: ${on.panel.overlaynote}`);
        assert.notEqual(
          await checksum(), bare,
          `turning ${name} on must change the picture, not just the readout`
        );
        // An overlay is a pure display change - M3's rule.
        assert.equal(on.solver.iteration, plain.solver.iteration, `${name} stepped the run`);
        assert.equal(on.solver.state, plain.solver.state);

        await page.uncheck(control);
        await page.waitForTimeout(300);
        assert.equal(await checksum(), bare, `turning ${name} off must restore the picture`);
      }

      // All three at once, which is the combination the reference gallery
      // shows and which making them mutually exclusive would forbid.
      for (const control of ["#showvectors", "#showstreamlines", "#showpathlines"]) {
        await page.check(control);
      }
      await page.waitForTimeout(400);
      const all = await readState(page);
      assert.deepEqual(all.solver.overlays, { vectors: true, streamlines: true, pathlines: true });
      assert.ok(all.solver.overlayCounts.vectors > 0);
      assert.ok(all.solver.overlayCounts.streamlines > 0);
      assert.ok(all.solver.overlayCounts.pathlines > 0);
      assert.equal(all.solver.iteration, plain.solver.iteration);
    });
  });

  test("pathlines accumulate while the run advances, and reset with the field", async () => {
    // Pathlines are the one overlay that is STATE rather than a reading of the
    // current field, so the thing worth checking is that they have a history
    // and that the history does not outlive the flow it came from.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(250);
      const trails = () => page.evaluate(() => {
        const ps = window.__flowlab.session.pathlines.particles;
        return ps.reduce((a, p) => a + p.trail.length, 0) / ps.length;
      });
      // Advanced on every step whether or not the overlay is on, so turning it
      // on shows a trail instead of starting to grow one.
      assert.ok(await trails() < 1.5, "a fresh field has no history yet");

      await runForSteps(page, 20);
      const grown = await trails();
      assert.ok(grown > 5, `trails averaged ${grown} points after a run`);

      await page.check("#showpathlines");
      await page.waitForTimeout(300);
      const shown = await readState(page);
      assert.ok(
        shown.solver.overlayCounts.pathlines > 0,
        "the trails that already exist must be drawn immediately"
      );
      assert.equal(shown.solver.parcels, 300);

      // Reset rebuilds the field, so the histories go with it - the same rule
      // the probe series follows, and for the same reason.
      await page.click("#reset");
      await page.waitForTimeout(400);
      assert.ok(await trails() < 1.5, "a rebuilt field must not keep the old trails");
      assert.equal((await readState(page)).solver.iteration, 0);
    });
  });

  test("a healthy solve does not paint the continuity view as a failure", async () => {
    // The regression this view was rebuilt for. Anchoring its fixed scale AT
    // the solver's divergence tolerance produced a full-contrast noise field
    // for a perfectly converged run, because a converged solve stops at its
    // tolerance rather than far below it. Checked here on the real canvas,
    // because that is where it was visible and nowhere else.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(200);
      await page.click("#run");
      await page.waitForTimeout(2500);
      await page.click("#pause");

      await chooseMode(page, "continuity");
      await page.waitForTimeout(150);
      const state = await readState(page);
      assert.equal(state.solver.mode, "continuity");
      assert.match(state.panel.viewnote, /inside the bound/);
      assert.doesNotMatch(state.panel.viewnote, /PAST the/);

      // How far the painted field actually strays from the centre colour. A
      // near-uniform picture is the correct one here; anything else is the
      // solver's rounding noise dressed as structure.
      // Distances are measured from the diverging ramp's own centre colour,
      // read from the module the renderer uses. The first version hardcoded
      // the old ramp's dark centre, which silently stops meaning anything the
      // moment the ramp changes - and the UI refresh changed it.
      const measure = () => page.evaluate(async () => {
        const { sampleDiverging, SOLID_COLOUR } = await import("./visualization/colormap.js");
        const centre = sampleDiverging(0.5);
        const c = document.querySelector("#field");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const layout = window.__flowlab.layout();
        const g = window.__flowlab.scenario.grid;
        let worst = 0;
        let off = 0;
        let total = 0;
        // Only the FIELD area, and only pixels that are not the solid colour or
        // the wall outline: the margin, the bands and the body are all far from
        // the centre colour by design and say nothing about the continuity error.
        for (let py = layout.margin + 2; py < layout.margin + g.ny * layout.scale - 2; py++) {
          for (let px = layout.margin + 2; px < layout.margin + g.nx * layout.scale - 2; px++) {
            const i = (py * c.width + px) * 4;
            const pixel = [d[i], d[i + 1], d[i + 2]];
            const fromSolid = Math.max(...pixel.map((v, n) => Math.abs(v - SOLID_COLOUR[n])));
            if (fromSolid < 24) continue;
            const away = Math.max(...pixel.map((v, n) => Math.abs(v - centre[n])));
            if (away > 150) continue;   // the light wall outline
            total++;
            if (away > worst) worst = away;
            if (away > 60) off++;
          }
        }
        return { worst, fractionOff: off / total, total };
      });
      const { worst: spread, fractionOff, total } = await measure();
      assert.ok(total > 1000, `only ${total} field pixels were measured`);
      assert.ok(
        fractionOff < 0.12,
        `${(fractionOff * 100).toFixed(1)}% of the canvas is far from the centre colour - ` +
        `that is a picture of a broken simulation, and this one is converged (peak ` +
        `pixel distance ${spread})`
      );

      // Vorticity, by contrast, SHOULD have structure - it is a real field.
      await chooseMode(page, "vorticity");
      await page.waitForTimeout(150);
      const vorticity = await readState(page);
      assert.match(vorticity.panel.viewnote, /centred on ZERO|sign carries/);
      assert.equal(vorticity.solver.iteration, state.solver.iteration);
      assert.ok(Number(vorticity.panel.legend[0]) < 0, "a diverging scale runs either side of zero");
      assert.equal(Number(vorticity.panel.legend[1]), 0, "and is centred on zero");
    });
  });

  // -------------------------------------------------------------------------
  // M9: flow analysis
  // -------------------------------------------------------------------------

  test("the analysis panel agrees with the solver, and withholds what it must", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "bend-sharp");
      await page.waitForTimeout(250);
      await page.click("#run");
      await page.waitForTimeout(3000);
      await page.click("#pause");

      const state = await readState(page);
      const fa = state.panel.fa;

      // The declared Reynolds number is the scenario's own, and the panel says
      // what it is built from rather than presenting a bare number.
      assert.equal(state.solver.analysis.declaredRe, state.solver.scenarioRe);
      assert.match(fa.declared, new RegExp(`^${state.solver.scenarioRe}\\b`));
      assert.match(fa.declared, /inlet speed .* x duct width/);

      // The peak figure names its own speed, uses the same length, and on this
      // scenario is well above the declared one - the corner jet.
      assert.match(fa.peak, /same length/);
      assert.ok(
        state.solver.analysis.peakRe > state.solver.analysis.declaredRe,
        `peak ${state.solver.analysis.peakRe} vs declared ${state.solver.analysis.declaredRe}`
      );

      // Wall shear is per-face and the total is withheld, in the panel's own
      // words and in the data behind it.
      assert.equal(state.solver.analysis.integrable, false);
      assert.ok(state.solver.analysis.wallFaces > 0);
      assert.match(fa.wall, /total force withheld/);

      // The rotation count declares its margin rather than using a bare Q > 0.
      assert.match(fa.rot, /rotating.*straining.*balanced.*margin/);

      // This bend separates at the inner corner, which is the whole point of
      // the sharp-versus-smooth comparison.
      assert.ok(state.solver.analysis.separations > 0, "the sharp bend must separate");
      assert.doesNotMatch(fa.sep, /^none$/);
    });
  });

  test("a pure shear channel is not reported as recirculating", async () => {
    // The regression, end to end. A bare Q > 0 test reported 49.2% of a fully
    // developed Poiseuille channel as rotating, because pure shear puts Q
    // analytically at zero and its sign is then decided by rounding.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "pressure-channel");
      await page.waitForTimeout(250);
      await page.click("#run");
      await page.waitForTimeout(4000);
      await page.click("#pause");

      const state = await readState(page);
      const fraction = state.solver.analysis.rotating / state.solver.analysis.fluid;
      assert.ok(
        fraction < 0.05,
        `${(fraction * 100).toFixed(1)}% of a shear flow reported as rotating`
      );
      assert.match(state.panel.fa.rot, /balanced/);
      // And the channel's walls are found at all - they are boundary
      // conditions rather than solid cells, and were missed entirely at first.
      assert.ok(state.solver.analysis.wallFaces > 0, "a channel has walls");
      assert.doesNotMatch(state.panel.fa.wall, /no no-slip wall/);
    });
  });

  test("two probes measure a pressure drop, and one does not", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(250);
      assert.match((await readState(page)).panel.fa.probedp, /pin two probes/);

      await page.click('button.tool[data-tool="probe"]');
      const [x1, y1] = await clientFor(page, 1.0, 3.0);
      await page.mouse.click(x1, y1);
      await page.waitForTimeout(200);
      assert.match((await readState(page)).panel.fa.probedp, /pin two probes/, "one is not two");

      const [x2, y2] = await clientFor(page, 12.0, 3.0);
      await page.mouse.click(x2, y2);
      await page.waitForTimeout(200);
      await page.click("#run");
      await page.waitForTimeout(2500);
      await page.click("#pause");

      const measured = (await readState(page)).panel.fa.probedp;
      assert.match(measured, /^P2 - P1 = /);
      assert.match(measured, /over \d/);
      // Flow runs left to right past the cylinder, so the downstream probe
      // reads the lower pressure and the difference is negative.
      const value = Number(measured.match(/= (-?[\d.e+-]+)/)[1]);
      assert.ok(value < 0, `P2 - P1 reads ${value}; downstream should be lower`);
    });
  });

  // -------------------------------------------------------------------------
  // UI refresh: rendering quality, colour maps, residuals
  // -------------------------------------------------------------------------

  test("smooth and cell rendering each draw what they claim, and neither touches the run", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cylinder");
      await page.waitForTimeout(250);
      await page.click("#run");
      await page.waitForTimeout(2500);
      await page.click("#pause");
      const before = await readState(page);

      // Pixels inside ONE cell: in cells mode they are identical, in smooth mode
      // a cell in a gradient is not. And inside a SOLID cell both modes paint
      // exactly the solid colour - the body stays the staircase being simulated.
      const probeCells = () => page.evaluate(async () => {
        const { SOLID_COLOUR } = await import("./visualization/colormap.js");
        const h = window.__flowlab;
        const l = h.layout();
        const g = h.scenario.grid;
        const c = document.querySelector("#field");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const pixel = (px, py) => {
          const k = (Math.round(py) * c.width + Math.round(px)) * 4;
          return [d[k], d[k + 1], d[k + 2]];
        };
        const cellPixels = (i, j) => {
          const x0 = l.margin + (i - 1) * l.scale;
          const y0 = l.margin + (g.ny - j) * l.scale;
          return [pixel(x0 + 1, y0 + 1), pixel(x0 + l.scale - 2, y0 + l.scale - 2)];
        };
        // A fluid cell just off the cylinder's shoulder, where speed varies fast.
        let fluid = null;
        let solid = null;
        const jc = Math.round(g.ny / 2);
        for (let i = 2; i < g.nx && (fluid === null || solid === null); i++) {
          if (g.solid[g.idx(i, jc)] && solid === null) solid = [i, jc];
          if (solid !== null && fluid === null && !g.solid[g.idx(i, jc + 7)] && g.solid[g.idx(i, jc + 5)]) fluid = [i, jc + 6];
        }
        return {
          fluid: cellPixels(...fluid),
          solid: cellPixels(...solid),
          solidColour: SOLID_COLOUR,
        };
      });

      const smooth = await probeCells();
      assert.notDeepEqual(smooth.fluid[0], smooth.fluid[1],
        "a smooth render must vary WITHIN a cell where the field has a gradient");
      for (const colour of smooth.solid) {
        assert.deepEqual(colour, smooth.solidColour, "a solid cell must stay exactly the solid colour");
      }

      await page.check("#showcells");
      await page.waitForTimeout(250);
      const cells = await probeCells();
      assert.deepEqual(cells.fluid[0], cells.fluid[1], "in cells mode a cell is one flat colour");
      for (const colour of cells.solid) assert.deepEqual(colour, cells.solidColour);
      const after = await readState(page);
      assert.equal(after.solver.iteration, before.solver.iteration, "rendering mode stepped the run");

      // A NaN must still paint as not-finite once values are being
      // interpolated - it may spread, but it may never be averaged away.
      await page.uncheck("#showcells");
      const magenta = await page.evaluate(async () => {
        const { NON_FINITE_COLOUR } = await import("./visualization/colormap.js");
        const h = window.__flowlab;
        const g = h.scenario.grid;
        g.u[g.idx(20, 20)] = NaN;
        h.draw();
        const c = document.querySelector("#field");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let count = 0;
        for (let k = 0; k < d.length; k += 4) {
          if (d[k] === NON_FINITE_COLOUR[0] && d[k + 1] === NON_FINITE_COLOUR[1] && d[k + 2] === NON_FINITE_COLOUR[2]) count++;
        }
        return count;
      });
      assert.ok(magenta > 0, "a non-finite cell must paint as not-finite in the smooth render");
    });
  });

  test("the colour map choice repaints magnitudes only, and says what it costs", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(250);
      await page.click("#run");
      await page.waitForTimeout(1500);
      await page.click("#pause");
      const checksum = () => page.evaluate(() => {
        const c = document.querySelector("#field");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 97) sum = (sum * 31 + d[i]) >>> 0;
        return sum;
      });
      const swatch = () => page.evaluate(() =>
        document.querySelector('#mode .swatch[data-swatch-for="velocity"]').style.background);

      const before = await readState(page);
      const turbo = await checksum();
      const turboSwatch = await swatch();
      assert.match(before.panel.viewnote, /Turbo/);

      await page.selectOption("#colormap", "viridis");
      await page.waitForTimeout(250);
      const viridis = await readState(page);
      assert.notEqual(await checksum(), turbo, "the magnitude view must repaint in the new map");
      assert.notEqual(await swatch(), turboSwatch, "and the tile must show the map it will use");
      assert.match(viridis.panel.viewnote, /Viridis: perceptually uniform/);
      assert.equal(viridis.solver.iteration, before.solver.iteration, "a colour map is not a simulation event");

      // Signed views have one map; the choice must not reach them.
      await chooseMode(page, "vorticity");
      const signedViridis = await checksum();
      await page.selectOption("#colormap", "turbo");
      await page.waitForTimeout(250);
      assert.equal(await checksum(), signedViridis, "the magnitude choice must not repaint a signed view");
    });
  });

  test("add probe arms the probe tool, and a click then pins one", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);
      await page.click("#addprobe");
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.__flowlab.pointerTool), "probe");
      assert.equal(
        await page.evaluate(() => document.querySelector('button.tool[data-tool="probe"]').classList.contains("on")),
        true, "the armed tool must show as armed in the tool list"
      );
      const [x, y] = await clientFor(page, 0.5, 0.5);
      await page.mouse.click(x, y);
      await page.waitForTimeout(200);
      assert.equal((await readState(page)).solver.probeCount, 1);
    });
  });

  test("the residual chart records one point per solver step against a fixed axis", async () => {
    // Per step, not per repaint - the same rule and the same reason as the
    // probe histories. And on an axis anchored to the bound: fitted to itself
    // this chart was a scribble of rounding noise, because every step
    // converges TO its tolerance.
    await withApp(async ({ page }) => {
      await page.selectOption("#scenario", "cavity");
      await page.waitForTimeout(200);
      assert.match(
        await page.evaluate(() => document.querySelector("#residualaxis").textContent),
        /no steps yet/
      );
      await runForSteps(page, 30);
      const recorded = await page.evaluate(() => ({
        steps: window.__flowlab.session.iteration,
        samples: window.__flowlab.session.residuals.length,
        note: document.querySelector("#residualaxis").textContent,
        worst: Math.max(...window.__flowlab.session.residuals.series().value),
      }));
      assert.ok(recorded.steps >= 30);
      assert.equal(recorded.samples, recorded.steps, "one residual per solver step");
      assert.match(recorded.note, /bound 1\.00e-7 dashed/);
      assert.match(recorded.note, /axis 1\.00e-11-1\.00e-4 \(log\)/, "the axis is fixed, not fitted");
      assert.ok(recorded.worst <= 1e-7, `a step broke its bound: ${recorded.worst}`);
      assert.equal(
        await page.evaluate(() => document.querySelector("#residualaxis").classList.contains("bad")),
        false
      );

      // Reset rebuilds the field, so the history goes with it.
      await page.click("#reset");
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => window.__flowlab.session.residuals.length), 0);
    });
  });

  test("switching the view does not touch the simulation", async () => {
    // M3's rule: changing what is displayed is a pure display change.
    await withApp(async ({ page }) => {
      await page.click("#run");
      await page.waitForTimeout(1200);
      await page.click("#pause");
      const before = await readState(page);

      // The real option ids, and no catch. The first version of this check
      // asked for a mode called "speed", which does not exist - Playwright
      // waited thirty seconds for it and threw into a swallowing catch, so the
      // check passed having switched nothing. Taken from the module that
      // defines them so the two cannot drift.
      const modes = await page.evaluate(() =>
        [...document.querySelectorAll("#mode .modetile")].map((tile) => tile.dataset.mode));
      assert.deepEqual(
        modes,
        ["velocity", "pressure", "vorticity", "shear", "q", "continuity", "dye"]
      );
      for (const mode of modes) {
        await chooseMode(page, mode);
        // Exactly one tile is selected, and it is the one clicked.
        const checked = await page.evaluate(() =>
          [...document.querySelectorAll('#mode .modetile[aria-checked="true"]')].map((t) => t.dataset.mode));
        assert.deepEqual(checked, [mode], `after choosing ${mode} the tiles read ${checked}`);
        assert.equal(
          (await readState(page)).solver.iteration, before.solver.iteration,
          `switching to ${mode} stepped the simulation`
        );
      }
      const after = await readState(page);
      assert.equal(after.solver.iteration, before.solver.iteration);
      assert.equal(after.panel.time, before.panel.time);
    });
  });

  // -------------------------------------------------------------------------
  // Experiments (M10)
  // -------------------------------------------------------------------------

  test("choosing an experiment describes it and touches nothing else", async () => {
    await withApp(async ({ page }) => {
      const before = await readState(page);
      const scenario = await page.inputValue("#scenario");
      await page.selectOption("#experiment", "sweep");
      await page.waitForTimeout(150);
      const question = await page.textContent("#expquestion");
      assert.match(question, /lid drags fluid/);
      assert.match(await page.textContent("#expreference"), /ghia1982/);
      assert.equal(await page.isDisabled("#expstop"), true, "nothing is running to stop");
      const after = await readState(page);
      assert.equal(after.solver.iteration, before.solver.iteration);
      assert.equal(await page.inputValue("#scenario"), scenario, "describing loads nothing");
    });
  });

  test("the pipe experiment runs from rest to steady and reports agreement", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#experiment", "pipe");
      await page.click("#expstart");
      assert.equal(await page.isDisabled("#expstart"), true, "one experiment at a time");
      await page.waitForFunction(() => window.__flowlab.experiment?.state !== "running", null, { timeout: 120000 });
      assert.equal(await page.evaluate(() => window.__flowlab.experiment.state), "finished");
      assert.equal(await page.inputValue("#scenario"), "pressure-channel", "the app shows the flow it measured");
      const verdicts = await page.$$eval("#expresults .expitem .expv span:last-child", (spans) => spans.map((s) => s.textContent));
      assert.deepEqual(verdicts, ["agrees", "agrees", "agrees"]);
      assert.match(await page.textContent("#expresults .runs"), /steady \(rate/);
      assert.doesNotMatch(await page.textContent("#expresults .runs"), /NOT steady/);
      assert.match(await page.textContent("#expsummary"), /outputs/);
      assert.equal(await page.isDisabled("#expstop"), true);
      assert.equal(await page.isDisabled("#expstart"), false);
      // The numbers in the panel are the runner's, not recomputed by the page.
      const measured = await page.evaluate(() => window.__flowlab.experiment.results[0].measured.meanU);
      const shown = await page.textContent("#expresults .expitem .expv span.num");
      assert.equal(shown, measured.toPrecision(4));
    });
  });

  test("a sweep run is at the Re it says, the title says so, and Stop ends it", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#experiment", "sweep");
      await page.click("#expstart");
      await page.waitForFunction(() => window.__flowlab.session.iteration > 20, null, { timeout: 60000 });
      const { Re, nu, U, L } = await page.evaluate(() => {
        const s = window.__flowlab.session.scenario;
        return { Re: s.Re, nu: s.params.nu, U: s.reference.U, L: s.reference.L };
      });
      assert.equal(Re, 100);
      assert.ok(Math.abs((U * L) / nu - 100) < 1e-9, "the solver's viscosity is Re 100's");
      assert.match(await page.textContent("#scenariotitle"), /running at Re 100/);
      assert.match(await page.textContent("#expstatus"), /run 1 of 3: Re 100/);
      await page.click("#expstop");
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.__flowlab.experiment.state), "stopped");
      assert.equal((await readState(page)).panel.status, "PAUSED", "Stop pauses the run");
      assert.match(await page.textContent("#expstatus"), /partial runs are not reported/);
      assert.equal(await page.textContent("#expresults"), "", "nothing concluded from a stopped run");
    });
  });

  test("a person's own action interrupts an experiment instead of being measured by it", async () => {
    await withApp(async ({ page }) => {
      await page.selectOption("#experiment", "sweep");
      await page.click("#expstart");
      await page.waitForFunction(() => window.__flowlab.session.iteration > 20, null, { timeout: 60000 });
      await page.click("#reset");
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.__flowlab.experiment.state), "stopped");
      assert.match(await page.textContent("#expstatus"), /stopped: .*Nothing is reported/);
      // Reset returns to the scenario as defined, so the Re the experiment set
      // does not linger - and the title and the solver agree on that.
      assert.equal(await page.evaluate(() => window.__flowlab.session.scenario.Re), 1000);
      assert.equal(await page.evaluate(() => window.__flowlab.session.scenario.params.nu), 1 / 1000);
      assert.doesNotMatch(await page.textContent("#scenariotitle"), /running at Re/);
      // And a later frame does not overwrite the reason with a generic one.
      await runForSteps(page, 10);
      assert.match(await page.textContent("#expstatus"), /Reset was pressed/);
    });
  });
});
