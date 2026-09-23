// Colour ramps for the field views.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED, AND THE TRADE IT MAKES
// ---------------------------------------------------------------------------
//
// Until the UI refresh every magnitude was drawn with ONE HUE, monotone in
// lightness, on the principle that a rainbow invents boundaries that are not in
// the data. That principle is sound and it produced a picture nobody wanted to
// look at: flat blue with amber for signed fields. The request that replaced it
// was explicit - the colours of the reference images, which are the colours of
// conventional CFD output.
//
// So the DEFAULT magnitude ramp is now Turbo (Mikhailov, Google 2019), which is
// what that convention should have been all along: the familiar
// blue-cyan-green-yellow-red, with jet's banding removed so the hue changes at
// an even perceptual rate instead of jumping at cyan and yellow. It is still a
// rainbow, and the cost is measured rather than waved at - its OKLab lightness
// runs 0.251 -> 0.903 -> 0.367, UP and then DOWN, so in greyscale or print the
// top of the scale reads like the lower middle.
//
// That is why the choice is not taken away: VIRIDIS (van der Walt & Smith,
// 2015) is one control away, monotone from 0.285 to 0.918, and is the right map
// whenever order has to survive a photocopier or a colour-vision deficiency.
//
// Signed fields use COOLWARM (Moreland 2009): blue to a neutral light grey to
// red. Designed for scientific diverging data, balanced in lightness at the
// two ends (0.476 and 0.487), and a GREY rather than a hue at the midpoint -
// which is what the reference's vorticity and divergence panels show, and what
// a diverging map should do.
//
// Every table below is generated from matplotlib's reference implementation at
// 33 stops and embedded, not transcribed from memory. Linear interpolation
// between them stays within 5.3/255 of the full 1024-entry map for all three -
// below anything a display resolves.

const SURFACE = "#0e1522";

// Turbo, 33 stops.
const STOPS = [
  [0x30, 0x12, 0x3b],
  [0x39, 0x2a, 0x73],
  [0x40, 0x40, 0xa2],
  [0x44, 0x56, 0xc7],
  [0x46, 0x6b, 0xe3],
  [0x46, 0x80, 0xf6],
  [0x42, 0x94, 0xff],
  [0x37, 0xa8, 0xfa],
  [0x28, 0xbc, 0xeb],
  [0x1c, 0xcd, 0xd8],
  [0x18, 0xdd, 0xc2],
  [0x1f, 0xe9, 0xaf],
  [0x32, 0xf2, 0x98],
  [0x4e, 0xf9, 0x7d],
  [0x6d, 0xfe, 0x62],
  [0x8b, 0xff, 0x4b],
  [0xa4, 0xfc, 0x3c],
  [0xb9, 0xf6, 0x35],
  [0xcd, 0xec, 0x34],
  [0xdf, 0xdf, 0x37],
  [0xee, 0xcf, 0x3a],
  [0xf8, 0xbe, 0x39],
  [0xfd, 0xac, 0x34],
  [0xfe, 0x96, 0x2b],
  [0xfb, 0x7e, 0x21],
  [0xf4, 0x66, 0x17],
  [0xeb, 0x50, 0x0e],
  [0xdf, 0x3f, 0x08],
  [0xd0, 0x2f, 0x05],
  [0xbe, 0x21, 0x02],
  [0xa9, 0x16, 0x01],
  [0x92, 0x0b, 0x01],
  [0x7a, 0x04, 0x03]
];

