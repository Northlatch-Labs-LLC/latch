/**
 * Plan gate — STUB.
 *
 * The gateway is expected to enforce per-plan model access server-side,
 * keyed on the `Authorization: Bearer <LATCH_API_KEY>` header (see README
 * "Header contract"). The gateway does not yet define the response headers
 * that would carry plan entitlements, so this stub deliberately reports
 * `{ allowed: true, plan: "unknown" }` for every model and invents no
 * header names. When the gateway contract lands, `planGate` will map it.
 */

export interface PlanGateDecision {
  allowed: boolean;
  plan: string;
}

/** Stub decision: every model is allowed, plan is unknown. */
export function planGate(model: string): PlanGateDecision {
  void model;
  return { allowed: true, plan: "unknown" };
}
