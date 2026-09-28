// Saving and loading a FlowLab project.
//
// A project is the SETUP, not the flow: the scenario, the drawn geometry, the
// boundary conditions, the placed sources, the probe positions, the fluid or
// Reynolds number, and how the view was arranged. The flow field is left out
// on purpose, because it is not needed: the solver is deterministic, so the
// same setup run the same number of steps gives the same field to the last
// bit. A test proves exactly that - save, load into a fresh session, run, and
// compare bytes - which is a stronger statement about a saved project than
// "the arrays were written out and read back".
//
// Loading is validated in full before anything changes: an unknown scenario, a
// malformed geometry document, a boundary condition the compiler rejects or a
// source that selects no face refuses the whole file with the reason, and the
// session is left exactly as it was.

import { SCENARIOS } from "../scenarios/index.js";

export const PROJECT_FORMAT = "flowlab-project";
export const PROJECT_VERSION = 1;

export class ProjectError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectError";
  }
}

// Plain JSON-safe copy - the frozen editor specs and the documents are made of
// plain objects and arrays, so a structured round trip through JSON is exact.
const plain = (value) => JSON.parse(JSON.stringify(value));

export function projectFrom(session, view = null) {
  const { overrides } = session;
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    scenario: session.scenarioId,
    geometry: plain(session.document),
    boundaries: plain(session.bc),
    sources: plain(session.placedSources),
    probes: session.probes.probes.map(({ x, y }) => ({ x, y })),
    fluid: overrides.material ? plain(overrides.material) : null,
    Re: overrides.Re ?? null,
    view: view === null ? null : plain(view),
  };
}

// Shape checks only - everything that needs a grid to judge (does this source
// select a face, does this boundary compile) is judged by the session, by the
// same code that judges an edit made in the app.
export function checkProject(project) {
  if (!project || typeof project !== "object") throw new ProjectError("not a project: expected a JSON object");
  if (project.format !== PROJECT_FORMAT) {
    throw new ProjectError(`not a FlowLab project (format "${project.format}", expected "${PROJECT_FORMAT}")`);
  }
  if (project.version !== PROJECT_VERSION) {
    throw new ProjectError(`project version ${project.version} is not one this build reads (it reads ${PROJECT_VERSION})`);
  }
  if (!SCENARIOS.some((entry) => entry.id === project.scenario)) {
    throw new ProjectError(`unknown scenario "${project.scenario}"`);
  }
  if (!project.geometry || !Array.isArray(project.geometry.operations)) {
    throw new ProjectError("the project has no geometry document");
  }
  if (!project.boundaries || typeof project.boundaries !== "object") {
    throw new ProjectError("the project has no boundary conditions");
  }
  if (!Array.isArray(project.sources)) throw new ProjectError("the project's sources are not a list");
  if (!Array.isArray(project.probes) || project.probes.some((p) => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) {
    throw new ProjectError("the project's probes are not a list of positions");
  }
  if (project.fluid !== null && project.Re !== null) {
    throw new ProjectError("a project sets a fluid or a Reynolds number, not both");
  }
  return project;
}

export function parseProject(text) {
  let project;
  try {
    project = JSON.parse(text);
  } catch (error) {
    throw new ProjectError(`not valid JSON: ${error.message}`);
  }
  return checkProject(project);
}
