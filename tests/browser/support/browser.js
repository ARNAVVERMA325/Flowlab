// Support for the browser checks: finding Playwright, serving the app, and the
// page-error trap.
//
// ---------------------------------------------------------------------------
// WHY THESE EXIST AT ALL
// ---------------------------------------------------------------------------
//
// Three integration bugs reached the running app past a green node suite, and
// the reason is structural rather than careless: the node tests entered the
// system one layer below where the app does. They called step() and passed its
// arguments explicitly; the app assembles those arguments in SimulationSession
// and renders the result in Harness, and the bugs lived in the assembly and the
// rendering.
//
//   A. SolverGeometryError escaped into a requestAnimationFrame callback,
//      because tick() caught three error types and that was not one of them.
//   B. Sources were compiled for the PANEL and never handed to step(), so the
//      display described a source the solver was not running. It showed up as
//      the numbers coming out inverted - continuity 3.20e-1 against a raw
//      divergence of 7.8e-8 - rather than as any error.
//   C. addSource validated a source's SHAPE, which passed; whether it selects
//      any face the solver would update is a question about the grid, answered
//      later inside draw() where no caller was guarding. An uncaught page error.
//
// Of those, only A genuinely needs a browser. B and C are now also covered by
// session-level node tests, which is the cheaper half of the fix. What a
// browser adds that nothing else can is the run loop, the rendering, and the
// pointer events - so these checks assert BEHAVIOUR through those, not the
// presence of text in a panel.
//
// ---------------------------------------------------------------------------
// NOT A DEPENDENCY
// ---------------------------------------------------------------------------
//
// `npm test` stays node-only and dependency-free: the glob is tests/*.js and
// does not reach this directory. These run under `npm run browser`, and skip
// with instructions when Playwright is not installed rather than failing. A
// clone of this repository must remain testable by someone who has not
// installed a browser.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolved from this module, not from the caller's working directory. `npm run
// browser` always runs at the package root so a relative path happens to work
// there, but anything else - a check run by hand, a script importing this
// helper - would spawn a server that exits immediately because the path does
// not resolve. That failure then looked like "no free port", which is a
// diagnosis of the wrong thing entirely.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVE_SCRIPT = join(PROJECT_ROOT, "scripts", "serve.js");

export const SKIP_MESSAGE =
  "Playwright is not installed. These checks are optional and not a project " +
  "dependency - `npm test` does not need them. To run them: " +
  "`npm i --no-save playwright-core && npx playwright install chromium`, " +
  "then `npm run browser`.";

// Resolved once. A missing Playwright is a SKIP, not a failure - but a
// Playwright that is present and then throws is a failure, because at that
// point something is genuinely wrong.
export async function loadPlaywright() {
  try {
    return (await import("playwright-core")).chromium;
  } catch {
    return null;
  }
}

// Where to find a browser binary. Playwright's own resolution is tried first,
// so a normal `playwright install` works with no configuration; the explicit
// paths are for environments that pre-install browsers elsewhere.
function executablePaths() {
  const paths = [];
  if (process.env.FLOWLAB_CHROMIUM) paths.push(process.env.FLOWLAB_CHROMIUM);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root) {
    paths.push(`${root}/chromium/chrome-linux/chrome`);
    // Versioned directories, as a pre-installed image usually has.
    for (const version of ["1194", "1193", "1192"]) {
      paths.push(`${root}/chromium-${version}/chrome-linux/chrome`);
      paths.push(`${root}/chromium_headless_shell-${version}/chrome-linux/headless_shell`);
    }
  }
  return paths.filter((path) => existsSync(path));
}

export async function launchBrowser(chromium) {
  const args = ["--no-sandbox"];
  // Playwright's own resolution first.
  try {
    return await chromium.launch({ args });
  } catch (error) {
    for (const executablePath of executablePaths()) {
      try {
        return await chromium.launch({ args, executablePath });
      } catch { /* try the next one */ }
    }
    throw new Error(
      `Playwright is installed but no chromium binary could be launched ` +
      `(${error.message.split("\n")[0]}). Run \`npx playwright install chromium\`, ` +
      `or set FLOWLAB_CHROMIUM to a binary.`
    );
  }
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
  });
}

