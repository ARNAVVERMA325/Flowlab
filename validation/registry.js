// The validation registry: what this project claims, against what, and how
// well the reference behind each claim is actually known.
//
// This is the single declaration consumed by three things - the test suite,
// the generated validation record in docs/VALIDATION.md, and the harness panel.
// Before it existed, a reference value could sit in a test file with its
// provenance in a comment written to whatever standard that day allowed, and
// nothing forced two different claims to be held to the same standard.
//
// ---------------------------------------------------------------------------
// CLASSIFICATION - what kind of thing a case's agreement actually establishes
// ---------------------------------------------------------------------------
//
//   benchmarked      Checked against a reference external to this project: a
//                    closed-form solution, or published measurements. Being
//                    wrong here is detectable from outside.
//
//   self-validated   Checked against exact invariants the problem must satisfy
//                    (mass conservation, symmetry, a fixed point) and against
//                    its own grid convergence. Strong evidence that the solver
//                    solves what it claims to solve, but it cannot detect a
//                    consistent error in the model itself. Nothing external
//                    says the answer is right.
//
//   demonstration    Neither. Runs and looks plausible. No case here is this,
//                    and the harness must be able to say so when one is.
//
// The distinction is the point. A lid-driven cavity agreeing with Ghia to 0.4%
// and a 90-degree bend separating where physical reasoning says it should are
// not the same kind of statement, and a viewer who cannot tell them apart is
// being misled by omission.
//
// ---------------------------------------------------------------------------
// REFERENCE VERIFICATION - how much the reference itself can be trusted
// ---------------------------------------------------------------------------
//
//   derived          A closed-form result reproducible from the governing
//                    equations. Nothing to transcribe, so nothing to get wrong.
//   verified         Transcribed from a publication AND cross-referenced
//                    against an independent source.
//   unverified       Recalled or single-sourced. Believed correct, not checked.
//
// The level describes the NUMBERS, not the citation. Confirming that a cited
// paper is real, correctly attributed and genuinely the standard source does
// not verify the values attached to it, and a reference in that state is
// arguably more dangerous than an obviously unsourced one: the citation reads
// as authority the numbers have not earned. An unverified reference must
// therefore also declare `blocker` - what closing it would actually take - so
// that "unverified" is a piece of work someone can pick up rather than a
// permanent shrug.
//
// The third label is not decoration. The Ghia tables sat at "unverified" for
// most of this project's life and turned out to contain one wrong digit that
// was materially changing a reported error. Anything still carrying that label
// should be assumed to have the same problem until someone checks it.
//
// ---------------------------------------------------------------------------
// EVERY CLAIM HERE IS CONDITIONAL ON THE DOMAIN
// ---------------------------------------------------------------------------
//
// Until M5 this went without saying: the geometry of each case was fixed in
// code, so "the cylinder is benchmarked" and "the domain on screen is the
// cylinder" were the same statement. Once geometry can be drawn they are not.
// A recorded wake length shown beside a cylinder the viewer has just erased is
// the exact failure this registry exists to prevent, wearing the registry's
// own clothes.
//
// So the classifications below describe each case's OWN geometry and nothing
// else. When the domain differs, the measurements do not apply and are
// withdrawn rather than annotated - a caveat under a table of numbers is read
// after the numbers. The panel does that in ui/validationPanel.js, on a flag
// the session computes by comparing the sampled MASK against the scenario's
// own (ui/session.js).
//
// The mask, specifically - not an edit counter and not a document comparison.
// Both proxies are wrong on ordinary gestures and both err toward crying wolf:
// a document edited and undone back has a nonzero revision and an identical
// domain, and a shape drawn inside an existing wall changes the document and
// no cells. Asking the property of interest rather than a proxy for it is the
// same rule that produced the RHS-consistency detector in solver/ns2d.js; see
// docs/M5-interactive-geometry.md sections 6 and 9.
//
// Nothing here validates a drawn domain, and nothing could: there is no
// reference for a shape someone just drew. What survives an edit is the
// solver's own invariants - divergence, flux balance, finiteness - which the
// harness reports live and which hold on any domain the solver accepts.

export const CLASSIFICATIONS = ["benchmarked", "self-validated", "demonstration"];
export const VERIFICATION_LEVELS = ["derived", "verified", "unverified"];

