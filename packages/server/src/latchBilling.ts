// Latch-owned subscription billing: Stripe Checkout + webhooks (test mode first)
// for the Latch product, fully separate from the xlaunch billing service — it
// reuses only that service's gateway service-api credit contract (POST
// /service-api/credits, idempotent by paymentId); the service itself is never
// modified.
//
// Contract references (read-only): xlaunch-agent-web/server/src/gateway.ts
// (applyCredit), src/webhook.ts (CreditInstruction / event-to-credit rules),
// src/checkout.ts (session params).
//
// Security stance:
// - The Stripe key and gateway service token are read only from this process
//   env (LATCH_STRIPE_SECRET_KEY / LATCH_GATEWAY_SERVICE_TOKEN); never logged
//   or echoed in responses.
// - The webhook relies on no signing secret: parse the event id, re-fetch it
//   with GET /v1/events/:id using the secret key, and process only the fetched
//   event — authenticity comes from that API call, not the request body.
// - Idempotency: the credited paymentId is the paid object's id (session /
//   invoice); the gateway dedupes by paymentId, and an in-process
//   processed-event-id set adds a second layer so one event is never credited
//   twice.
import type { Context, Hono } from "hono";
import { buildLatchAccountApiUrl, readLatchAccountEnv } from "@zcode/services";

// Upstream timeouts for the Stripe API and gateway service-api (15s/10s): a
// timeout is treated as an unreachable upstream; the webhook then returns 5xx
// so Stripe retries (Stripe redelivers on non-2xx automatically).
const STRIPE_API_TIMEOUT_MS = 15_000;
const GATEWAY_SERVICE_TIMEOUT_MS = 10_000;

const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";

// Gateway service-api base URL: same gateway domain as the customer-api used
// by latchAccountProxy; fully overridable via env
// (LATCH_GATEWAY_SERVICE_API_URL), defaulting to the production gateway.
const DEFAULT_LATCH_GATEWAY_SERVICE_API_BASE_URL = "https://gateway.xlaunch.work/service-api";
const LATCH_GATEWAY_SERVICE_API_URL_ENV_KEY = "LATCH_GATEWAY_SERVICE_API_URL";
const LATCH_STRIPE_SECRET_KEY_ENV_KEY = "LATCH_STRIPE_SECRET_KEY";
const LATCH_GATEWAY_SERVICE_TOKEN_ENV_KEY = "LATCH_GATEWAY_SERVICE_TOKEN";

// Checkout redirect URLs: Latch's own pricing page (not the xlaunch account page).
const LATCH_CHECKOUT_SUCCESS_URL = "https://latch.xlaunch.work/pricing?checkout=success";
const LATCH_CHECKOUT_CANCEL_URL = "https://latch.xlaunch.work/pricing?checkout=cancelled";

// Plan catalog and credited amounts. creditCents (the gateway credit included
// with each subscription period) is a founder-adjustable policy constant,
// defined in this one place: both the catalog copy (config route) and the
// webhook credit settlement read it here.
// priceIds verified against the Stripe API (test mode, GET /v1/prices?active=true).
interface LatchPlan {
  readonly id: "latch-monthly" | "latch-yearly";
  readonly name: string;
  readonly priceId: string;
  readonly amountCents: number;
  readonly creditCents: number;
  readonly interval: "month" | "year";
}

const LATCH_PLANS: readonly LatchPlan[] = [
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
const LATCH_PLANS_BY_ID = new Map<string, (typeof LATCH_PLANS)[number]>(
  LATCH_PLANS.map((plan) => [plan.id, plan] as const),
);

// Metadata keys written onto the session and subscription at checkout: after
// the webhook re-fetches the event, these locate the account to credit
// (mirrors the estate's META usage, keys renamed to the Latch namespace).
const LATCH_META = {
  kind: "latch_kind",
  email: "latch_customer_email",
  plan: "latch_plan",
} as const;

// Gateway error contract, same shape as latchAccountProxy:
// { error: { message } }; web error classification reads error.message.
interface LatchBillingErrorBody {
  error: { message: string };
}

// Statuses this proxy itself returns; Stripe-passed 4xx/5xx collapse into the
// same set, unknown statuses fall back to 502.
const BILLING_ERROR_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504] as const;

type BillingErrorStatus = (typeof BILLING_ERROR_STATUSES)[number];