// Viridis, 33 stops. Perceptually uniform and monotone in lightness.
const VIRIDIS_STOPS = [
  [0x44, 0x01, 0x54],
  [0x47, 0x0d, 0x60],
  [0x48, 0x18, 0x6a],
  [0x48, 0x23, 0x74],
  [0x47, 0x2d, 0x7b],
  [0x45, 0x37, 0x81],
  [0x42, 0x40, 0x86],
  [0x3e, 0x49, 0x89],
  [0x3b, 0x52, 0x8b],
  [0x37, 0x5b, 0x8d],
  [0x33, 0x63, 0x8d],
  [0x2f, 0x6b, 0x8e],
  [0x2c, 0x72, 0x8e],
  [0x29, 0x7a, 0x8e],
  [0x26, 0x82, 0x8e],
  [0x23, 0x89, 0x8e],
  [0x21, 0x91, 0x8c],
  [0x1f, 0x98, 0x8b],
  [0x1f, 0xa0, 0x88],
  [0x22, 0xa7, 0x85],
  [0x28, 0xae, 0x80],
  [0x32, 0xb6, 0x7a],
  [0x3f, 0xbc, 0x73],
  [0x4e, 0xc3, 0x6b],
  [0x5e, 0xc9, 0x62],
  [0x70, 0xcf, 0x57],
  [0x84, 0xd4, 0x4b],
  [0x98, 0xd8, 0x3e],
  [0xad, 0xdc, 0x30],
  [0xc2, 0xdf, 0x23],
  [0xd8, 0xe2, 0x19],
  [0xec, 0xe5, 0x1b],
  [0xfd, 0xe7, 0x25]
];

// Deliberately outside the ramp's hue so it can never be mistaken for a
// magnitude. Any cell painted this colour is not data.
export const NON_FINITE_COLOUR = [0xff, 0x00, 0xaa];

// Solid obstacle / wall material.
//
// Near-black, with the surface drawn as a light OUTLINE around it - the
// reference's treatment, where a body is the dark ground the fluid is painted
// on rather than a grey object in the field.
//
// Measured, not chosen, for the second time. The previous mid warm grey
// [120,112,102] was picked by sweeping candidates against the old ramps; the
// sweep was re-run against the new ones and the constraint that binds is still
// the dye ramp's dark end, which is a green-black. Nearest approach of each
// ramp to this colour:
//
//   turbo 69.4   viridis 99.9   coolwarm 180.3   dye 49.7
//
// against a test threshold of 40. The outline then separates solid from fluid
// at every surface regardless of how close the adjacent fluid's colour is,
// which a fill colour alone cannot promise for every ramp at once.
export const SOLID_COLOUR = [0x02, 0x04, 0x09];

export const SURFACE_COLOUR = SURFACE;

// Diverging ramp for every signed field - pressure, vorticity, shear, root Q,
// continuity. Coolwarm, 33 stops: blue, a neutral light grey at zero, red.
//
// It replaces a blue/amber ramp with a DARK centre, chosen so that near-zero
// regions receded into the dark page. The reference draws the opposite - a
// light neutral midpoint - and the light midpoint is also what a diverging map
// is supposed to do: the eye reads "no deviation" as the absence of colour,
// and the two arms carry the sign by hue.
const DIVERGING_STOPS = [
  [0x3b, 0x4c, 0xc0],
  [0x44, 0x5a, 0xcc],
  [0x4e, 0x68, 0xd8],
  [0x58, 0x75, 0xe1],
  [0x62, 0x82, 0xea],
  [0x6c, 0x8f, 0xf1],
  [0x77, 0x9a, 0xf7],
  [0x82, 0xa6, 0xfb],
  [0x8d, 0xb0, 0xfe],
  [0x98, 0xb9, 0xff],
  [0xa3, 0xc2, 0xfe],
  [0xae, 0xc9, 0xfc],
  [0xb9, 0xd0, 0xf9],
  [0xc3, 0xd5, 0xf4],
  [0xcc, 0xd9, 0xed],
  [0xd5, 0xdb, 0xe5],
  [0xdd, 0xdc, 0xdc],
  [0xe5, 0xd8, 0xd1],
  [0xec, 0xd3, 0xc5],
  [0xf1, 0xcc, 0xb8],
  [0xf5, 0xc4, 0xac],
  [0xf7, 0xba, 0x9f],
  [0xf7, 0xb0, 0x93],
  [0xf6, 0xa5, 0x86],
  [0xf4, 0x98, 0x7a],
  [0xf0, 0x8b, 0x6e],
  [0xeb, 0x7d, 0x62],
  [0xe4, 0x6e, 0x56],
  [0xdd, 0x5f, 0x4b],
  [0xd4, 0x4e, 0x41],
  [0xca, 0x3b, 0x37],
  [0xbe, 0x24, 0x2e],
  [0xb4, 0x04, 0x26]
];

