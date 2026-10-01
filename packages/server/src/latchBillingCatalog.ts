// Latch billing plan catalog: the price/config constants shared by the billing
// routes (latchBilling.ts) and the webhook event handling
// (latchBillingWebhook.ts). Leaf module: imports nothing.
//
// Plan catalog and credited amounts. creditCents (the gateway credit included
// with each subscription period) is a founder-adjustable policy constant,
// defined in this one place: both the catalog copy (config route) and the
// webhook credit settlement read it here.
// priceIds verified against the Stripe API (test mode, GET /v1/prices?active=true).
export interface LatchPlan {
  readonly id: "latch-monthly" | "latch-yearly";
  readonly name: string;
  readonly priceId: string;
  readonly amountCents: number;
  readonly creditCents: number;
  readonly interval: "month" | "year";
}

export const LATCH_PLANS: readonly LatchPlan[] = [
  {
    id: "latch-monthly",
    name: "Latch Monthly",
    priceId: "price_1ULT95AGlri04kDx2j1qRXFa",
    amountCents: 1400,
    creditCents: 1400,
    interval: "month",
  },
  {
    id: "latch-yearly",
    name: "Latch Yearly",
    priceId: "price_1ULTAhAGlri04kDxoGS9cFlW",
    amountCents: 9900,
    creditCents: 9900,
    interval: "year",
  },
];

// Map keys deliberately widened to string: plan ids arriving in webhook
// metadata / request bodies are arbitrary strings, and get() must accept them
// and then check for absence (a Map keyed on the literal union would not
// compile against .get(string)).
export const LATCH_PLANS_BY_ID = new Map<string, LatchPlan>(
  LATCH_PLANS.map((plan) => [plan.id, plan] as const),
);

// Metadata keys written onto the session and subscription at checkout: after
// the webhook re-fetches the event, these locate the account to credit
// (mirrors the estate's META usage, keys renamed to the Latch namespace).
export const LATCH_META = {
  kind: "latch_kind",
  email: "latch_customer_email",
  plan: "latch_plan",
} as const;