function billingError(c: Context, status: BillingErrorStatus, message: string): Response {
  return c.json({ error: { message } } satisfies LatchBillingErrorBody, status, {
    "cache-control": "no-store",
  });
}

/** Stripe error passthrough: 4xx/5xx mapped as-is (unknown statuses become 502), message kept verbatim. */
function toBillingErrorStatus(status: number): BillingErrorStatus {
  return BILLING_ERROR_STATUSES.includes(status as BillingErrorStatus)
    ? (status as BillingErrorStatus)
    : 502;
}

function readEnvValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Without the Stripe key / service token billing is unavailable: return 503 so the frontend can say so, never fail silently. */
function readStripeSecretKey(): string | undefined {
  const key = readEnvValue(LATCH_STRIPE_SECRET_KEY_ENV_KEY);
  return key && key.startsWith("sk_") ? key : undefined;
}

function resolveGatewayServiceApiBaseUrl(): string {
  const override = readEnvValue(LATCH_GATEWAY_SERVICE_API_URL_ENV_KEY);
  return (override ?? DEFAULT_LATCH_GATEWAY_SERVICE_API_BASE_URL).replace(/\/+$/, "");
}

function readBearerToken(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header) {
    return null;
  }
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token ? token : null;
}

// In-process set of processed event ids: a concurrent redelivery or manual
// replay credits the same event only once; the gateway's paymentId dedupe is
// the final backstop. The set has a cap to bound memory on long runs.
const PROCESSED_EVENT_IDS_LIMIT = 10_000;
const processedEventIds = new Set<string>();

function markEventProcessed(eventId: string): boolean {
  if (processedEventIds.has(eventId)) {
    return false;
  }
  if (processedEventIds.size >= PROCESSED_EVENT_IDS_LIMIT) {
    // Simple eviction: clear, then re-add. The gateway paymentId dedupe still
    // backstops, so this cannot double-credit.
    processedEventIds.clear();
  }
  processedEventIds.add(eventId);
  return true;
}

// ---- Stripe REST (fetch + form-encoded; no Stripe SDK) ----------------------

function encodeStripeForm(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value);
  }
  return params.toString();
}

interface StripeResult<T> {
  ok: boolean;
  status: number;
  payload: T | { error: { message: string } };
}

/** Stripe call funnel: Bearer auth, timeout, error passthrough; keys and tokens never logged. */
async function callStripeApi(
  secretKey: string,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<StripeResult<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(STRIPE_API_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      payload: {
        error: { message: timedOut ? "Stripe API timed out" : "Stripe API is unreachable" },
      },
    };
  }
  const raw = await response.text();
  let payload: unknown;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      return {
        ok: false,
        status: 502,
        payload: { error: { message: "Unexpected non-JSON response from Stripe" } },
      };
    }
  } else {
    payload = {};
  }
  return {
    ok: response.ok,
    status: response.status,
    payload: payload as Record<string, unknown>,
  };
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function metadataOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// ---- webhook event -> credit instruction (mirrors estate webhook.ts) ----------

interface CreditInstruction {
  readonly customerEmail: string;
  readonly amountCents: number;
  readonly currency: "usd";
  readonly paymentId: string;
  readonly reason: string;
}

interface PlanInstruction {
  readonly customerEmail: string;
  readonly plan: string | null;
  readonly subscriptionRef: string;
  readonly renewsAtMs: number | null;
}

type EventOutcome =
  | { action: "credit"; credit: CreditInstruction; plan?: PlanInstruction }
  | { action: "plan"; plan: PlanInstruction }
  | { action: "ignore"; why: string };

/**
 * Reads metadata off an invoice: the new Stripe API puts it at
 * parent.subscription_details.metadata, the old one at
 * subscription_details.metadata (same compat read as estate webhook.ts).
 */
function invoiceMetadataOf(invoice: Record<string, unknown>): Record<string, unknown> {
  const parent = metadataOf(invoice["parent"]);
  const details = metadataOf(parent["subscription_details"] ?? invoice["subscription_details"]);
  return metadataOf(details["metadata"]);
}

