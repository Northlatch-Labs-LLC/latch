/**
 * HUD P0 caps suite — U-1 predictive rail, U-2 runaway-guard signal,
 * U-3 per-call ceiling, plus the gateway 402 contract (INV-5: server-side
 * enforcement; the client renders and pre-flights, never bypasses).
 *
 * The reconciliation price table mirrors product/identity/price-table.yaml,
 * and every expected cost is computed from literals independently of the
 * code under test (same discipline as integration.g1.test.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  chatCompletion,
  createPriceTable,
  createSessionCapLedger,
  estimateCallCostUsd,
  GatewayCapError,
  PerCallCeilingExceededError,
  type MeteringEvent,
} from "../src/index.js";
import { startMockServer } from "./mock-gateway.js";

const PRICE_TABLE = createPriceTable({
  "auto": { prompt: "0.0005", completion: "0.0015" },
  "fusion": { prompt: "0.003", completion: "0.015" },
});

let clockMs = 0;
/** Fixed clock: each metering event lands exactly one minute apart. */
function meteredEvent(model: string, costUsd: number): MeteringEvent {
  clockMs += 60_000;
  return {
    model,
    promptTokens: 1000,
    completionTokens: 1000,
    totalTokens: 2000,
    costUsd,
    requestId: `req-${clockMs}`,
    timestamp: new Date(clockMs).toISOString(),
  };
}

test("rail reading: spend accumulates exactly in nano-USD and burn rate derives from the event window", () => {
  const ledger = createSessionCapLedger({ capUsd: 1, now: () => clockMs });
  // auto 1k/1k costs exactly 0.002; three calls = 0.006.
  ledger.record(meteredEvent("auto", 0.002));
  ledger.record(meteredEvent("auto", 0.002));
  ledger.record(meteredEvent("auto", 0.002));
  const rail = ledger.railReading();
  assert.equal(rail.spendUsd, 0.006);
  assert.equal(rail.capUsd, 1);
  assert.equal(rail.remainingUsd, 0.994);
  assert.equal(rail.events, 3);
  // Events sit one minute apart (1 → 3min window = 2 minutes); burn is 0.003/min.
  assert.ok(Math.abs((rail.burnRatePerMin ?? 0) - 0.003) < 1e-12, `burn ${rail.burnRatePerMin}`);
  // Time to cap: 0.994 remaining / 0.003 per min = 331.333… min.
  assert.ok(Math.abs((rail.timeToCapMin ?? 0) - 0.994 / 0.003) < 1e-6, `ttc ${rail.timeToCapMin}`);
  assert.ok(rail.now.endsWith("Z"));
});

test("rail reading: uncapped ledger renders burn rate but null cap math", () => {
  const ledger = createSessionCapLedger({ now: () => clockMs });
  ledger.record(meteredEvent("fusion", 0.018));
  const rail = ledger.railReading();
  assert.equal(rail.capUsd, null);
  assert.equal(rail.remainingUsd, null);
  assert.equal(rail.timeToCapMin, null);
  assert.equal(rail.burnRatePerMin, null); // one event: no window yet
});

test("projection: exact pre-flight cost, per-call ceiling verdict, one-shot warning at the threshold", () => {
  const ledger = createSessionCapLedger({ capUsd: 0.1, perCallCeilingUsd: 0.02, now: () => clockMs });
  // 0.004 spent; a fusion 2k/1k call costs exactly 0.021 (2*0.003 + 1*0.015).
  ledger.record(meteredEvent("auto", 0.004));
  const projection = ledger.projectCall({
    model: "fusion",
    promptTokens: 2000,
    maxCompletionTokens: 1000,
    priceTable: PRICE_TABLE,
  });
  assert.equal(projection.projectedCostUsd, 0.021);
  assert.equal(projection.spendAfterUsd, 0.025);
  assert.equal(projection.remainingAfterUsd, 0.075);
  assert.equal(projection.withinPerCallCeiling, false); // 0.021 > 0.02 ceiling
  assert.equal(projection.warning, null); // 0.025 < 80% of 0.1

  // A call that first crosses 80% of the cap warns exactly once.
  // spend 0.059 + a fusion 2k/1k call (0.021) = 0.080 — exactly the threshold.
  ledger.record(meteredEvent("fusion", 0.055));
  const crossing = ledger.projectCall({
    model: "fusion",
    promptTokens: 2000,
    maxCompletionTokens: 1000,
    priceTable: PRICE_TABLE,
  });
  assert.equal(crossing.projectedCostUsd, 0.021);
  assert.equal(crossing.spendAfterUsd, 0.08);
  assert.match(crossing.warning ?? "", /crosses 80% of the session cap/);
  assert.equal(ledger.warningFired(), true);

  const after = ledger.projectCall({
    model: "fusion",
    promptTokens: 1000,
    maxCompletionTokens: 1000,
    priceTable: PRICE_TABLE,
  });
  assert.equal(after.warning, null); // never repeats
  assert.equal(after.withinPerCallCeiling, true); // 0.018 <= 0.02
});

test("estimateCallCostUsd prices prompt plus the full completion allowance", () => {
  const estimate = estimateCallCostUsd(
    { model: "fusion", promptTokens: 1000, maxCompletionTokens: 500 },
    PRICE_TABLE,
  );
  // 1k * 0.003 + 0.5k * 0.015 = 0.0105 — the ceiling-safe upper bound.
  assert.equal(estimate, 0.0105);
});

test("advisory client-side ceiling throws PerCallCeilingExceededError with both numbers", () => {
  const error = new PerCallCeilingExceededError(0.021, 0.02);
  assert.equal(error.name, "PerCallCeilingExceededError");
  assert.equal(error.projectedCostUsd, 0.021);
  assert.equal(error.ceilingUsd, 0.02);
  assert.match(error.message, /per-call ceiling/);
});

test("gateway 402 contract: per-call ceiling refusal maps to GatewayCapError, retryable", async () => {
  const server = await startMockServer((_request, respond) => {
    respond(402, {
      error: {
        message: "projected cost $0.021000 exceeds the per-call ceiling $0.020000",
        type: "insufficient_quota",
        code: "per_call_ceiling_exceeded",
      },
    });
  });
  try {
    await assert.rejects(
      chatCompletion(
        { baseUrl: server.url, apiKey: "latch-key-pro" },
        { model: "fusion", messages: [{ role: "user", content: "hi" }] },
      ),
      (error: unknown) => {
        assert.ok(error instanceof GatewayCapError);
        assert.equal(error.code, "per_call_ceiling_exceeded");
        assert.equal(error.retryable, true); // a smaller request may pass
        assert.equal(error.status, 402);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("gateway 402 contract: session cap refusal maps to GatewayCapError, not retryable", async () => {
  const server = await startMockServer((_request, respond) => {
    respond(402, {
      error: {
        message: "projected session spend $1.006000 exceeds the session cap $1.000000",
        type: "insufficient_quota",
        code: "session_cap_exceeded",
      },
    });
  });
  try {
    await assert.rejects(
      chatCompletion(
        { baseUrl: server.url, apiKey: "latch-key-pro" },
        { model: "auto", messages: [{ role: "user", content: "hi" }] },
      ),
      (error: unknown) => {
        assert.ok(error instanceof GatewayCapError);
        assert.equal(error.code, "session_cap_exceeded");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});