export const REFERENCES = {
  ghia1982: {
    id: "ghia1982",
    citation:
      "Ghia, U., Ghia, K. N., & Shin, C. T. (1982). High-Re solutions for " +
      "incompressible flow using the Navier-Stokes equations and a multigrid " +
      "method. Journal of Computational Physics, 48(3), 387-411.",
    verification: "verified",
    verificationNote:
      "Cross-referenced against an independent public transcription, one source " +
      "per table. The check found one wrong digit in the previous recalled " +
      "transcription (Re=1000, x=0.9063: -0.51550 against a true -0.51500) which " +
      "was setting the reported Re=1000 error. One published point is excluded " +
      "as unreliable - see tests/support/ghia.js EXCLUDED_POINTS.",
  },

  analyticalDiffusion: {
    id: "analyticalDiffusion",
    citation:
      "Closed-form solutions of the 1D heat equation: the decaying mode " +
      "u = U0*cos(k*y)*exp(-nu*k^2*t) and the spreading error-function layer " +
      "u = (U0/2)(1 + erf((y-y0)/(2*sqrt(nu*t)))).",
    verification: "derived",
    verificationNote:
      "Reproducible from the governing equations. For a unidirectional flow the " +
      "nonlinear and pressure terms vanish identically, so the momentum equation " +
      "collapses onto the heat equation exactly - the tests assert that collapse " +
      "rather than assuming it.",
  },

  planePoiseuille: {
    id: "planePoiseuille",
    citation:
      "Plane Poiseuille flow: for a channel of width w with mean velocity U, " +
      "u(y) = 1.5*U*(1 - (2(y-yc)/w)^2) and dp/dx = -12*mu*U/w^2.",
    verification: "derived",
    verificationNote: "Standard closed-form result, reproducible from the equations.",
  },

  cylinderWakeLength: {
    id: "cylinderWakeLength",
    citation:
      "Steady recirculation length behind a circular cylinder in unbounded " +
      "flow, L/D ~ 0.93 at Re=20 and ~2.3 at Re=40. Usually attributed to " +
      "Coutanceau & Bouard (1977), J. Fluid Mech. 79(2), 231-256, and to " +
      "Tritton (1959), J. Fluid Mech. 6, 547-567.",
    verification: "unverified",
    verificationNote:
      "THE NUMBERS ARE STILL RECALLED, NOT CHECKED. A partial check has since " +
      "confirmed the citation but not the values. Coutanceau & Bouard (1977), " +
      "J. Fluid Mech. 79, is a real paper, correctly attributed here, and is " +
      "the standard experimental benchmark that numerical work compares against " +
      "for cylinder wake length at Re < 40 - so the attribution is sound. What " +
      "could not be obtained is the part this project actually depends on: the " +
      "figures L/D ~ 0.93 at Re=20 and ~2.3 at Re=40 still come from recall, " +
      "not from any source that could be checked. That is why this stays " +
      "`unverified` rather than being upgraded on the strength of the citation. " +
      "Published values also differ by a few percent between sources (2.24 to " +
      "2.35 at Re=40 is commonly quoted), which is part of why the test asserts " +
      "a band rather than a point. This remains the weakest reference in the " +
      "project.",
    blocker:
      "The 1977 paper is paywalled and its table could not be reached from any " +
      "openly available source. Closing this needs either institutional or " +
      "library access to the original, or a secondary paper that digitises and " +
      "reproduces those exact figures. Recorded as a known limitation and left " +
      "open deliberately, not pursued further.",
  },
};