// Dye ramp. Deliberately a different hue from both state fields, because dye
// is not a solver state field and must not be mistaken for one - VISION 4.2.
// The darkest stop is a green-tinted near-black rather than the surface colour
// exactly, so an undyed fluid region is still distinguishable from the page.
const DYE_STOPS = [
  [0x1e, 0x26, 0x20],
  [0x22, 0x33, 0x28],
  [0x27, 0x42, 0x30],
  [0x2c, 0x52, 0x38],
  [0x32, 0x63, 0x41],
  [0x39, 0x75, 0x4a],
  [0x42, 0x88, 0x55],
  [0x50, 0x9b, 0x62],
  [0x63, 0xae, 0x73],
  [0x7c, 0xc0, 0x88],
  [0x9a, 0xd2, 0xa1],
  [0xbb, 0xe3, 0xbe],
  [0xdc, 0xf3, 0xdd],
];

// Maps a normalised position in [0,1] to an [r,g,b] triple.
// A non-finite input returns NON_FINITE_COLOUR rather than clamping to an end
// of the ramp: clamping is exactly how a broken field acquires a healthy
// looking colour. Every ramp in this file goes through here, so that guarantee
// holds for pressure and dye as well as velocity.
function sample(stops, t) {
  if (!Number.isFinite(t)) return NON_FINITE_COLOUR;
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function sampleRamp(t) {
  return sample(STOPS, t);
}

export function sampleViridis(t) {
  return sample(VIRIDIS_STOPS, t);
}

// The magnitude ramps a viewer can choose between. Turbo is the default
// because it was asked for; the note on each says what it costs, so the
// legend can repeat it rather than the choice looking arbitrary.
export const MAGNITUDE_RAMPS = {
  turbo: {
    label: "turbo",
    sample: sampleRamp,
    note:
      "Turbo: the conventional CFD rainbow with jet's banding removed. Its " +
      "lightness rises and then falls, so it does not survive greyscale or " +
      "every colour-vision deficiency - switch to viridis when order matters " +
      "more than familiarity.",
  },
  viridis: {
    label: "viridis",
    sample: sampleViridis,
    note:
      "Viridis: perceptually uniform and monotone in lightness, so order " +
      "survives greyscale, print and colour-vision deficiency.",
  },
};
export const DEFAULT_MAGNITUDE_RAMP = "turbo";

// A 256-entry lookup table for a ramp, for the renderer's inner loop.
//
// sample() is exact and allocates an array per call, which is fine for a
// legend and a real cost at several hundred thousand pixels a frame. The table
// is built FROM sample(), so the two cannot disagree by more than the
// quantisation of 256 steps - below what a display shows. Non-finite input is
// not representable in a table and is handled by the caller, which must check
// before indexing: that is the guarantee sample() gives, and the renderer
// keeps it.
const LUTS = new Map();
export const LUT_SIZE = 256;

export function lutFor(sampler) {
  let lut = LUTS.get(sampler);
  if (lut === undefined) {
    lut = new Uint8ClampedArray(LUT_SIZE * 3);
    for (let n = 0; n < LUT_SIZE; n++) {
      const [r, g, b] = sampler(n / (LUT_SIZE - 1));
      lut[n * 3] = r;
      lut[n * 3 + 1] = g;
      lut[n * 3 + 2] = b;
    }
    LUTS.set(sampler, lut);
  }
  return lut;
}

export function sampleDiverging(t) {
  return sample(DIVERGING_STOPS, t);
}

export function sampleDye(t) {
  return sample(DYE_STOPS, t);
}

export function rampCss(t) {
  const [r, g, b] = sampleRamp(t);
  return `rgb(${r},${g},${b})`;
}

// CSS for an arbitrary sampler, so the legend can be painted from whichever
// ramp the current view is actually using rather than a hardcoded gradient
// that could drift away from the picture.
export function samplerCss(sampler, t) {
  const [r, g, b] = sampler(t);
  return `rgb(${r},${g},${b})`;
}

export function rampStopCount() {
  return STOPS.length;
}
