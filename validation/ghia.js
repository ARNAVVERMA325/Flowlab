// Lid-driven cavity benchmark data from:
//
//   U. Ghia, K. N. Ghia, C. T. Shin (1982),
//   "High-Re Solutions for Incompressible Flow Using the Navier-Stokes
//    Equations and a Multigrid Method",
//   Journal of Computational Physics 48(3), 387-411.
//   Table I  - u along the vertical line through the cavity centre (x = 0.5)
//   Table II - v along the horizontal line through the cavity centre (y = 0.5)
//
// Their solutions used a 129x129 uniform grid. The cavity is the unit square
// with the top lid sliding at u = 1 and no-slip on the other three walls.
//
// PROVENANCE
// ----------
// These values are cross-referenced against an independent public
// transcription of the paper - two separate sources, one per table - rather
// than taken from a single place or from recall.
//
// They previously WERE from recall, and carried a warning saying so. That
// warning was justified: checking them against the verified transcription
// found one wrong digit, at Re=1000, x=0.9063, where the recalled value was
// -0.51550 against a true -0.51500. Every other one of the 102 entries across
// both tables was correct. The error sat at the same x station as the excluded
// point below, which is presumably why the two got conflated.
//
// The x = 0.9063 anomaly at Re=400 is a different thing entirely, and is NOT a
// transcription error - see EXCLUDED_POINTS.

// Vertical centreline (x = 0.5), published top-to-bottom.
export const Y = [
  1.0, 0.9766, 0.9688, 0.9609, 0.9531, 0.8516, 0.7344, 0.6172, 0.5,
  0.4531, 0.2813, 0.1719, 0.1016, 0.0703, 0.0625, 0.0547, 0.0,
];

export const U_CENTRELINE = {
  100: [
    1.0, 0.84123, 0.78871, 0.73722, 0.68717, 0.23151, 0.00332, -0.13641,
    -0.20581, -0.2109, -0.15662, -0.1015, -0.06434, -0.04775, -0.04192,
    -0.03717, 0.0,
  ],
  400: [
    1.0, 0.75837, 0.68439, 0.61756, 0.55892, 0.29093, 0.16256, 0.02135,
    -0.11477, -0.17119, -0.32726, -0.24299, -0.14612, -0.10338, -0.09266,
    -0.08186, 0.0,
  ],
  1000: [
    1.0, 0.65928, 0.57492, 0.51117, 0.46604, 0.33304, 0.18719, 0.05702,
    -0.0608, -0.10648, -0.27805, -0.38289, -0.2973, -0.2222, -0.20196,
    -0.18109, 0.0,
  ],
};

// Horizontal centreline (y = 0.5), published right-to-left.
export const X = [
  1.0, 0.9688, 0.9609, 0.9531, 0.9453, 0.9063, 0.8594, 0.8047, 0.5,
  0.2344, 0.2266, 0.1563, 0.0938, 0.0781, 0.0703, 0.0625, 0.0,
];

export const V_CENTRELINE = {
  100: [
    0.0, -0.05906, -0.07391, -0.08864, -0.10313, -0.16914, -0.22445,
    -0.24533, 0.05454, 0.17527, 0.17507, 0.16077, 0.12317, 0.1089, 0.10091,
    0.09233, 0.0,
  ],
  // Index 5 (x = 0.9063) carries the published value -0.23827 and is excluded
  // from comparison, not altered. See EXCLUDED_POINTS.
  400: [
    0.0, -0.12146, -0.15663, -0.19254, -0.22847, -0.23827, -0.44993,
    -0.38598, 0.05186, 0.30174, 0.30203, 0.28124, 0.22965, 0.2092, 0.19713,
    0.1836, 0.0,
  ],
  1000: [
    0.0, -0.21388, -0.27669, -0.33714, -0.39188, -0.515, -0.42665,
    -0.31966, 0.02526, 0.32235, 0.33075, 0.37095, 0.32627, 0.30353, 0.29012,
    0.27485, 0.0,
  ],
};

// Points held to be unreliable in the published data itself.
//
// The tables above are a faithful transcription: nothing is nulled out or
// quietly adjusted, because the file's job is to say what the source says. A
// point that should not be compared against is recorded here instead, with the
// reason, so the exclusion is visible and arguable rather than invisible.
//
// There is exactly one, and it has two independent lines of evidence:
//
//   1. The transcription this file is checked against carries the note,
//      verbatim: "The velocity for Re = 400 and point (x,v) = (0.9063,
//      -0.23827) is probably wrong".
//   2. Independently, and before that note was known here, this solver
//      reproduced all sixteen other points on that row to within 8e-3 and
//      disagreed with this one by 1.4e-1 - twenty times worse than any
//      neighbour. The published value also implies a sharp kink in a profile
//      that is smooth everywhere else: -0.22847 at x=0.9453, then -0.23827,
//      then -0.44993 at x=0.8594. The solver gives -0.3818 there, which sits
//      smoothly between its neighbours.
//
// Excluding it costs one of 17 comparison points at one Reynolds number. The
// alternative - substituting the solver's own answer - would make the
// comparison circular and worthless.
export const EXCLUDED_POINTS = [
  {
    table: "V_CENTRELINE",
    Re: 400,
    index: 5,
    coordinate: 0.9063,
    publishedValue: -0.23827,
    note: 'Source transcription: "The velocity for Re = 400 and point ' +
      '(x,v) = (0.9063, -0.23827) is probably wrong"',
    corroboration:
      "Solver disagrees by 1.4e-1 where every other point on the row agrees " +
      "to within 8e-3, and the value implies a kink in an otherwise smooth profile.",
  },
];

export function isExcluded(table, Re, index) {
  return EXCLUDED_POINTS.some(
    (p) => p.table === table && p.Re === Re && p.index === index
  );
}

export function exclusionFor(table, Re, index) {
  return EXCLUDED_POINTS.find(
    (p) => p.table === table && p.Re === Re && p.index === index
  );
}

// Primary vortex centre locations, Ghia et al. Table (used as an independent
// structural check that the solver produces the right flow topology, not
// just the right numbers on two lines).
export const PRIMARY_VORTEX_CENTRE = {
  100: { x: 0.6172, y: 0.7344 },
  400: { x: 0.5547, y: 0.6055 },
  1000: { x: 0.5313, y: 0.5645 },
};
