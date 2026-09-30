import assert from "node:assert/strict";
import test from "node:test";
import { planGate, PLAN_GATE_UNKNOWN_DECISION, type PlanGateAccountStatus } from "../src/index.js";

/** The customer-api `GET /me` shape (services latchAccountTypes.LatchAccountStatus). */
function meStatus(overrides: Partial<PlanGateAccountStatus> = {}): PlanGateAccountStatus {
  return {
    billingEnabled: true,
    balanceMicros: 12_340_000, // $12.34 in micro-USD
    plan: null,
    ...overrides,
  };
}

test("no status allows with plan unknown — the gateway stays the only enforcement point", () => {
  assert.deepEqual(planGate(undefined), PLAN_GATE_UNKNOWN_DECISION);
  assert.deepEqual(planGate(null), PLAN_GATE_UNKNOWN_DECISION);
  // An empty status object is a real status: nothing held, nothing billable.
  assert.deepEqual(planGate({}), { allowed: true, plan: "free" });
});

test("billingEnabled false always allows, whatever the balance", () => {
  assert.deepEqual(planGate(meStatus({ billingEnabled: false, balanceMicros: 0 })), {
    allowed: true,
    plan: "free",
  });
  assert.deepEqual(planGate(meStatus({ billingEnabled: false, balanceMicros: -5 })), {
    allowed: true,
    plan: "free",
  });
  // Unknown billing switch (neither true nor false) is treated as not billing.
  assert.deepEqual(planGate(meStatus({ billingEnabled: undefined, balanceMicros: 0 })), {
    allowed: true,
    plan: "free",
  });
});

test("billing on: allowed iff balanceMicros > 0 (mirrors the 402 account_balance_exhausted contract)", () => {
  assert.equal(planGate(meStatus({ balanceMicros: 1 })).allowed, true);
  assert.equal(planGate(meStatus({ balanceMicros: 0 })).allowed, false);
  assert.equal(planGate(meStatus({ balanceMicros: -1 })).allowed, false);
  // A non-numeric balance cannot prove credit; treat it as nothing left.
  assert.equal(planGate(meStatus({ balanceMicros: Number.NaN })).allowed, false);
  assert.equal(planGate(meStatus({ balanceMicros: null })).allowed, false);
});

test("plan is read from the /me object, a bare id, or reported as free when none is held", () => {
  assert.equal(planGate(meStatus({ plan: { plan: "pro" } })).plan, "pro");
  assert.equal(planGate(meStatus({ plan: { plan: "team" } })).plan, "team");
  assert.equal(planGate(meStatus({ plan: "pro" })).plan, "pro");
  assert.equal(planGate(meStatus({ plan: null })).plan, "free");
  assert.equal(planGate(meStatus({ plan: undefined })).plan, "free");
  // A plan id this client does not know is not invented into the decision.
  assert.equal(planGate(meStatus({ plan: { plan: "enterprise" } })).plan, "free");
});

test("a held plan does not bypass the balance gate while billing is on", () => {
  const proAndBroke = planGate(meStatus({ plan: { plan: "pro" }, balanceMicros: 0 }));
  assert.deepEqual(proAndBroke, { allowed: false, plan: "pro" });
  const proAndFunded = planGate(meStatus({ plan: { plan: "pro" }, balanceMicros: 1 }));
  assert.deepEqual(proAndFunded, { allowed: true, plan: "pro" });
});

test("planGate is pure: the same status decides identically and is not mutated", () => {
  const status = meStatus({ plan: { plan: "pro" }, balanceMicros: 0 });
  const first = planGate(status);
  const second = planGate(status);
  assert.deepEqual(first, second);
  assert.deepEqual(status, meStatus({ plan: { plan: "pro" }, balanceMicros: 0 }));
});