/** Invoice coverage-period end (in ms); null when unreadable — never guessed. */
function periodEndOf(invoice: Record<string, unknown>): number | null {
  const lines = metadataOf(invoice["lines"]);
  const data = Array.isArray(lines["data"]) ? lines["data"] : [];
  let latest: number | null = null;
  for (const line of data) {
    const period = metadataOf(metadataOf(line)["period"]);
    const end = period["end"];
    if (
      typeof end === "number" &&
      Number.isFinite(end) &&
      end > 0 &&
      (latest === null || end > latest)
    ) {
      latest = end;
    }
  }
  return latest === null ? null : latest * 1000;
}

/**
 * Event -> settlement instruction, semantics aligned with estate webhook.ts
 * outcomeOf:
 * - checkout.session.completes credit only in payment mode (Latch sells only
 *   subscriptions; subscription sessions are NOT credited here — their first
 *   invoice.paid does it, avoiding a double first-period credit);
 * - invoice.paid credits only when it carries Latch subscription metadata, in
 *   the catalog's creditCents amount (the founder-adjustable constant).
 *
 * Critical premise: the founder's Latch test key shares one Stripe account
 * with the xlaunch estate billing services (verified: that account also
 * carries the billing.xlaunch.work / synapse / gridframes webhooks), so this
 * webhook also receives estate events — any event missing Latch metadata is
 * ignored and NEVER credited by customer_email fallback, or estate payments
 * would be double-credited.
 */
function outcomeOf(event: Record<string, unknown>): EventOutcome {
  const type = readText(event["type"]);
  const object = metadataOf(metadataOf(event["data"])["object"]);
  const metadata = metadataOf(object["metadata"]);

  if (type === "checkout.session.completed") {
    // Only Latch's own metadata counts (written onto the session at checkout).
    if (metadata[LATCH_META.kind] !== "subscription") {
      return { action: "ignore", why: "not a Latch checkout session" };
    }
    if (object["mode"] !== "payment") {
      return { action: "ignore", why: "subscription sessions are credited by their invoice" };
    }
    if (object["payment_status"] !== "paid") {
      return { action: "ignore", why: "session is not paid yet" };
    }
    const email = readText(metadata[LATCH_META.email]);
    const id = readText(object["id"]);
    const amount = object["amount_total"];
    if (email === undefined || id === undefined) {
      return { action: "ignore", why: "session carries no account" };
    }
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
      return { action: "ignore", why: "session carries no amount" };
    }
    return {
      action: "credit",
      credit: {
        customerEmail: email,
        amountCents: amount,
        currency: "usd",
        paymentId: id,
        reason: "Latch gateway credit top-up",
      },
    };
  }

  if (type === "invoice.paid") {
    const id = readText(object["id"]);
    const invoiceMetadata = invoiceMetadataOf(object);
    // Only the Latch account inside subscription metadata counts (estate
    // invoices carry no Latch metadata and are dropped here). Never fall back
    // to customer_email.
    if (invoiceMetadata[LATCH_META.kind] !== "subscription") {
      return { action: "ignore", why: "not a Latch subscription invoice" };
    }
    const email = readText(invoiceMetadata[LATCH_META.email]);
    const plan = LATCH_PLANS_BY_ID.get(readText(invoiceMetadata[LATCH_META.plan]) ?? "");
    if (email === undefined || id === undefined) {
      return { action: "ignore", why: "invoice carries no account" };
    }
    const paid = object["amount_paid"];
    if (typeof paid !== "number" || paid <= 0) {
      return { action: "ignore", why: "nothing was paid on this invoice" };
    }
    const credit: CreditInstruction = {
      customerEmail: email,
      amountCents: plan ? plan.creditCents : paid,
      currency: "usd",
      paymentId: id,
      reason: plan ? `Latch ${plan.id} plan: included credit` : "Latch subscription payment",
    };
    const details = metadataOf(
      metadataOf(object["parent"])["subscription_details"] ?? object["subscription_details"],
    );
    const subscriptionRef = readText(details["subscription"]) ?? readText(object["subscription"]);
    if (subscriptionRef === undefined) {
      return { action: "credit", credit };
    }
    return {
      action: "credit",
      credit,
      plan: {
        customerEmail: email,
        plan: plan ? plan.id : null,
        subscriptionRef,
        renewsAtMs: periodEndOf(object),
      },
    };
  }

  return { action: "ignore", why: `event type ${type ?? "(unknown)"} moves no credit` };
}

// ---- gateway service-api (mirrors estate gateway.ts applyCredit / applyPlan) --

