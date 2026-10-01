// Latch billing: plan catalog (config) and checkout routes, Stripe mocked at fetch.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOMER_EMAIL,
  STRIPE_SECRET_KEY,
  bearerHeaders,
  jsonResponse,
  mockFetchFor,
  newBillingApp,
  setBillingEnv,
} from "./latchBillingTestUtils.js";

test("config serves the plan catalog with no secrets", async () => {
  const app = newBillingApp();
  const response = await app.request("/api/latch-billing/config");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    plans: { id: string; amountCents: number; creditCents: number; creditLabel: string }[];
  };
  assert.deepEqual(
    body.plans.map((plan) => [plan.id, plan.amountCents, plan.creditCents]),
    [
      ["latch-monthly", 1400, 1400],
      ["latch-yearly", 9900, 9900],
    ],
  );
  assert.match(body.plans[0]!.creditLabel, /includes \$14 of gateway credit/);
  assert.ok(!JSON.stringify(body).includes("sk_"));
});

test("checkout is 503 when the Stripe secret key is missing or malformed", async (t) => {
  setBillingEnv(t, { LATCH_STRIPE_SECRET_KEY: undefined });
  const app = newBillingApp();
  const post = () =>
    app.request("/api/latch-billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearerHeaders() },
      body: JSON.stringify({ planId: "latch-monthly" }),
    });
  assert.equal((await post()).status, 503);
  setBillingEnv(t, { LATCH_STRIPE_SECRET_KEY: "not_a_sk_key" });
  assert.equal((await post()).status, 503);
});

test("checkout is 401 without a session token, 400 on bad body or unknown plan", async (t) => {
  setBillingEnv(t, { LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY });
  const app = newBillingApp();
  const post = (headers: Record<string, string>, body: string) =>
    app.request("/api/latch-billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  assert.equal((await post({}, JSON.stringify({ planId: "latch-monthly" }))).status, 401);
  assert.equal((await post(bearerHeaders(), "not json")).status, 400);
  assert.equal((await post(bearerHeaders(), JSON.stringify({ planId: "nope" }))).status, 400);
});

test("checkout is 401 when the session token does not resolve an account", async (t) => {
  setBillingEnv(t, { LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY });
  const calls = mockFetchFor(t, (call) => {
    if (call.url.includes("/customer-api/me")) {
      return jsonResponse({ error: { message: "invalid session" } }, 401);
    }
    throw new Error("unexpected fetch: " + call.url);
  });
  const app = newBillingApp();
  const response = await app.request("/api/latch-billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearerHeaders("dead_token") },
    body: JSON.stringify({ planId: "latch-monthly" }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 1);
});

test("checkout creates a Stripe subscription session carrying Latch metadata", async (t) => {
  setBillingEnv(t, { LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY });
  const calls = mockFetchFor(t, (call) => {
    if (call.url.includes("/customer-api/me")) {
      assert.equal(call.authorization, "Bearer latch_session_token_mock");
      return jsonResponse({ email: CUSTOMER_EMAIL });
    }
    if (call.url === "https://api.stripe.com/v1/checkout/sessions") {
      return jsonResponse({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" });
    }
    throw new Error("unexpected fetch: " + call.url);
  });
  const app = newBillingApp();
  const response = await app.request("/api/latch-billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearerHeaders() },
    body: JSON.stringify({ planId: "latch-monthly" }),
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { url: string }).url, "https://checkout.stripe.com/c/pay/cs_test_123");
  const stripeCall = calls.find((call) => call.url.includes("api.stripe.com"));
  assert.ok(stripeCall);
  assert.equal(stripeCall.authorization, "Bearer " + STRIPE_SECRET_KEY);
  const form = new URLSearchParams(stripeCall.body ?? "");
  assert.equal(form.get("mode"), "subscription");
  assert.equal(form.get("line_items[0][price]"), "price_1ULT95AGlri04kDx2j1qRXFa");
  assert.equal(form.get("customer_email"), CUSTOMER_EMAIL);
  assert.equal(form.get("metadata[latch_kind]"), "subscription");
  assert.equal(form.get("metadata[latch_customer_email]"), CUSTOMER_EMAIL);
  assert.equal(form.get("metadata[latch_plan]"), "latch-monthly");
  assert.equal(form.get("subscription_data[metadata][latch_kind]"), "subscription");
  assert.equal(form.get("subscription_data[metadata][latch_plan]"), "latch-monthly");
  assert.equal(form.get("success_url"), "https://latch.xlaunch.work/pricing?checkout=success");
});

test("checkout passes a Stripe error status and message through", async (t) => {
  setBillingEnv(t, { LATCH_STRIPE_SECRET_KEY: STRIPE_SECRET_KEY });
  mockFetchFor(t, (call) => {
    if (call.url.includes("/customer-api/me")) {
      return jsonResponse({ email: CUSTOMER_EMAIL });
    }
    return jsonResponse({ error: { message: "The price was moved to a different product." } }, 400);
  });
  const app = newBillingApp();
  const response = await app.request("/api/latch-billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearerHeaders() },
    body: JSON.stringify({ planId: "latch-yearly" }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.equal(body.error.message, "The price was moved to a different product.");
});
