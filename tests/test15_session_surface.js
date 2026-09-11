// Working agreement item 9, made mechanical.
//
// The rule says a feature reachable through SimulationSession gets a test that
// goes through the session. A rule like that decays into a good intention
// unless something checks it, so this enumerates the session's public surface
// and asserts each entry is actually exercised from a test.
//
// It is the same shape as M4's boundary-fixture coverage test, which found two
// unguarded type-and-side combinations the moment it existed. The point is not
// that these operations are hard to test - it is that "did anyone remember" is
// not a question a person should be answering.
//
// WHY THIS RULE EXISTS
//
// Three integration bugs reached the running app past a green suite. Two of
// them - sources compiled for the panel and never handed to step(), and a
// source passing shape validation then throwing from draw() - were node
// testable all along. Nothing had asked the question, because the tests called
// step() and passed its arguments explicitly while the app assembles them in
// the session. The tests entered the system one layer below where the app does.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SimulationSession } from "../ui/session.js";
import { publicSurface, stripComments } from "./support/sourceScan.js";

// Solver-level test files. These are about the numerics rather than about
// anything the app assembles, so they legitimately call step() directly and are
// not searched for session usage.
const SOLVER_TESTS = new Set([
  "test1_still_water.js",
  "test2_channel_flow.js",
  "test3_viscous_diffusion.js",
  "test4_lid_driven_cavity.js",
  "test5_flow_around_obstacle.js",
  "test6_channel_bend.js",
  "test7_m1_hardening.js",
  "test8_validation_registry.js",
  "test9_m3_visualization.js",
]);

function testSources() {
  const sources = [];
  for (const file of readdirSync("tests")) {
    if (!file.endsWith(".js") || SOLVER_TESTS.has(file)) continue;
    sources.push(stripComments(readFileSync(join("tests", file), "utf8")));
  }
  for (const file of readdirSync(join("tests", "browser"))) {
    if (!file.endsWith(".js")) continue;
    sources.push(stripComments(readFileSync(join("tests", "browser", file), "utf8")));
  }
  return sources.join("\n");
}

test("item 9 - every session operation is exercised through the session", () => {
  const surface = publicSurface(SimulationSession);
  const corpus = testSources();

  const untested = surface.filter((name) => {
    // A method call, or a getter read. Deliberately loose about the receiver:
    // tests name the variable `session`, `plain`, `withSource` and so on, and
    // pinning the name would make this check about spelling.
    const called = new RegExp(`\\.${name}\\s*\\(`);
    const read = new RegExp(`\\.${name}\\b`);
    return !(called.test(corpus) || read.test(corpus));
  });

  assert.deepEqual(
    untested, [],
    `these SimulationSession operations have no test that goes through the session:\n  ` +
    `${untested.join("\n  ")}\n` +
    `Working agreement item 9: a feature reachable through the session is tested there, ` +
    `not one layer below it.`
  );
  console.log(
    `[item 9] all ${surface.length} public SimulationSession operations are exercised ` +
    `through the session`
  );
});

test("item 9 - the browser checks cover every interactive control", () => {
  // The second half of the rule: a UI milestone is not complete until a
  // committed browser check covers the new interaction. Controls are read from
  // index.html rather than listed here, so a control added without a check
  // fails this rather than being remembered about.
  const markup = readFileSync("index.html", "utf8");
  const ids = [...markup.matchAll(/id="([a-z][a-z0-9]*)"/gi)].map((m) => m[1]);

  // Readouts are written BY the app and are covered by asserting the values the
  // checks already read; what has to be driven is the things a person operates.
  const interactive = ids.filter((id) =>
    new RegExp(`<(button|select|input)[^>]*\\bid="${id}"`, "i").test(markup)
  );

  const browserChecks = readdirSync(join("tests", "browser"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => stripComments(readFileSync(join("tests", "browser", f), "utf8")))
    .join("\n");

  const undriven = interactive.filter((id) => !browserChecks.includes(`#${id}`));
  assert.deepEqual(
    undriven, [],
    `these controls exist in the UI and no browser check touches them:\n  ` +
    `${undriven.map((id) => `#${id}`).join("\n  ")}\n` +
    `Working agreement item 9: a UI milestone is not complete until npm run browser ` +
    `covers the new interaction.`
  );
  console.log(`[item 9] all ${interactive.length} interactive controls are driven by a browser check`);
});
