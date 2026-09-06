// The kinds of source, and why there are exactly two of them.
//
// Everything in M6 - a brush, a point source, a jet - adds something to the
// INTERIOR of the domain rather than at a boundary. That splits cleanly in two,
// and the split is not a taxonomy for its own sake: the two kinds enter
// different equations and fail in different ways.
//
// ---------------------------------------------------------------------------
// MOMENTUM SOURCES - a body force. They add no mass.
// ---------------------------------------------------------------------------
//
// These are the `f` in the momentum equation, which the solver has always
// accepted as a uniform scalar (`fx`/`fy`). A momentum source is that term made
// spatially varying. Whatever divergence it creates, the projection removes,
// exactly as it removes advection's. They are safe by construction: there is no
// configuration of momentum sources that makes the pressure equation
// unsolvable.
//
// They are specified as a TARGET VELOCITY and a RELAXATION TIME, not as a raw
// force, and that is the important decision here.
//
// A raw force has no bound. computeStableTimestep sizes dt from the field
// BEFORE the step, so a force applied during the step can leave the field
// moving faster than that dt was chosen for - the same mechanism as the known
// first-step-from-rest limitation, except that a brush would repeat it on every
// stroke rather than once per run.
//
// Writing it as a relaxation fixes that:
//
//     f = alpha * (u_target - u) / dt,     alpha = min(1, dt / tau)
//
// so the velocity change in one step is
//
//     du = dt * f = alpha * (u_target - u),      alpha in (0, 1]
//
// which lands strictly between the current velocity and the target. The
// post-step speed is therefore bounded by max(|u|, |u_target|) - a quantity
// known before the step, which is what lets the timestep be sized against it.
// The bound holds for ANY tau and ANY dt, including a tau far smaller than the
// timestep: alpha clamps at 1 and the source snaps to its target rather than
// overshooting past it.
//
// When dt <= tau the clamp is inactive and the expression is just the physical
// f = (u_target - u) / tau. tau is a real time and does not change with the
// timestep, so the same source behaves the same way at any resolution. A
// dimensionless "strength" per step would not: it would make the physics a
// function of whatever dt the driver happened to choose.
//
// ---------------------------------------------------------------------------
// MASS SOURCES - fluid appears. They change the mass balance.
// ---------------------------------------------------------------------------
//
// These make the flow genuinely non-solenoidal by design: div u = q. The
// pressure equation becomes
//
//     laplacian(p) = (rho/dt) * (div u* - q)
//
// and with it comes a solvability condition that has real teeth. On a region
// with pure-Neumann boundaries, the integral of q must equal the net flux
// through that region's boundary. A source in a sealed chamber is not merely
// inaccurate - NO pressure field satisfies it.
//
// That is the same condition M5's assertRegionsAreSolvable already measures,
// via the per-region RHS sum, so the intent is to reuse it rather than invent a
// second mechanism. Whether that actually holds is demonstrated before it is
// designed around - see the M6 notes; mass sources are rejected by the solver
// until that demonstration has been done.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT HERE
// ---------------------------------------------------------------------------
//
// `dye`. A source may carry one, and the compiler below ignores it completely:
// it is read only by the tracer. scenarios/ is sealed against tracer/ and
// tests/test9 asserts that deleting tracer/ leaves the solver and everything
// describing the simulation untouched. A source's dye must not be able to
// change a single cell of the flow, and the way to guarantee that is for the
// code the solver reads to never look at the field at all.

import { validateRegion } from "../geometry/document.js";

export class SourceSpecError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SourceSpecError";
    Object.assign(this, details);
  }
}

function fail(message, details) {
  throw new SourceSpecError(message, details);
}

function requireFinite(source, fields, where) {
  for (const field of fields) {
    if (!Number.isFinite(source[field])) {
      fail(
        `${where}: "${field}" must be a finite number, got ${source[field]}. ` +
        `Every quantity a source prescribes is stated explicitly - there are no ` +
        `defaults here, because a default silently decides physics.`
      );
    }
  }
}

export const SOURCE_KINDS = {
  momentum: {
    label: "Momentum source",
    // Sampled at velocity faces: u at cell boundaries in x, v at cell
    // boundaries in y. Not at cell centres - see compile.js.
    samples: "faces",
    validate(source, where) {
      // Both components are required even when one of them is zero. A source
      // that named only `u` would have to decide silently whether it leaves v
      // alone or drives it to zero, and both readings are defensible, which is
      // exactly the situation that has to be written down rather than assumed.
      requireFinite(source, ["u", "v", "relaxationTime"], where);
      if (!(source.relaxationTime > 0)) {
        fail(
          `${where}: relaxationTime must be positive, got ${source.relaxationTime}. ` +
          `It is the time the source takes to pull the fluid to its target; a ` +
          `value at or below the timestep simply means "this step".`
        );
      }
    },
    describe: (s) =>
      `drives to (${s.u}, ${s.v}) over ${s.relaxationTime}s`,
    // The fastest this source can leave the fluid moving, which is what the
    // timestep has to be sized against.
    targetSpeed: (s) => Math.hypot(s.u, s.v),
  },

  mass: {
    label: "Mass source",
    // Sampled at cell centres: q lives where the divergence does.
    samples: "cells",
    validate(source, where) {
      requireFinite(source, ["rate"], where);
      if (source.rate === 0) {
        fail(
          `${where}: a mass source with rate 0 does nothing. Remove it rather ` +
          `than leaving something in the specification that reads as active.`
        );
      }
    },
    describe: (s) =>
      `${s.rate > 0 ? "injects" : "removes"} ${Math.abs(s.rate)} per unit time`,
    // A mass source adds no momentum directly, so it imposes no target speed.
    // The velocity it induces is whatever the projection produces, which the
    // ordinary CFL check sees on the following step like any other flow.
    targetSpeed: () => 0,
  },
};

export function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(SOURCE_KINDS, kind);
}

export function validateSource(source, where = "source") {
  if (!source || typeof source !== "object") {
    fail(`${where}: expected a source object, got ${source}`);
  }
  if (!isKnownKind(source.kind)) {
    fail(
      `${where}: unknown source kind "${source.kind}". ` +
      `Known kinds: ${Object.keys(SOURCE_KINDS).join(", ")}`
    );
  }
  if (source.where === undefined) {
    fail(
      `${where}: a source needs a "where" region saying which part of the ` +
      `domain it acts on. Regions are the same primitives geometry is drawn ` +
      `with - see geometry/document.js - so there is one selector language, ` +
      `not two.`
    );
  }
  validateRegion(source.where, `${where}.where`);
  SOURCE_KINDS[source.kind].validate(source, where);
  return source;
}

export function describeSource(source) {
  const kind = SOURCE_KINDS[source.kind];
  const body = kind.describe(source);
  return source.label ? `${source.label} - ${body}` : `${kind.label}: ${body}`;
}
