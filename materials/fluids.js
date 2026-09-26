// Fluids, and what choosing one does to a scenario.
//
// The solver is incompressible, and for an incompressible fluid the equations
// hold exactly two material numbers: the density rho and the dynamic viscosity
// mu. They enter in two ways and this module is explicit about both:
//
//   nu = mu / rho   the kinematic viscosity, in the viscous term. With the
//                   speeds at the boundaries prescribed, this is the ONLY way
//                   the material reaches the velocity field - two fluids with
//                   the same nu flow identically, and the denser one simply
//                   carries proportionally more pressure. That is physics, not
//                   a shortcut, and a test pins it: water and a fluid of
//                   water's nu but ten times its density give the same
//                   velocity to rounding and ten times the pressure.
//
//   rho             in the pressure term, grad(p)/rho. Where a PRESSURE is
//                   prescribed rather than a speed - the pressure-driven
//                   channel - rho and mu act separately: the same pressure
//                   difference drives a flow rate proportional to 1/mu.
//
// PHYSICAL SCALE. The scenarios are built in their own units: a cavity of side
// 1 with a lid speed of 1. A real fluid needs a real size and speed, and each
// scenario is given one here, chosen so that WATER at 20 C moving at 1 cm/s
// reproduces the scenario exactly as shipped - the same Reynolds number, the
// same kinematic viscosity in the solver's units. The cavity is then 10 cm
// across with its lid at 1 cm/s; the cylinder is 1 cm in diameter. Every other
// fluid is then that same apparatus filled with something else.
//
// Property values are at 20 C and 1 atm, from standard tables (water: IAPWS;
// air: dry air at sea level). They are rounded to the precision the choice
// needs - a few percent - because nothing here is compared against them.

export const SPEED_UNIT = 0.01; // m/s per unit of scenario speed

export const FLUIDS = [
  { id: "water", name: "Water (20 °C)", rho: 998.2, mu: 1.002e-3 },
  { id: "air", name: "Air (20 °C, 1 atm)", rho: 1.204, mu: 1.825e-5 },
  { id: "olive-oil", name: "Olive oil (20 °C)", rho: 911, mu: 0.084 },
  { id: "glycerol", name: "Glycerol (20 °C)", rho: 1261, mu: 1.412 },
  { id: "mercury", name: "Mercury (20 °C)", rho: 13534, mu: 1.526e-3 },
];

export const WATER = FLUIDS[0];

export function fluidById(id) {
  return FLUIDS.find((fluid) => fluid.id === id) ?? null;
}

// The finest scale this solver is run at anywhere it has been checked: the
// cavity at Re 1000 runs at a cell Reynolds number |U| h / nu of 15.6 and is
// validated against Ghia et al.; the bends run at 16.7. The central-difference
// advection is not monotone above a cell Re of 2, and what keeps it usable
// beyond that is only ever an empirical margin - so a material that would put a
// scenario past 20 is REFUSED rather than run somewhere nothing has checked.
export const MAX_CELL_RE = 20;

// The physical size of one scenario length unit, in metres - from the rule
// above: water at SPEED_UNIT reproduces the scenario's own nu.
export function lengthUnitFor(scenarioNu) {
  return WATER.mu / WATER.rho / (scenarioNu * SPEED_UNIT);
}

// What filling `scenario` with `fluid` means, before anything is run: the
// solver parameters, the Reynolds number and the cell Reynolds number, and
// whether this grid can resolve it. `defaults` are the scenario's own nu, rho
// and reference speed, as built.
export function applyFluid({ nu, rho, U, L, h, speedSetByViscosity = false }, fluid) {
  if (!(Number.isFinite(fluid.rho) && fluid.rho > 0)) {
    throw new RangeError(`a density must be positive and finite, got ${fluid.rho}`);
  }
  if (!(Number.isFinite(fluid.mu) && fluid.mu > 0)) {
    throw new RangeError(`a viscosity must be positive and finite, got ${fluid.mu}`);
  }
  const lengthUnit = lengthUnitFor(nu);
  const nuPhysical = fluid.mu / fluid.rho;
  const nuSolver = nuPhysical / (lengthUnit * SPEED_UNIT);
  // With the speed prescribed it stays what it was. With a pressure
  // difference prescribed, the developed flow rate goes as dp/mu - in the
  // solver's units, dp / (rho * nu) - so the speed scales with the ratio.
  const speed = speedSetByViscosity ? U * (rho * nu) / (fluid.rho * nuSolver) : U;
  const Re = (speed * L) / nuSolver;
  const cellRe = (speed * h) / nuSolver;
  return {
    params: { nu: nuSolver, rho: fluid.rho },
    speed,
    Re,
    cellRe,
    resolvable: cellRe <= MAX_CELL_RE,
    physical: {
      lengthUnit,
      speedUnit: SPEED_UNIT,
      length: L * lengthUnit,
      speed: speed * SPEED_UNIT,
      nu: nuPhysical,
    },
  };
}