// Serves the app on a port of its own, so a check never collides with a server
// someone left running and never depends on one being up.
export async function startServer() {
  if (!existsSync(SERVE_SCRIPT)) {
    throw new Error(`cannot find the dev server at ${SERVE_SCRIPT}`);
  }
  // Kept so a failure can say WHY rather than blaming the port scan.
  const reasons = [];
  for (let port = 8391; port < 8420; port++) {
    if (await portIsOpen(port)) { reasons.push(`${port}: already in use`); continue; }
    const child = spawn(process.execPath, [SERVE_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const failed = once(child, "exit").then(([code]) =>
      `exited with code ${code}${stderr ? `: ${stderr.trim().split("\n")[0]}` : ""}`);
    const ready = (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await portIsOpen(port)) return "ready";
        await new Promise((r) => setTimeout(r, 50));
      }
      return "timeout";
    })();
    const outcome = await Promise.race([ready, failed]);
    if (outcome === "ready") {
      return { url: `http://127.0.0.1:${port}/index.html`, stop: () => child.kill() };
    }
    reasons.push(`${port}: ${outcome}`);
    child.kill();
  }
  throw new Error(
    `could not start the dev server on any port in 8391-8419:\n  ` +
    `${reasons.slice(0, 5).join("\n  ")}`
  );
}

// A page with the error trap armed.
//
// EVERY uncaught exception and console error is collected, and assertNoErrors
// turns them into a test failure. That is the whole of bug A's class: an
// exception thrown inside a requestAnimationFrame callback reaches nothing a
// test would normally look at, and the app carries on looking fine until the
// next frame that needed the thing that threw.
export async function openApp(browser, url, { width = 1280, height = 1000 } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`uncaught: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__flowlab), null, { timeout: 10000 });
  return {
    page,
    errors,
    assertNoErrors(where) {
      if (errors.length === 0) return;
      const listed = errors.join("\n  ");
      errors.length = 0;
      throw new Error(`the page reported errors during ${where}:\n  ${listed}`);
    },
  };
}

// Physical coordinates to client pixels, computed in the page from the harness's
// own layout - the same numbers the drawing code uses.
export function clientFor(page, x, y) {
  return page.evaluate(([x, y]) => {
    const l = window.__flowlab.layout();
    const px = l.margin + (x / l.h) * l.scale;
    const py = l.margin + (l.ny - y / l.h) * l.scale;
    return [
      l.rect.left + px * (l.rect.width / l.canvasWidth),
      l.rect.top + py * (l.rect.height / l.canvasHeight),
    ];
  }, [x, y]);
}

export async function drag(page, from, to, { steps = 6, hold = false } = {}) {
  const [x0, y0] = await clientFor(page, ...from);
  const [x1, y1] = await clientFor(page, ...to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let n = 1; n <= steps; n++) {
    await page.mouse.move(x0 + ((x1 - x0) * n) / steps, y0 + ((y1 - y0) * n) / steps);
    await page.waitForTimeout(20);
  }
  if (!hold) {
    await page.mouse.up();
    await page.waitForTimeout(80);
  }
}

// What the panel says AND what the solver holds, read together.
//
// Read together deliberately. Bug B produced no error and no obviously wrong
// text - the panel faithfully reported a solver that was not running the source
// it was drawing. Only comparing the two, or asserting the physics end to end,
// finds that.
export function readState(page) {
  return page.evaluate(() => {
    const text = (id) => document.querySelector(id)?.textContent?.trim() ?? null;
    const h = window.__flowlab;
    const g = h.scenario.grid;
    let peakSpeed = 0;
    let dye = 0;
    let solidCells = 0;
    for (let j = 1; j <= g.ny; j++) {
      for (let i = 1; i <= g.nx; i++) {
        const k = g.idx(i, j);
        if (g.solid[k]) { solidCells++; continue; }
        peakSpeed = Math.max(peakSpeed, Math.hypot(g.u[k], g.v[k]));
        dye += h.tracer.c[k];
      }
    }
    return {
      panel: {
        status: text("#status"), field: text("#fieldstate"),
        iteration: Number(text("#iteration")), time: text("#time"),
        divmax: text("#divmax"), imposed: text("#imposed"),
        imposedHidden: document.querySelector("#imposed").hidden,
        vclass: text("#vclass"), regions: text("#bcregions"),
        net: text("#bcnet"), drawstatus: text("#drawstatus"),
        srccount: text("#srccount"), srcbrush: text("#srcbrush"),
        banner: document.querySelector("#banner").hidden ? null : text("#banner"),
      },
      solver: {
        iteration: h.session.iteration,
        state: h.state,
        scenarioId: h.scenarioId,
        solidCells, peakSpeed, dye,
        sourceCount: h.session.sources === null ? 0 : h.session.sources.length,
        placedCount: h.session.placedSources.length,
        brushLive: h.session.brushSource !== null,
        bc: JSON.parse(JSON.stringify(h.session.bc)),
        maskVersion: g.maskVersion,
        operations: h.session.document.operations.length,
      },
    };
  });
}
