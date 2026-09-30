/**
 * G1 integration suite — proves @latch/provider-gateway against a local
 * node:http mock of the Northlatch Gateway (startMockServer in
 * ./mock-gateway.ts spins up the real socket; this file supplies the gateway
 * behavior on top of it).
 *
 * Contract under test (see README.md "Header contract" and "Usage metering"):
 * 1. Catalog — GET /v1/models serves two models, one of them plan-gated.
 * 2. Auth — every /v1/* request carries `Authorization: Bearer <LATCH_API_KEY>`
 *    (wired from the environment through readConfig); an unknown key gets 401
 *    from the gateway and surfaces as GatewayAuthError.
 * 3. Plan gating — the gateway enforces it server-side, keyed on the bearer
 *    header; planGate() advises from the customer-api account status.
 * 4. Metering — 100 seeded chat completions accumulate a cost that equals the
 *    arithmetic sum exactly, compared in integer cents (the G1 "to the cent"
 *    gate) and, stronger, in integer nano-USD.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  chatCompletion,
  createPriceTable,
  defaultPriceTablePath,
  GatewayAuthError,
  listModels,
  loadPriceTable,
  planGate,
  readConfig,
  type GatewayModel,
  type MeteringEvent,
  type MeteringSink,
} from "../src/index.js";
import { chatCompletionBody, startMockServer, type MockHandler } from "./mock-gateway.js";

const GATED_MODEL = "fusion";
const OPEN_MODEL = "auto";
/** Key whose plan ("pro") entitles the gated model. */
const ENTITLED_KEY = "latch-key-pro";
/** Valid key whose plan ("free") does not entitle the gated model. */
const FREE_KEY = "latch-key-free";

/**
 * Reconciliation price table — mirrors product/identity/price-table.yaml
 * (fusion 0.003/0.015, auto 0.0005/0.0015, USD per 1k tokens).
 * The test recomputes every cost from these literals independently of
 * src/metering.ts (see MICRO_RATES_PER_1K below), so agreement is a true
 * reconciliation, not a restatement.
 */
const RATE_TABLE = {
  [GATED_MODEL]: { prompt: "0.003", completion: "0.015" },
  [OPEN_MODEL]: { prompt: "0.0005", completion: "0.0015" },
} as const;

/**
 * The same rates as integer micro-USD (USD × 1e6) per 1k tokens, derived by
 * hand from the literals above — the independent side of the reconciliation:
 * "0.003" → 3000, "0.015" → 15000, "0.0005" → 500, "0.0015" → 1500.
 */
const MICRO_RATES_PER_1K = {
  [GATED_MODEL]: { prompt: 3000, completion: 15000 },
  [OPEN_MODEL]: { prompt: 500, completion: 1500 },
} as const;

const NANO_USD = 1e9;
/** One cent is $0.01 = 1e7 nano-USD. */
const NANO_USD_PER_CENT = 1e7;

/** GET /v1/models body: two models, fusion marked as plan-gated. */
const CATALOG = {
  object: "list",
  data: [
    { id: OPEN_MODEL, object: "model", owned_by: "latch" },
    { id: GATED_MODEL, object: "model", owned_by: "latch", plan_required: "pro" },
  ],
};

