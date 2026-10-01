// Latch billing webhook: verify-by-fetch authenticity + credit/plan settlement.
// Stripe API-created webhook endpoints return no signing secret, so the route
// verifies by fetching GET /v1/events/:id with the secret key and processing
// only the fetched event. The rejection tests below are the analog of Stripe
// signature rejection: anything that cannot be fetched-and-matched is refused.
import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVICE_TOKEN,
  STRIPE_SECRET_KEY,
  jsonResponse,
  mockFetchFor,
  newBillingApp,
  setBillingEnv,
} from "./latchBillingTestUtils.js";

function postWebhook(app: ReturnType<typeof newBillingApp>, body: string): Promise<Response> {
  return app.request("/api/latch-billing/webhook", { method: "POST", body });
}

test("webhook is 503 without a Stripe key or a gateway service token", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: undefined,
    LATCH_GATEWAY_SERVICE_TOKEN: undefined,
  });
  const app = newBillingApp();
  assert.equal((await postWebhook(app, JSON.stringify({ id: "evt_1" }))).status, 503);
  setBillingEnv(t, { LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY });
  assert.equal((await postWebhook(app, JSON.stringify({ id: "evt_1" }))).status, 503);
});

test("webhook is 400 on empty, unparseable, or id-less payloads", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
    LATCH_GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN,
  });
  const app = newBillingApp();
  assert.equal((await postWebhook(app, "")).status, 400);
  assert.equal((await postWebhook(app, "not json")).status, 400);
  assert.equal((await postWebhook(app, JSON.stringify({ type: "invoice.paid" }))).status, 400);
});

test("webhook rejects an event Stripe does not confirm (unverifiable = signature-fail analog)", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
    LATCH_GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN,
  });
  const calls = mockFetchFor(t, (call) => {
    if (call.url.includes("/v1/events/evt_missing")) {
      return jsonResponse({ error: { message: "No such event" } }, 404);
    }
    throw new Error("unexpected fetch: " + call.url);
  });
  const app = newBillingApp();
  const response = await postWebhook(app, JSON.stringify({ id: "evt_missing" }));
  assert.equal(response.status, 502);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /could not be verified/);
  assert.ok(!calls.some((call) => call.url.includes("/service-api/")), "no credit may be granted");
});

test("webhook rejects when the posted id does not match the fetched event", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
    LATCH_GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN,
  });
  mockFetchFor(t, () =>
    jsonResponse({ id: "evt_genuine", type: "invoice.paid", data: { object: {} } }),
  );
  const app = newBillingApp();
  const response = await postWebhook(app, JSON.stringify({ id: "evt_spoofed" }));
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /could not be verified/);
});

test("paid Latch payment-session event grants credit via gateway service-api", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
    LATCH_GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN,
  });
  const event = {
    id: "evt_credit_session_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_paid_1",
        mode: "payment",
        payment_status: "paid",
        amount_total: 1400,
        metadata: { latch_kind: "subscription", latch_customer_email: "buyer@northlatch.dev" },
      },
    },
  };
  const calls = mockFetchFor(t, (call) => {
    if (call.url.includes("/v1/events/evt_credit_session_1")) {
      return jsonResponse(event);
    }
    if (call.url.includes("/service-api/credits")) {
      return jsonResponse({ ok: true }, 201);
    }
    throw new Error("unexpected fetch: " + call.url);
  });
  const app = newBillingApp();
  const response = await postWebhook(app, JSON.stringify({ id: event.id }));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { outcome: string }).outcome, "applied");
  const creditCall = calls.find((call) => call.url.includes("/service-api/credits"));
  assert.ok(creditCall, "gateway credit call expected");
  assert.equal(creditCall.authorization, "Bearer " + SERVICE_TOKEN);
  const credit = JSON.parse(creditCall.body ?? "{}") as Record<string, unknown>;
  assert.equal(credit.customerEmail, "buyer@northlatch.dev");
  assert.equal(credit.amountCents, 1400);
  assert.equal(credit.currency, "usd");
  assert.equal(credit.paymentId, "cs_test_paid_1");
});

test("Latch invoice.paid credits the plan amount and records the subscription", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
    LATCH_GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN,
  });
  const event = {
    id: "evt_invoice_monthly_1",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_test_1",
        amount_paid: 1400,
        parent: {
          subscription_details: {
            subscription: "sub_test_1",
            metadata: {
              latch_kind: "subscription",
              latch_customer_email: "buyer@northlatch.dev",
              latch_plan: "latch-monthly",
            },
          },
        },
        lines: { data: [{ period: { end: 1_764_000_000 } }] },
      },
    },
  };
  const calls = mockFetchFor(t, (call) => {
    if (call.url.includes("/v1/events/evt_invoice_monthly_1")) {
      return jsonResponse(event);
    }
    if (call.url.includes("/service-api/credits") || call.url.includes("/service-api/plan")) {
      return jsonResponse({ ok: true }, 200);
    }
    throw new Error("unexpected fetch: " + call.url);
  });
  const app = newBillingApp();
  const response = await postWebhook(app, JSON.stringify({ id: event.id }));
  assert.equal(response.status, 200);
  const creditCall = calls.find((call) => call.url.includes("/service-api/credits"));
  const credit = JSON.parse(creditCall?.body ?? "{}") as Record<string, unknown>;
  assert.equal(credit.amountCents, 1400, "plan creditCents, not amount_paid, must be granted");
  assert.equal(credit.paymentId, "in_test_1");
  const planCall = calls.find((call) => call.url.includes("/service-api/plan"));
  const plan = JSON.parse(planCall?.body ?? "{}") as Record<string, unknown>;
  assert.equal(plan.plan, "latch-monthly");
  assert.equal(plan.subscriptionRef, "sub_test_1");
  assert.equal(plan.renewsAtMs, 1_764_000_000_000);
});