type GatewayCallResult =
  | { state: "applied" | "already-applied" | "recorded" | "no-such-customer" }
  | {
      state: "unavailable";
      message: string;
    };

async function callGatewayServiceApi(
  serviceToken: string,
  path: "/credits" | "/plan",
  body: unknown,
): Promise<GatewayCallResult> {
  let response: Response;
  try {
    response = await fetch(`${resolveGatewayServiceApiBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_SERVICE_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      state: "unavailable",
      message: timedOut ? "gateway service API timed out" : "gateway service API is unreachable",
    };
  }
  // 404 = account does not exist (estate semantics: treat as settled, do not
  // retry); 401/5xx etc. are treated as unreachable — the webhook returns 5xx
  // so Stripe retries (the payment is real and must not be lost to a token
  // rotation).
  if (response.status === 404) {
    return { state: "no-such-customer" };
  }
  if (response.status !== 200 && response.status !== 201) {
    return { state: "unavailable", message: `gateway service API answered ${response.status}` };
  }
  return { state: "applied" };
}

/**
 * Exchange the Latch server's own session token for the account email: the
 * same customer-api path as /api/latch-account/me ("resolve the customer
 * email like the account proxy does"). The email is never taken from the
 * request body.
 */
async function resolveCustomerEmail(token: string): Promise<string | undefined> {
  const env = readLatchAccountEnv();
  let response: Response;
  try {
    response = await fetch(buildLatchAccountApiUrl(env, "/me"), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(STRIPE_API_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  const payload: unknown = await response.json().catch(() => undefined);
  const email =
    typeof payload === "object" && payload !== null
      ? readText(metadataOf(payload)["email"])
      : undefined;
  return email;
}

/**
 * Registers the /api/latch-billing/* routes.
 *
 * @param app - The Hono instance created in http.ts; must be registered
 * before the static-asset catch-all.
 */
export function registerLatchBillingRoutes(app: Hono): void {
  // Plan catalog: public (the pricing page renders signed-out too), no secrets.
  app.get("/api/latch-billing/config", (c) =>
    c.json(
      {
        plans: LATCH_PLANS.map((plan) => ({
          id: plan.id,
          name: plan.name,
          priceId: plan.priceId,
          amountCents: plan.amountCents,
          creditCents: plan.creditCents,
          interval: plan.interval,
          currency: "usd",
          // Copy line: each subscription includes an equal gateway credit
          // ('includes $14 / $99 of gateway credit').
          creditLabel: `includes $${plan.creditCents / 100} of gateway credit`,
        })),
      },
      200,
      { "cache-control": "no-store" },
    ),
  );

  // Start a Checkout: the Bearer token is a Latch session token; the email is
  // resolved from customer-api /me.
  app.post("/api/latch-billing/checkout", async (c) => {
    const secretKey = readStripeSecretKey();
    if (!secretKey) {
      return billingError(c, 503, "Latch billing is not configured");
    }
    const token = readBearerToken(c);
    if (!token) {
      return billingError(c, 401, "Sign in required");
    }
    const raw = await c.req.json().catch(() => undefined);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return billingError(c, 400, "A JSON request body is required");
    }
    const planId = readText(metadataOf(raw)["planId"]);
    const plan = planId ? LATCH_PLANS_BY_ID.get(planId) : undefined;
    if (!plan) {
      return billingError(c, 400, "Unknown plan");
    }
    const email = await resolveCustomerEmail(token);
    if (!email) {
      return billingError(c, 401, "Sign in required");
    }

    // Metadata is written onto BOTH the session and the subscription: renewal
    // invoices carry only the subscription's metadata, and the webhook uses it
    // to locate the account to credit (same approach as estate checkout.ts).
    const latchMetadata = {
      [LATCH_META.kind]: "subscription",
      [LATCH_META.email]: email,
      [LATCH_META.plan]: plan.id,
    };
    const form = encodeStripeForm({
      mode: "subscription",
      "line_items[0][price]": plan.priceId,
      "line_items[0][quantity]": "1",
      customer_email: email,
      client_reference_id: email,
      success_url: LATCH_CHECKOUT_SUCCESS_URL,
      cancel_url: LATCH_CHECKOUT_CANCEL_URL,
      ...Object.fromEntries([
        ...Object.entries(latchMetadata).map(([key, value]) => [`metadata[${key}]`, value]),
        ...Object.entries(latchMetadata).map(([key, value]) => [
          `subscription_data[metadata][${key}]`,
          value,
        ]),
      ]),
    });
    const result = await callStripeApi(secretKey, "/checkout/sessions", {
      method: "POST",
      body: form,
    });
    if (!result.ok) {
      // The payload is wide (T | {error}); `in` narrowing can't reach
      // error.message — read Stripe's message through an explicitly typed
      // local; runtime behavior unchanged.
      const errorPayload = result.payload as { error?: { message?: unknown } } | null;
      const message =
        typeof errorPayload === "object" &&
        errorPayload !== null &&
        typeof errorPayload.error?.message === "string"
          ? errorPayload.error.message
          : "Stripe checkout is unavailable";
      // Stripe's own errors (400/402/429…) pass through with the original
      // status and message; timeout/unreachable already collapsed to 504/502
      // upstream.
      return billingError(c, toBillingErrorStatus(result.status), message);
    }
    const sessionUrl = readText(metadataOf(result.payload)["url"]);
    if (!sessionUrl) {
      return billingError(c, 502, "Stripe checkout is unavailable");
    }
    return c.json({ url: sessionUrl }, 200, { "cache-control": "no-store" });
  });

  // Stripe webhook: no signature check (per the founder's constraint,
  // API-created endpoints hold no signing secret). Instead the event is
  // re-fetched via GET /v1/events/:id — only the fetched event is processed;
  // authenticity comes from that API call.
  app.post("/api/latch-billing/webhook", async (c) => {
    const secretKey = readStripeSecretKey();
    if (!secretKey) {
      return billingError(c, 503, "Latch billing is not configured");
    }
    const serviceToken = readEnvValue(LATCH_GATEWAY_SERVICE_TOKEN_ENV_KEY);
    if (!serviceToken) {
      // Without the crediting token, payment events must not be consumed:
      // return 5xx so Stripe retries rather than dropping them silently.
      return billingError(c, 503, "Latch billing is not configured");
    }
    const raw = await c.req.text().catch(() => "");
    let postedEventId: string | undefined;
    if (raw.trim()) {
      try {
        postedEventId = readText(metadataOf(JSON.parse(raw) as unknown)["id"]);
      } catch {
        postedEventId = undefined;
      }
    }
    if (!postedEventId) {
      return billingError(c, 400, "A Stripe event payload is required");
    }

    const fetched = await callStripeApi(secretKey, `/events/${encodeURIComponent(postedEventId)}`, {
      method: "GET",
    });
    if (!fetched.ok) {
      // Fetch failure = the event is untrusted or Stripe is unreachable:
      // return 4xx/5xx so Stripe retries.
      return billingError(c, 502, "Stripe event could not be verified");
    }
    const event = fetched.payload as Record<string, unknown>;
    const eventId = readText(event["id"]);
    if (!eventId || eventId !== postedEventId) {
      return billingError(c, 400, "Stripe event could not be verified");
    }
    if (!markEventProcessed(eventId)) {
      // The event was already processed in this run: confirm it and never credit twice.
      return c.json({ received: true, outcome: "already-processed" }, 200, {
        "cache-control": "no-store",
      });
    }

    const outcome = outcomeOf(event);
    if (outcome.action === "ignore") {
      return c.json({ received: true, outcome: "ignored" }, 200, { "cache-control": "no-store" });
    }
    if (outcome.action === "plan") {
      const result = await callGatewayServiceApi(serviceToken, "/plan", outcome.plan);
      if (result.state === "unavailable") {
        return billingError(c, 502, result.message);
      }
      return c.json({ received: true, outcome: result.state }, 200, {
        "cache-control": "no-store",
      });
    }

    const creditResult = await callGatewayServiceApi(serviceToken, "/credits", outcome.credit);
    if (creditResult.state === "unavailable") {
      return billingError(c, 502, creditResult.message);
    }
    // A failed plan record does not roll back the credit: like the estate,
    // credit lands first and the plan is left to a later event.
    if (outcome.plan) {
      await callGatewayServiceApi(serviceToken, "/plan", outcome.plan);
    }
    return c.json({ received: true, outcome: creditResult.state }, 200, {
      "cache-control": "no-store",
    });
  });
}
