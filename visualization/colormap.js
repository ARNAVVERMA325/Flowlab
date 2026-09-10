// Sequential colour ramp for scalar magnitude fields.
//
// One hue, monotonic in lightness - not a rainbow. Rainbow ramps invent
// boundaries that are not in the data (the eye reads the yellow/green edge as a
// feature) and they are not colourblind-safe. A single-hue ramp maps magnitude
// to lightness, which every viewer reads in the same order.
//
// The stops run darkest-first because the instrument renders on a dark surface:
// near-zero speed recedes toward the background and high speed reads brightest.
// The fluid region stays visible at zero because the darkest stop is still
// distinguishable from the page surface.

const SURFACE = "#1a1a19";

const STOPS = [
  [0x0d, 0x36, 0x6b],
  [0x10, 0x42, 0x81],
  [0x18, 0x4f, 0x95],
  [0x1c, 0x5c, 0xab],
  [0x25, 0x6a, 0xbf],
  [0x2a, 0x78, 0xd6],
  [0x39, 0x87, 0xe5],
  [0x55, 0x98, 0xe7],
  [0x6d, 0xa7, 0xec],
  [0x86, 0xb6, 0xef],
  [0x9e, 0xc5, 0xf4],
  [0xb7, 0xd3, 0xf6],
  [0xcd, 0xe2, 0xfb],
];

// Deliberately outside the ramp's hue so it can never be mistaken for a
// magnitude. Any cell painted this colour is not data.
export const NON_FINITE_COLOUR = [0xff, 0x00, 0xaa];

// Solid obstacle / wall material.
// Solid cells. A mid WARM grey, and both halves of that were measured rather
// than chosen.
//
// It was [0x33, 0x33, 0x31] - a dark neutral - and that put it 10.0 RGB units
// from the diverging ramp's centre and 16.9 from the dye ramp's low end, out of
// a possible 441. In the pressure view a wall and fluid sitting at the mean
// were the same colour, so you could not tell where the geometry was; in the
// dye view a wall and clean fluid were nearly the same. Found by looking at a
// screenshot, which is the only way a thing like this gets found.
//
// Sweeping candidates against every point of all three ramps, the worst-case
// distance peaks around a mid grey with a slight warm cast. Warm because every
// ramp here is cool at its dark end, so hue separates the wall even where
// lightness is close:
//
//   [ 51, 51, 49]  velocity  69.4   pressure  10.0   dye  16.9   worst 10.0
//   [120,112,102]  velocity 111.7   pressure  73.3   dye  57.8   worst 57.8
//
// A 5.8x improvement in the worst case, and the limiting ramp is now dye rather
// than pressure. Mid lightness rather than light: a wall should read as
// structure, not as data at the top of a scale.
export const SOLID_COLOUR = [0x78, 0x70, 0x66];

export const SURFACE_COLOUR = SURFACE;

// Diverging ramp for signed fields - pressure. Lightness rises away from the
// centre on both arms so magnitude still reads correctly in greyscale, and the
// sign is carried by hue. Blue against amber rather than blue against red:
// blue/orange is the axis that survives both deuteranopia and protanopia,
// where blue/red does not.
//
// The centre stop sits close to the page surface, so the large regions of a
// pressure field that are near the mean recede and the extremes stand out -
// which is where the interesting structure is.
const DIVERGING_STOPS = [
  [0xc8, 0xde, 0xfb],
  [0xa4, 0xc6, 0xf2],
  [0x7f, 0xad, 0xe4],
  [0x5b, 0x92, 0xd2],
  [0x3d, 0x74, 0xb4],
  [0x2c, 0x53, 0x86],
  [0x2a, 0x2a, 0x28],
  [0x86, 0x54, 0x22],
  [0xb4, 0x71, 0x2a],
  [0xd2, 0x8c, 0x35],
  [0xe4, 0xa7, 0x50],
  [0xf2, 0xc4, 0x7f],
  [0xfb, 0xdd, 0xb0],
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