// Each case records what it establishes and how. `claims` are the specific
// comparisons; `measuredBy` names the test that asserts them.
export const CASES = [
  {
    id: "still-water",
    label: "Still water",
    classification: "self-validated",
    measuredBy: "tests/test1_still_water.js",
    rationale:
      "u = 0 is an exact fixed point of the discretised equations, so this is " +
      "an invariant rather than a comparison. It cannot be close - it is either " +
      "exact or the solver is manufacturing motion from nothing.",
    claims: [
      { quantity: "max|u| after 50 steps", reference: 0, tolerance: 1e-10, referenceType: "invariant" },
      { quantity: "max|div u|", reference: 0, tolerance: 1e-10, referenceType: "invariant" },
    ],
  },
  {
    id: "uniform-channel",
    label: "Uniform channel flow",
    classification: "self-validated",
    measuredBy: "tests/test2_channel_flow.js",
    rationale:
      "A uniform plug flow with no-penetration, zero-gradient walls is another " +
      "exact fixed point. Isolates whether the projection preserves a trivial " +
      "solution.",
    claims: [
      { quantity: "max|u - U0|", reference: 0, tolerance: 1e-6, referenceType: "invariant" },
      { quantity: "max|div u|", reference: 0, tolerance: 1e-6, referenceType: "invariant" },
    ],
  },
  {
    id: "viscous-diffusion",
    label: "Viscous diffusion",
    classification: "benchmarked",
    measuredBy: "tests/test3_viscous_diffusion.js",
    reference: "analyticalDiffusion",
    rationale:
      "Compared against exact closed-form solutions. The construction makes the " +
      "nonlinear and pressure terms vanish identically, which the test verifies " +
      "by requiring v and divergence to stay at exactly zero, so this isolates " +
      "the diffusion term alone.",
    claims: [
      { quantity: "decay rate vs nu*k^2 (relative)", reference: 0, tolerance: 1e-3, referenceType: "analytical" },
      { quantity: "spatial convergence order", reference: 2, tolerance: 0.3, referenceType: "analytical" },
      { quantity: "spreading-layer profile error", reference: 0, tolerance: 2e-4, referenceType: "analytical" },
    ],
  },
  {
    id: "lid-driven-cavity",
    label: "Lid-driven cavity",
    classification: "benchmarked",
    measuredBy: "tests/test4_lid_driven_cavity.js",
    reference: "ghia1982",
    rationale:
      "The standard 2D incompressible benchmark and the go/no-go gate for this " +
      "solver. The first case where advection and pressure are both live.",
    claims: [
      { quantity: "max|u - Ghia| at Re=100", reference: 0, tolerance: 0.015, referenceType: "published" },
      { quantity: "max|v - Ghia| at Re=100", reference: 0, tolerance: 0.015, referenceType: "published" },
      { quantity: "max|u - Ghia| at Re=400", reference: 0, tolerance: 0.015, referenceType: "published" },
      { quantity: "max|u - Ghia| at Re=1000", reference: 0, tolerance: 0.035, referenceType: "published" },
      { quantity: "self-convergence order", reference: 2, tolerance: 0.3, referenceType: "self-convergence" },
    ],
  },
  {
    id: "cylinder-wake",
    label: "Flow past a circular cylinder",
    classification: "benchmarked",
    measuredBy: "tests/test5_flow_around_obstacle.js",
    reference: "cylinderWakeLength",
    rationale:
      "Wake length compared against published values for an unbounded cylinder, " +
      "which requires accounting for channel blockage: the measured length rises " +
      "monotonically toward the published figure as the channel widens. The " +
      "structural invariants (exact zero velocity on the body, flux conserved " +
      "through every cut, a symmetric answer to a symmetric problem) hold to " +
      "roundoff and are what the case mostly rests on.",
    caveat:
      "The reference VALUES behind this case are UNVERIFIED. The citation has " +
      "been confirmed as real, correctly attributed and the standard source for " +
      "this measurement, but the specific numbers attributed to it have not " +
      "been checked against it. The agreement is also indirect - it is a trend " +
      "toward the published number under reducing blockage, not a direct match " +
      "at a stated condition.",
    claims: [
      { quantity: "wake L/D at Re=20, 6% blockage", reference: 0.93, tolerance: 0.15, relative: true, referenceType: "published" },
      { quantity: "separation onset below Re~5", reference: 0, tolerance: 0, referenceType: "published" },
      { quantity: "velocity on the body surface", reference: 0, tolerance: 0, referenceType: "invariant" },
      { quantity: "flux deviation through all cuts (relative)", reference: 0, tolerance: 1e-7, referenceType: "invariant" },
      { quantity: "centreline asymmetry", reference: 0, tolerance: 1e-9, referenceType: "invariant" },
    ],
  },
  {
    id: "channel-bend",
    label: "90-degree channel bend",
    classification: "self-validated",
    measuredBy: "tests/test6_channel_bend.js",
    reference: "planePoiseuille",
    rationale:
      "There is no published reference for this geometry, so the bend's own " +
      "behaviour - separation off the sharp inner corner, suppression when the " +
      "corner is radiused, flow thrown toward the outer wall, higher pressure on " +
      "the outer wall - is checked against physical reasoning and exact " +
      "invariants, not against measurements. What IS benchmarked is the inlet " +
      "leg, which carries fully developed plane Poiseuille flow with a " +
      "closed-form profile and pressure gradient. That analytical anchor inside " +
      "the same geometry is what makes the bend numbers worth believing.",
    caveat:
      "The bend results themselves are NOT benchmarked. No external source says " +
      "the separation bubble should be 1.555w at Re=200; it is reported because " +
      "the solver is trusted, not the other way round.",
    claims: [
      { quantity: "inlet-leg dp/dx vs -12*mu*U/w^2 (relative)", reference: 0, tolerance: 0.02, referenceType: "analytical" },
      { quantity: "inlet-leg profile convergence order", reference: 2, tolerance: 0.3, referenceType: "analytical" },
      { quantity: "flux deviation through all cuts (relative)", reference: 0, tolerance: 1e-6, referenceType: "invariant" },
      { quantity: "velocity on the duct walls", reference: 0, tolerance: 0, referenceType: "invariant" },
      { quantity: "sharp bend separates at the inner corner", reference: null, tolerance: null, referenceType: "physical-reasoning" },
      { quantity: "radiusing suppresses the separation", reference: null, tolerance: null, referenceType: "physical-reasoning" },
    ],
  },
  {
    id: "pressure-driven-channel",
    label: "Pressure-driven channel",
    classification: "benchmarked",
    measuredBy: "tests/test10_m4_boundary_conditions.js",
    reference: "planePoiseuille",
    rationale:
      "The M4 pressure boundary condition checked against closed form. Nothing " +
      "prescribes the flow rate here: the pressure is fixed at both ends, the " +
      "projection determines the velocity through them, and the steady answer " +
      "must be U_mean = dp*w^2/(12*mu*L). That makes it a genuine prediction " +
      "rather than a restatement of an input, which is what separates this from " +
      "the velocity-inlet cases. The convergence ORDER carries more weight here " +
      "than any single error figure: a wrongly implemented boundary can be " +
      "accidentally close on one grid, but it does not converge at second order " +
      "to the right answer. The residual is the no-slip WALL treatment rather " +
      "than the pressure ends - reflecting no-slip into the ghost is exact for a " +
      "linear profile and O(h^2) for a parabolic one - which is why the local " +
      "dp/dx error tracks the global rate error to three digits.",
    caveat:
      "The agreement is RESOLUTION-QUALIFIED. 0.195% at 32 cells across the " +
      "channel and 0.781% at 16, but 1.389% at 12: a coarse channel flows " +
      "measurably too freely. What is prescribed is also the projection " +
      "variable, which approximates the true pressure to O(dt) and carries a " +
      "known error layer near walls, so the pressure NUMBER at the boundary is " +
      "not an engineering-grade static pressure even though the flow it drives " +
      "is right.",
    claims: [
      { quantity: "U_mean vs dp*w^2/(12*mu*L) at 32 cells (relative)", reference: 0, tolerance: 0.01, referenceType: "analytical" },
      { quantity: "U_mean vs dp*w^2/(12*mu*L) at 16 cells (relative)", reference: 0, tolerance: 0.02, referenceType: "analytical" },
      { quantity: "convergence order of the flow-rate error", reference: 2, tolerance: 0.2, referenceType: "analytical" },
      { quantity: "flux deviation inlet to outlet", reference: 0, tolerance: 1e-8, referenceType: "invariant" },
      { quantity: "flow-rate inlet delivered vs requested (relative)", reference: 0, tolerance: 1e-13, referenceType: "invariant" },
    ],
  },
  {
    id: "drawn-geometry",
    label: "Drawn geometry and surface conditions",
    classification: "self-validated",
    measuredBy: "tests/test11_m5_geometry.js",
    rationale:
      "The M5 geometry pipeline, checked against exact invariants only. Two " +
      "things are established here and nothing else. First, that expressing the " +
      "existing scenarios as geometry documents reproduces their masks CELL FOR " +
      "CELL - the claim every other case in this record silently depends on, " +
      "since a benchmark measured on one domain says nothing about another. " +
      "Second, that conditions attached to drawn surfaces behave exactly like " +
      "the domain-edge conditions M4 validated: a prescribed rate through a " +
      "surface is delivered to roundoff, no-slip on a drawn wall is exactly " +
      "zero, and the projection still delivers its divergence bound with a " +
      "surface driving the flow. The last is a regression guard with history: " +
      "when the flux balance counted surface outflow but not surface inflow, " +
      "the rate was delivered exactly while the field carried a divergence of " +
      "5.3e-2 against a bound of 1e-7, and nothing threw.",
    caveat:
      "Nothing here is benchmarked and nothing here validates a DRAWN domain - " +
      "there is no external reference for a shape someone just drew. These are " +
      "invariants that hold on any domain the solver accepts. Drawn shapes are " +
      "also sampled onto the uniform grid rather than meshed, so the staircase " +
      "error of about one cell applies to anything drawn.",
    claims: [
      { quantity: "cells differing between document and original predicate (3 scenarios)", reference: 0, tolerance: 0, referenceType: "invariant" },
      { quantity: "surface flow rate delivered vs requested", reference: 0, tolerance: 1e-12, referenceType: "invariant" },
      { quantity: "velocity on drawn solid surfaces", reference: 0, tolerance: 0, referenceType: "invariant" },
      { quantity: "max|div u| with a surface inlet driving the flow", reference: 0, tolerance: 1e-7, referenceType: "invariant" },
    ],
  },
  {
    id: "interior-sources",
    label: "Interior sources",
    classification: "self-validated",
    measuredBy: "tests/test13_m6_sources.js",
    rationale:
      "The M6 source model, against exact invariants only. Three things are " +
      "established. A MASS source delivers the volume it asks for: the flux " +
      "leaving through the outlet equals the requested rate to twelve digits, " +
      "which is a real check because nothing prescribes that flux - the " +
      "projection determines it. A MOMENTUM source cannot carry a face past " +
      "its target, which is what makes the timestep sizeable against it and is " +
      "checked at relaxation times from far below the timestep to far above " +
      "it. And the solver still delivers its continuity bound with a source " +
      "driving the flow - measured against what the sources ask for, max " +
      "|div u - q|, because with a mass source running max|div u| is q by " +
      "design and reads 1.8 where the bound is 1e-7.",
    caveat:
      "Nothing here is benchmarked and nothing here validates a source's " +
      "PHYSICAL realism - a source is a boundary condition applied in the " +
      "interior, not a model of a pump or a nozzle, and no external reference " +
      "says what one should do. These are invariants. The brush's speed is a " +
      "control rather than a measurement of hand motion, for the reason given " +
      "in docs/M6-sources.md: pointer time is wall-clock and fluid time is " +
      "simulated, so any mapping between them is invented.",
    claims: [
      { quantity: "mass source: flux delivered vs requested", reference: 0, tolerance: 1e-11, referenceType: "invariant" },
      { quantity: "continuity error with a source driving the flow", reference: 0, tolerance: 1e-7, referenceType: "invariant" },
      { quantity: "momentum source: overshoot past its target in one step", reference: 0, tolerance: 0, referenceType: "invariant" },
      { quantity: "golden fields moved by compiling the source path in", reference: 0, tolerance: 0, referenceType: "invariant" },
    ],
  },
];

