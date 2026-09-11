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

      await page.waitForTimeout(700);
      const during = await readState(page);
      assert.ok(
        during.solver.peakSpeed > before.solver.peakSpeed * 1.2,
        `the stroke must move the fluid: ${before.solver.peakSpeed} -> ${during.solver.peakSpeed}`
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
        [...document.querySelectorAll("#mode option")].map((o) => o.value));
      assert.deepEqual(modes, ["velocity", "pressure", "dye"]);
      for (const mode of modes) {
        await page.selectOption("#mode", mode);
        await page.waitForTimeout(120);
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
});