test("estate invoice without Latch metadata is ignored — never credited by email fallback", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
    LATCH_GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN,
  });
  const event = {
    id: "evt_estate_invoice_1",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_estate_1",
        amount_paid: 29_00,
        customer_email: "buyer@northlatch.dev",
        parent: { subscription_details: { subscription: "sub_estate", metadata: {} } },
      },
    },
  };
  const calls = mockFetchFor(t, (call) => {
    if (call.url.includes("/v1/events/evt_estate_invoice_1")) {
      return jsonResponse(event);
    }
    throw new Error("unexpected fetch: " + call.url);
  });
  const app = newBillingApp();
  const response = await postWebhook(app, JSON.stringify({ id: event.id }));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { outcome: string }).outcome, "ignored");
  assert.ok(!calls.some((call) => call.url.includes("/service-api/")), "no gateway call allowed");
});

test("subscription-mode sessions and unpaid sessions are ignored (invoice credits them)", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
    LATCH_GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN,
  });
  const latchMeta = { latch_kind: "subscription", latch_customer_email: "buyer@northlatch.dev" };
  const subscriptionMode = {
    id: "evt_sub_mode_1",
    type: "checkout.session.completed",
    data: { object: { id: "cs_sub_1", mode: "subscription", payment_status: "paid", metadata: latchMeta } },
  };
  const unpaid = {
    id: "evt_unpaid_1",
    type: "checkout.session.completed",
    data: { object: { id: "cs_unpaid_1", mode: "payment", payment_status: "unpaid", amount_total: 1400, metadata: latchMeta } },
  };
  mockFetchFor(t, (call) => {
    if (call.url.includes("evt_sub_mode_1")) return jsonResponse(subscriptionMode);
    if (call.url.includes("evt_unpaid_1")) return jsonResponse(unpaid);
    throw new Error("unexpected fetch: " + call.url);
  });
  const app = newBillingApp();
  const r1 = await postWebhook(app, JSON.stringify({ id: subscriptionMode.id }));
  assert.equal(((await r1.json()) as { outcome: string }).outcome, "ignored");
  const r2 = await postWebhook(app, JSON.stringify({ id: unpaid.id }));
  assert.equal(((await r2.json()) as { outcome: string }).outcome, "ignored");
});

test("a replayed event is confirmed but never credited twice", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
    LATCH_GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN,
  });
  const event = {
    id: "evt_replay_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_replay_1",
        mode: "payment",
        payment_status: "paid",
        amount_total: 9900,
        metadata: { latch_kind: "subscription", latch_customer_email: "buyer@northlatch.dev" },
      },
    },
  };
  const calls = mockFetchFor(t, (call) => {
    if (call.url.includes("/v1/events/evt_replay_1")) return jsonResponse(event);
    if (call.url.includes("/service-api/credits")) return jsonResponse({ ok: true }, 200);
    throw new Error("unexpected fetch: " + call.url);
  });
  const app = newBillingApp();
  const first = await postWebhook(app, JSON.stringify({ id: event.id }));
  assert.equal(((await first.json()) as { outcome: string }).outcome, "applied");
  const second = await postWebhook(app, JSON.stringify({ id: event.id }));
  assert.equal(((await second.json()) as { outcome: string }).outcome, "already-processed");
  assert.equal(
    calls.filter((call) => call.url.includes("/service-api/credits")).length,
    1,
    "exactly one credit call across both deliveries",
  );
});

test("gateway 404 settles as no-such-customer; gateway 500 stays retryable", async (t) => {
  setBillingEnv(t, {
    LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY,
    LATCH_GATEWAY_SERVICE_TOKEN: SERVICE_TOKEN,
  });
  const creditEvent = (id: string, sessionId: string) => ({
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        mode: "payment",
        payment_status: "paid",
        amount_total: 1400,
        metadata: { latch_kind: "subscription", latch_customer_email: "buyer@northlatch.dev" },
      },
    },
  });
  const notFound = creditEvent("evt_404_1", "cs_404_1");
  const unavailable = creditEvent("evt_500_1", "cs_500_1");
  mockFetchFor(t, (call) => {
    if (call.url.includes("evt_404_1")) return jsonResponse(notFound);
    if (call.url.includes("evt_500_1")) return jsonResponse(unavailable);
    if (call.url.includes("/service-api/credits")) {
      // The paymentId (session id) rides in the body, not the URL.
      return call.body?.includes("cs_404_1")
        ? jsonResponse({ error: { message: "customer not found" } }, 404)
        : jsonResponse({ error: { message: "boom" } }, 500);
    }
    throw new Error("unexpected fetch: " + call.url);
  });
  const app = newBillingApp();
  const settled = await postWebhook(app, JSON.stringify({ id: notFound.id }));
  assert.equal(((await settled.json()) as { outcome: string }).outcome, "no-such-customer");
  const retryable = await postWebhook(app, JSON.stringify({ id: unavailable.id }));
  assert.equal(retryable.status, 502);
});