/** One seeded call: the model to request and the usage the gateway reports. */
interface SeededCall {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Deterministic seed schedule for the metering reconciliation: index
 * arithmetic only, so every token count is fixed and auditable. Every third
 * call rides the open model; prompt tokens fall in 120..599, completion
 * tokens in 40..299, `total_tokens` is always the sum.
 */
function seededCalls(count: number): SeededCall[] {
  return Array.from({ length: count }, (_, index) => {
    const promptTokens = 120 + ((index * 37) % 480);
    const completionTokens = 40 + ((index * 53) % 260);
    return {
      model: index % 3 === 0 ? OPEN_MODEL : GATED_MODEL,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  });
}

/** Independent arithmetic: exact integer nano-USD cost of one seeded call. */
function expectedNanoUsd(seed: SeededCall): number {
  const rates = MICRO_RATES_PER_1K[seed.model as keyof typeof MICRO_RATES_PER_1K];
  return seed.promptTokens * rates.prompt + seed.completionTokens * rates.completion;
}

/**
 * The G1 mock gateway. Enforces, in order:
 * - Auth: a bearer of any known key passes; anything else (including a
 *   missing header) gets a 401 OpenAI-shaped error.
 * - Catalog: GET /v1/models serves {@link CATALOG}.
 * - Plan gating (server-side, keyed on the bearer): the gated model answers
 *   only for the entitled key; a valid-but-free key gets 403.
 * - Chat completions: each POST serves the next seeded usage verbatim, so the
 *   client is driven by a known schedule. A request for the wrong seeded
 *   model, or past the end of the schedule, is a 4xx/5xx rather than a lie.
 */
function createG1Gateway(seeds: SeededCall[]): MockHandler {
  let calls = 0;
  return (request, respond) => {
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${ENTITLED_KEY}` && authorization !== `Bearer ${FREE_KEY}`) {
      respond(401, {
        error: { message: "invalid api key", type: "invalid_request_error", code: "invalid_api_key" },
      });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      respond(200, CATALOG);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const seed = seeds[calls];
      if (!seed) {
        respond(500, { error: { message: "G1 seed schedule exhausted" } });
        return;
      }
      const body = JSON.parse(request.rawBody) as { model?: string };
      if (body.model !== seed.model) {
        respond(400, { error: { message: `expected seeded model ${seed.model}, got ${body.model}` } });
        return;
      }
      if (seed.model === GATED_MODEL && authorization !== `Bearer ${ENTITLED_KEY}`) {
        respond(403, {
          error: {
            message: `model ${GATED_MODEL} requires plan "pro"`,
            type: "invalid_request_error",
            code: "model_not_entitled",
          },
        });
        return;
      }
      const index = calls;
      calls += 1;
      respond(
        200,
        chatCompletionBody({
          id: `chatcmpl-g1-${index}`,
          model: seed.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `g1 reply ${index}` },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: seed.promptTokens,
            completion_tokens: seed.completionTokens,
            total_tokens: seed.totalTokens,
          },
        }),
      );
      return;
    }
    respond(404, { error: { message: `no route ${request.method} ${request.url}` } });
  };
}

/** Config wired from the environment exactly as production reads it. */
function configFromEnv(mockUrl: string, apiKey: string) {
  return readConfig({ LATCH_GATEWAY_URL: mockUrl, LATCH_API_KEY: apiKey });
}

/** Sink that records every event for assertions. */
function recordingSink(): MeteringSink & { events: MeteringEvent[] } {
  const events: MeteringEvent[] = [];
  return { events, emit: (event) => void events.push(event) };
}

test("G1 catalog and plan gating: /v1/models serves two models, one gated; enforcement is server-side and planGate decides from account status", async () => {
  // GATE BOUNDARY (src/plan-gate.ts): the gateway defines no response headers
  // carrying per-model plan entitlements, so planGate never sees the model —
  // it projects a customer-api /me status into the advisory client decision
  // (billing off allows; billing on requires a positive balance). Plan
  // gating itself is enforced where it can see the credential: server-side,
  // keyed on the `Authorization: Bearer <LATCH_API_KEY>` header (README
  // "Header contract"). This test pins both halves — the server-side
  // enforcement below, and the account-status decision at the end.
  // One gated seed: the free key's refusal consumes nothing, the entitled
  // key's pass serves seeds[0].
  const seeds: SeededCall[] = [
    { model: GATED_MODEL, promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  ];
  const mock = await startMockServer(createG1Gateway(seeds));
  try {
    const catalog = await listModels(configFromEnv(mock.url, FREE_KEY));
    assert.equal(catalog.object, "list");
    assert.deepEqual(
      catalog.data.map((model) => model.id).sort(),
      [OPEN_MODEL, GATED_MODEL], // lexicographic: "auto" < "fusion"
    );
    // The catalog marks the gated model. `plan_required` is this mock's
    // marker; the real gateway will carry entitlements in response headers
    // whose names are not defined yet (the stub boundary above).
    const gated = catalog.data.find((model) => model.id === GATED_MODEL) as
      | (GatewayModel & { plan_required?: string })
      | undefined;
    assert.ok(gated, "catalog must list the gated model");
    assert.equal(gated.plan_required, "pro");

    // Server-side enforcement, keyed on the bearer: the free key is refused
    // on the gated model (403 → GatewayAuthError per src/client.ts mapping).
    await assert.rejects(
      chatCompletion(configFromEnv(mock.url, FREE_KEY), {
        model: GATED_MODEL,
        messages: [{ role: "user", content: "gate me" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayAuthError);
        assert.equal(error.status, 403);
        assert.match(error.body, /model_not_entitled/);
        return true;
      },
    );
    // ...and the entitled key passes the same call.
    const allowed = await chatCompletion(configFromEnv(mock.url, ENTITLED_KEY), {
      model: GATED_MODEL,
      messages: [{ role: "user", content: "gate me" }],
    });
    assert.equal(allowed.content, "g1 reply 0");

    // The client-side gate, pinned to the account-status contract (see
    // src/plan-gate.ts): it decides from a /me-shaped status, never from the
    // model. The free key's account (no plan, no balance) is denied; the
    // entitled key's account (pro with credit) is allowed. Enforcement of the
    // gated MODEL itself stays server-side above — planGate does not see it.
    assert.deepEqual(
      planGate({ billingEnabled: true, balanceMicros: 0, plan: null }),
      { allowed: false, plan: "free" },
    );
    assert.deepEqual(
      planGate({ billingEnabled: true, balanceMicros: 5_000_000, plan: { plan: "pro" } }),
      { allowed: true, plan: "pro" },
    );
  } finally {
    await mock.close();
  }
});

test("G1 auth contract: every /v1/* request bears Bearer <LATCH_API_KEY>; an unknown key gets 401 and surfaces GatewayAuthError", async () => {
  const mock = await startMockServer(
    createG1Gateway([{ model: GATED_MODEL, promptTokens: 100, completionTokens: 50, totalTokens: 150 }]),
  );
  try {
    // Right key: both endpoints send the bearer read from LATCH_API_KEY.
    const good = configFromEnv(mock.url, ENTITLED_KEY);
    await listModels(good);
    await chatCompletion(good, {
      model: GATED_MODEL,
      messages: [{ role: "user", content: "ping" }],
    });
    const [modelsRequest, chatRequest] = mock.requests;
    assert.ok(modelsRequest && chatRequest, "mock gateway received too few requests");
    assert.equal(modelsRequest.method, "GET");
    assert.equal(modelsRequest.url, "/v1/models");
    assert.equal(modelsRequest.headers.authorization, `Bearer ${ENTITLED_KEY}`);
    assert.equal(chatRequest.method, "POST");
    assert.equal(chatRequest.url, "/v1/chat/completions");
    assert.equal(chatRequest.headers.authorization, `Bearer ${ENTITLED_KEY}`);

    // Wrong key: the gateway 401s and the provider surfaces GatewayAuthError.
    const bad = configFromEnv(mock.url, "latch-key-wrong");
    await assert.rejects(listModels(bad), (error: unknown) => {
      assert.ok(error instanceof GatewayAuthError);
      assert.equal(error.status, 401);
      assert.match(error.message, /invalid api key/);
      return true;
    });
    await assert.rejects(
      chatCompletion(bad, { model: GATED_MODEL, messages: [{ role: "user", content: "ping" }] }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayAuthError);
        assert.equal(error.status, 401);
        return true;
      },
    );
    // The rejected attempts did reach the gateway carrying the bad key —
    // the env var flowed into the header, and the gateway (not the client)
    // judged it.
    const rejected = mock.requests.filter(
      (request) => request.headers.authorization === "Bearer latch-key-wrong",
    );
    assert.equal(rejected.length, 2);
  } finally {
    await mock.close();
  }
});

test("G1 metering reconciliation: 100 seeded calls accumulate the arithmetic cost exactly, to the cent", async () => {
  const seeds = seededCalls(100);
  const mock = await startMockServer(createG1Gateway(seeds));
  try {
    const config = configFromEnv(mock.url, ENTITLED_KEY);
    const priceTable = createPriceTable(RATE_TABLE);
    // The entries used for reconciliation price identically to the shipped
    // product/identity/price-table.yaml.
    const shipped = loadPriceTable(defaultPriceTablePath());
    assert.deepEqual(priceTable.priceFor(GATED_MODEL), shipped.priceFor(GATED_MODEL));
    assert.deepEqual(priceTable.priceFor(OPEN_MODEL), shipped.priceFor(OPEN_MODEL));

    const sink = recordingSink();
    for (const [index, seed] of seeds.entries()) {
      const result = await chatCompletion(
        config,
        { model: seed.model, messages: [{ role: "user", content: `g1 call ${index}` }] },
        { sink, priceTable },
      );
      assert.equal(result.metering.requestId, `chatcmpl-g1-${index}`);
      assert.ok(result.usage, "every seeded response carries usage");
    }

    // All 100 calls reached the gateway as authorized chat completions.
    assert.equal(sink.events.length, 100);
    assert.equal(mock.requests.length, 100);
    for (const request of mock.requests) {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${ENTITLED_KEY}`);
    }

    // Token reconciliation: each event mirrors its seed, and the aggregates
    // match the schedule's sums.
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    for (const [index, event] of sink.events.entries()) {
      // The sink records exactly one event per seeded call (asserted above).
      const seed = seeds[index]!;
      assert.equal(event.model, seed.model);
      assert.equal(event.promptTokens, seed.promptTokens);
      assert.equal(event.completionTokens, seed.completionTokens);
      assert.equal(event.totalTokens, seed.totalTokens);
      // Per-call exactness in integer nano-USD — stronger than cents.
      assert.equal(Math.round(event.costUsd * NANO_USD), expectedNanoUsd(seed));
      promptTokens += event.promptTokens;
      completionTokens += event.completionTokens;
      totalTokens += event.totalTokens;
    }
    assert.equal(promptTokens, seeds.reduce((sum, seed) => sum + seed.promptTokens, 0));
    assert.equal(completionTokens, seeds.reduce((sum, seed) => sum + seed.completionTokens, 0));
    assert.equal(totalTokens, seeds.reduce((sum, seed) => sum + seed.totalTokens, 0));

    // THE G1 "to the cent" gate: the accumulated cost equals the arithmetic
    // sum of tokens × rates, compared as integer cents — no float tolerance.
    const expectedNanoTotal = seeds.reduce((sum, seed) => sum + expectedNanoUsd(seed), 0);
    const accumulatedUsd = sink.events.reduce((sum, event) => sum + event.costUsd, 0);
    assert.equal(
      Math.round(accumulatedUsd * 100),
      Math.round(expectedNanoTotal / NANO_USD_PER_CENT),
    );
    // And the same equality at full precision, in integer nano-USD.
    assert.equal(Math.round(accumulatedUsd * NANO_USD), expectedNanoTotal);
  } finally {
    await mock.close();
  }
});