// Harness scenarios map onto cases. A scenario the panel can show but that no
// case validates would be a "demonstration", and the panel must say so rather
// than presenting it like the rest.
//
// A mapping asserts the case validates the scenario AS THE SCENARIO DEFINES
// IT. Nothing here survives the geometry being edited; see the note above.
// `benchmarkedAt` names the condition the case's external comparison was
// actually measured at, when that differs from the condition the scenario runs
// at. The panel compares it against the live scenario and says so.
//
// The cylinder is the case in point and it is not a small gap: the scenario
// runs at Re = 100, where a real cylinder sheds a vortex street, while the
// benchmark is a steady wake length at Re = 20. The panel said "benchmarked"
// beside a picture of a different flow. The generic note - "recorded results
// for the validated configuration, not a measurement of the run on screen" -
// covers it in principle and is far too quiet for a difference that large.
//
// Stated as a NUMBER compared against the scenario's own Re rather than as a
// sentence, so it cannot drift: change a scenario's Reynolds number and the
// panel starts or stops warning on its own.
export const SCENARIO_VALIDATION = {
  "bend-sharp": { case: "channel-bend" },
  "bend-smooth": { case: "channel-bend" },
  cylinder: { case: "cylinder-wake", benchmarkedAt: { Re: 20 } },
  cavity: { case: "lid-driven-cavity" },
  "pressure-channel": { case: "pressure-driven-channel" },
  // The segmented jet demonstrates the M4 boundary model; no case validates the
  // jet itself, so the panel will correctly call it a demonstration.
};

export function caseById(id) {
  return CASES.find((c) => c.id === id) ?? null;
}

export function referenceFor(caseId) {
  const entry = caseById(caseId);
  return entry?.reference ? REFERENCES[entry.reference] : null;
}

// What the panel should say about a scenario: its classification, the strength
// of the reference behind it, and any caveat attached.
export function validationForScenario(scenarioId) {
  const mapping = SCENARIO_VALIDATION[scenarioId];
  if (!mapping) {
    return {
      classification: "demonstration",
      caseId: null,
      label: "no validation case",
      reference: null,
      caveat: "Nothing in the validation registry covers this scenario.",
    };
  }
  const entry = caseById(mapping.case);
  const reference = entry.reference ? REFERENCES[entry.reference] : null;
  return {
    classification: entry.classification,
    caseId: entry.id,
    label: entry.label,
    reference,
    benchmarkedAt: mapping.benchmarkedAt ?? null,
    caveat: entry.caveat ?? null,
    measuredBy: entry.measuredBy,
  };
}
