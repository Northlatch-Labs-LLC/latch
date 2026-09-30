/**
 * Plan gate — client-side advisory view of a Latch account status.
 *
 * Division of responsibility (same INV-5 split as src/caps.ts): the GATEWAY
 * enforces access and balance server-side, keyed on the
 * `Authorization: Bearer <LATCH_API_KEY>` header (see README "Header
 * contract"). This pure function never talks to the network and never blocks a
 * call by itself — it projects a {@link PlanGateAccountStatus} (any subset of
 * the customer-api `GET /me` shape, plus the flatter status-summary shape)
 * into the decision the cost HUD / send path render.
 *
 * Semantics (mirrors `enforceSpendCap` in the gateway's routes/proxy.ts):
 * - `billingEnabled !== true` → always allowed. Billing off means the gateway
 *   does not charge or enforce balances, so there is nothing to gate on.
 * - otherwise `allowed = balanceMicros > 0` — a zero balance is refused with
 *   HTTP 402 `account_balance_exhausted` server-side; the client mirrors that
 *   judgment so the UI can route to the upgrade journey before the request.
 * - `plan` reports the account's plan: "pro" / "team" from the status, or
 *   "free" for a real pay-as-you-go account (gateway `planFor` returns null
 *   for "no plan", which is a state, not a missing field). An absent status
 *   reports "unknown" — no status, no invented facts.
 */

/** Plans the gateway sells (`PLANS` in its services/customer-plan.ts). */
export type PlanGateHeldPlan = "pro" | "team";

/** Everything `planGate` can report. */
export type PlanGatePlan = PlanGateHeldPlan | "free" | "unknown";

/**
 * The status facts the gate reads. Structural on purpose so both the
 * customer-api `LatchAccountStatus` (`plan: { plan } | null`) and the flatter
 * `LatchAccountStatusSummary` (`plan?: "pro" | "team"`) can be passed without
 * this package depending on `@zcode/services`.
 */
export interface PlanGateAccountStatus {
  /** Whether the gateway charges and enforces balances. */
  billingEnabled?: boolean | null;
  /** Prepaid balance in integer micro-USD (1e-6 USD). */
  balanceMicros?: number | null;
  /** Held plan: the /me object, a bare plan id, or null for pay-as-you-go. */
  plan?: PlanGateHeldPlan | { plan: string } | null;
}

export interface PlanGateDecision {
  /** Advisory: may a model call be attempted on this account right now? */
  allowed: boolean;
  /** The account's plan, or "unknown" when no status was provided. */
  plan: PlanGatePlan;
}

/** Default decision for callers with no status: allow, plan unknown. */
export const PLAN_GATE_UNKNOWN_DECISION: PlanGateDecision = {
  allowed: true,
  plan: "unknown",
};

function resolvePlanId(value: PlanGateAccountStatus["plan"]): PlanGateHeldPlan | null {
  const planId = typeof value === "string" ? value : value?.plan;
  return planId === "pro" || planId === "team" ? planId : null;
}

/**
 * Project an account status into the advisory gate decision.
 *
 * Pure: same status in, same decision out; no clock, network, or globals. A
 * missing status (or `billingEnabled` false/unknown) allows — the gateway
 * remains the only enforcement point.
 */
export function planGate(status: PlanGateAccountStatus | null | undefined): PlanGateDecision {
  if (!status) {
    return PLAN_GATE_UNKNOWN_DECISION;
  }
  // Plan is reported independently of the billing switch: a held plan is a
  // fact about the account even while billing is off.
  const heldPlan = resolvePlanId(status.plan);
  if (status.billingEnabled !== true) {
    return { allowed: true, plan: heldPlan ?? "free" };
  }
  const balanceMicros =
    typeof status.balanceMicros === "number" && Number.isFinite(status.balanceMicros)
      ? status.balanceMicros
      : 0;
  return { allowed: balanceMicros > 0, plan: heldPlan ?? "free" };
}
