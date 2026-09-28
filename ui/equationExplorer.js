// What the equation explorer says about each term.
//
// The words are fixed; the numbers are not. Every statement about where a term
// matters in the flow on screen is built by describeTerm() from termShares()
// - the measured budget of the last step - so the panel cannot claim that
// viscosity dominates a flow in which it measurably does not. Pure, so node
// tests the sentences against measured budgets.

import { DOMINANCE_MARGIN, QUIET, TERMS } from "../physics/momentumBudget.js";

export const TERM_INFO = {
  unsteady: {
    symbol: "∂u/∂t",
    name: "unsteady term",
    explain:
      "How fast the velocity at a fixed point is changing. It is zero everywhere " +
      "in a steady flow, so where it is large the flow is still developing, or it " +
      "sheds and never settles. This one is MEASURED: it is the change the last " +
      "step actually made, divided by its timestep, not computed from the others.",
  },
  advection: {
    symbol: "(u·∇)u",
    name: "advection",
    explain:
      "Momentum carried along by the flow itself. It is why fluid overshoots a " +
      "bend instead of turning with it, and it is the term that makes the equations " +
      "nonlinear. It wins where inertia beats friction: at high Reynolds number, in " +
      "wakes and in jets. The solver computes it in conservative form, ∇·(uu), " +
      "which is the same thing wherever ∇·u = 0, and the projection holds that " +
      "to its stated bound.",
  },
  pressure: {
    symbol: "−∇p",
    name: "pressure gradient",
    explain:
      "Pushes fluid from high pressure to low. In an incompressible flow the " +
      "pressure is whatever it must be to keep ∇·u = 0, and the projection " +
      "step computes it for exactly that. So it is large wherever the flow is being " +
      "made to turn, stop or squeeze: stagnation points, corners, and any flow " +
      "driven by a pressure difference.",
  },
  viscous: {
    symbol: "μ∇²u",
    name: "viscous diffusion",
    explain:
      "Internal friction. It smooths out differences in velocity between " +
      "neighbouring fluid, so it is largest where velocity changes sharply over a " +
      "short distance: against walls and across shear layers. It dominates at low " +
      "Reynolds number, and in a fully developed channel it exactly balances the " +
      "pressure gradient.",
  },
  source: {
    symbol: "f",
    name: "external force",
    explain:
      "Anything pushing the fluid from outside the equation: the momentum brush, a " +
      "placed momentum source, or a body force. None of the built-in scenarios has " +
      "one, so this is zero until you add one.",
  },
};

const percent = (n, of) => `${((100 * n) / of).toFixed(1)}%`;

// One paragraph on where this term matters in the flow on screen.
export function describeTerm(term, shares) {
  if (!TERMS.includes(term)) throw new RangeError(`no such term: ${term}`);
  const { wins, balances, fluid, quiet } = shares;
  const active = fluid - quiet;
  if (active === 0) {
    return "Nothing is moving: every term is zero to rounding, so none of them dominates anywhere.";
  }
  const name = TERM_INFO[term].name;
  const won = wins[term];
  const pairs = Object.entries(balances)
    .filter(([pair]) => pair.split("+").includes(term))
    .sort((a, b) => b[1] - a[1]);
  const inBalance = pairs.reduce((sum, [, n]) => sum + n, 0);

  const parts = [];
  parts.push(
    won > 0
      ? `${capital(name)} dominates in ${percent(won, active)} of the moving fluid, which is where it is outlined.`
      : `${capital(name)} dominates nowhere in this flow right now.`
  );
  if (inBalance > 0) {
    const [pair, n] = pairs[0];
    const partner = pair.split("+").find((t) => t !== term);
    parts.push(
      `In another ${percent(inBalance, active)} it is in balance with a second term, most often ` +
      `${TERM_INFO[partner].name} (${percent(n, active)}).`
    );
  }
  // Which term does win most, so a reader looking at a quiet term is told
  // where the action is instead.
  const leader = TERMS.reduce((a, b) => (wins[b] > wins[a] ? b : a));
  if (leader !== term && wins[leader] > 0) {
    parts.push(`The term that dominates most of this flow is ${TERM_INFO[leader].name} (${percent(wins[leader], active)}).`);
  }
  if (quiet > 0) parts.push(`${percent(quiet, fluid)} of the fluid is effectively still and is left out.`);
  return parts.join(" ");
}

// What "dominates" and "balanced" mean, said once under the picture.
export const DOMINANCE_RULE =
  `A term dominates a cell when it is more than ${Math.round(DOMINANCE_MARGIN * 100)}% larger than the ` +
  `next largest. Anything closer is reported as a balance between the two, because otherwise ` +
  `the steady channel, where pressure and friction are exactly equal, would be called ` +
  `"pressure-dominated" on the strength of the last bit. Cells whose five terms together are ` +
  `below ${QUIET} of the busiest cell are left out as still.`;

// The proof line: the terms shown are the ones that moved the fluid.
export function describeClosure(budget) {
  return (
    `Budget check: on every face the solver updated, the measured ∂u/∂t equals the sum ` +
    `of the other four to ${budget.relativeClosure.toExponential(1)} of the largest term. ` +
    `These are the solver's own stencils, applied to the step it just took.`
  );
}

function capital(text) {
  return text[0].toUpperCase() + text.slice(1);
}

// Edges between cells where `index` dominates and cells where it does not, as
// grid-unit segments {x0, y0, x1, y1} measured from the bottom-left of the
// interior. Solid cells count as "not dominated", so the outline closes
// against walls instead of running along them unseen.
export function dominanceEdges(grid, dominant, index) {
  const { nx, ny } = grid;
  const stride = nx + 2;
  const inside = (i, j) => i >= 1 && i <= nx && j >= 1 && j <= ny && dominant[i + stride * j] === index;
  const segments = [];
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      if (!inside(i, j)) continue;
      const x = i - 1;
      const y = j - 1;
      if (!inside(i - 1, j)) segments.push({ x0: x, y0: y, x1: x, y1: y + 1 });
      if (!inside(i + 1, j)) segments.push({ x0: x + 1, y0: y, x1: x + 1, y1: y + 1 });
      if (!inside(i, j - 1)) segments.push({ x0: x, y0: y, x1: x + 1, y1: y });
      if (!inside(i, j + 1)) segments.push({ x0: x, y0: y + 1, x1: x + 1, y1: y + 1 });
    }
  }
  return segments;
}
