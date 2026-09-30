import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  chatCompletion,
  createMeteringLog,
  createPriceTable,
  defaultMeteringLog,
  defaultPriceTablePath,
  loadPriceTable,
  parsePriceTableYaml,
  parseUsage,
  PriceTableError,
  type GatewayConfig,
  type MeteringEvent,
  type MeteringSink,
  type Usage,
} from "../src/index.js";
import { chatCompletionBody, startMockServer } from "./mock-gateway.js";

/** Sink that records every event for assertions. */
function recordingSink(): MeteringSink & { events: MeteringEvent[] } {
  const events: MeteringEvent[] = [];
  return { events, emit: (event) => void events.push(event) };
}

/** A synthetic event with a distinguishable id. */
function eventWithRequestId(requestId: string): MeteringEvent {
  return {
    model: "fusion",
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    costUsd: 0,
    requestId,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

const USAGE_1500_500: Usage = { promptTokens: 1500, completionTokens: 500, totalTokens: 2000 };

test("parseUsage reads the OpenAI-compatible usage object", () => {
  assert.deepEqual(
    parseUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }),
    { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  );
});

test("parseUsage defaults total_tokens to prompt + completion when absent", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 7, completion_tokens: 3 }), {
    promptTokens: 7,
    completionTokens: 3,
    totalTokens: 10,
  });
});

test("parseUsage rejects missing or malformed usage objects", () => {
  assert.equal(parseUsage(undefined), undefined);
  assert.equal(parseUsage(null), undefined);
  assert.equal(parseUsage("1500"), undefined);
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage({ prompt_tokens: 1.5, completion_tokens: 2 }), undefined);
  assert.equal(parseUsage({ prompt_tokens: -1, completion_tokens: 2 }), undefined);
  assert.equal(parseUsage({ prompt_tokens: "10", completion_tokens: 20 }), undefined);
});

test("price tables price a split-rate usage to exact cents", () => {
  const table = createPriceTable({
    "fusion": { prompt: "0.003", completion: "0.015" },
  });
  assert.deepEqual(table.priceFor("fusion"), { prompt: 0.003, completion: 0.015 });
  // 1500 * $0.003/1k + 500 * $0.015/1k = $0.0045 + $0.0075 — exact, no float drift.
  assert.equal(table.costUsd("fusion", USAGE_1500_500), 0.012);
});

test("a scalar price entry rates prompt and completion alike", () => {
  const table = createPriceTable({ "flat-model": "0.001" });
  assert.deepEqual(table.priceFor("flat-model"), { prompt: 0.001, completion: 0.001 });
  assert.equal(table.costUsd("flat-model", { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 }), 0.002);
});

test("price entries given as JS numbers stay exact to the micro-dollar", () => {
  const table = createPriceTable({ "m": { prompt: 0.0003, completion: 0.0003 } });
  // 333 * $0.0003/1k = $0.0000999 exactly.
  assert.equal(table.costUsd("m", { promptTokens: 333, completionTokens: 0, totalTokens: 333 }), 0.0000999);
});

test("a model absent from the price table costs $0 but keeps its tokens", () => {
  const table = createPriceTable({ "fusion": { prompt: "0.003", completion: "0.015" } });
  assert.deepEqual(table.priceFor("unknown-model"), { prompt: 0, completion: 0 });
  assert.equal(table.costUsd("unknown-model", USAGE_1500_500), 0);
});

test("a missing side of a split entry falls back to the other side", () => {
  const table = createPriceTable({ "m": { prompt: "0.002" } });
  assert.deepEqual(table.priceFor("m"), { prompt: 0.002, completion: 0.002 });
});

test("invalid price entries throw PriceTableError", () => {
  assert.throws(() => createPriceTable({ "m": "not-a-number" }), PriceTableError);
  assert.throws(() => createPriceTable({ "m": "0.1234567" }), PriceTableError); // > 6 fraction digits
  assert.throws(() => createPriceTable({ "m": -0.003 }), PriceTableError);
});

test("loadPriceTable reads the shipped product/identity/price-table.yaml", () => {
  const table = loadPriceTable(defaultPriceTablePath());
  assert.deepEqual(table.priceFor("fusion"), { prompt: 0.003, completion: 0.015 });
  assert.deepEqual(table.priceFor("auto"), { prompt: 0.0005, completion: 0.0015 });
  assert.equal(table.costUsd("fusion", USAGE_1500_500), 0.012);
  assert.equal(
    table.costUsd("auto", { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 }),
    0.002,
  );
  assert.equal(table.costUsd("not-in-table", USAGE_1500_500), 0);
});

test("loadPriceTable parses comments, blocks and scalar entries from a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "latch-price-table-"));
  try {
    const filePath = join(dir, "price-table.yaml");
    writeFileSync(
      filePath,
      [
        "# rates are USD per 1k tokens",
        "block-model:", // split rates
        "  prompt: 0.003",
        "  completion: 0.015",
        "",
        "scalar-model: 0.25 # trailing comment",
        "",
      ].join("\n"),
    );
    const table = loadPriceTable(filePath);
    assert.equal(table.costUsd("block-model", USAGE_1500_500), 0.012);
    assert.equal(table.costUsd("scalar-model", { promptTokens: 4000, completionTokens: 0, totalTokens: 4000 }), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing price table file is an empty optional table ($0 everywhere)", () => {
  const table = loadPriceTable(join(tmpdir(), "latch-price-table-that-does-not-exist.yaml"));
  assert.deepEqual(table.priceFor("fusion"), { prompt: 0, completion: 0 });
  assert.equal(table.costUsd("fusion", USAGE_1500_500), 0);
});

test("malformed YAML fails with the offending file and line", () => {
  assert.throws(
    () => parsePriceTableYaml("fusion:\n  prompt: zero-dollars\n", "test-table.yaml"),
    (error: unknown) => {
      assert.ok(error instanceof PriceTableError);
      assert.match(error.message, /test-table\.yaml, line 2/);
      return true;
    },
  );
});

test("the default metering log keeps only the last 100 events", () => {
  const log = createMeteringLog(); // default capacity: DEFAULT_RING_CAPACITY = 100
  assert.equal(log.capacity, 100);
  for (let i = 1; i <= 150; i++) {
    log.emit(eventWithRequestId(`event-${i}`));
  }
  const recent = log.recent();
  assert.equal(recent.length, 100);
  assert.equal(recent[0]?.requestId, "event-51"); // 1..50 were evicted
  assert.equal(recent.at(-1)?.requestId, "event-150");
});

test("a bounded metering log keeps the newest events in order", () => {
  const log = createMeteringLog(3);
  for (let i = 1; i <= 5; i++) {
    log.emit(eventWithRequestId(`event-${i}`));
  }
  assert.deepEqual(log.recent().map((event) => event.requestId), ["event-3", "event-4", "event-5"]);
});

test("metering log capacity must be a positive integer", () => {
  assert.throws(() => createMeteringLog(0), RangeError);
  assert.throws(() => createMeteringLog(2.5), RangeError);
});

test("subscribers receive every emitted event until they unsubscribe", () => {
  const log = createMeteringLog();
  const seen: string[] = [];
  const unsubscribe = log.subscribe((event) => seen.push(event.requestId));
  log.emit(eventWithRequestId("a"));
  log.emit(eventWithRequestId("b"));
  unsubscribe();
  log.emit(eventWithRequestId("c"));
  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(log.recent().map((event) => event.requestId), ["a", "b", "c"]);
});

test("a throwing subscriber does not break emit or the other subscribers", () => {
  const log = createMeteringLog();
  const received: MeteringEvent[] = [];
  log.subscribe(() => {
    throw new Error("cost HUD crashed");
  });
  log.subscribe((event) => received.push(event));
  assert.doesNotThrow(() => log.emit(eventWithRequestId("survivor")));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.requestId, "survivor");
  assert.equal(log.recent().length, 1);
});

test("chatCompletion returns content, usage and metering, and feeds the sink", async () => {
  const mock = await startMockServer((_request, respond) => {
    respond(200, chatCompletionBody({ id: "chatcmpl-42" }));
  });
  try {
    const config: GatewayConfig = { baseUrl: mock.url, apiKey: "test-key" };
    const sink = recordingSink();
    const result = await chatCompletion(
      config,
      { model: "fusion", messages: [{ role: "user", content: "ping" }] },
      {
        sink,
        priceTable: createPriceTable({ "fusion": { prompt: "0.003", completion: "0.015" } }),
      },
    );

    assert.equal(result.content, "pong");
    assert.deepEqual(result.usage, USAGE_1500_500);
    assert.deepEqual(result.metering, {
      model: "fusion",
      promptTokens: 1500,
      completionTokens: 500,
      totalTokens: 2000,
      costUsd: 0.012,
      requestId: "chatcmpl-42",
      timestamp: result.metering.timestamp,
    });
    assert.equal(sink.events.length, 1);
    assert.equal(sink.events[0], result.metering); // same object, emitted once
  } finally {
    await mock.close();
  }
});

test("chatCompletion without injections uses the default log and shipped price table", async () => {
  const mock = await startMockServer((_request, respond) => {
    respond(200, chatCompletionBody({ id: "chatcmpl-default" }));
  });
  try {
    const received: MeteringEvent[] = [];
    const unsubscribe = defaultMeteringLog().subscribe((event) => received.push(event));
    try {
      const config: GatewayConfig = { baseUrl: mock.url, apiKey: "test-key" };
      const result = await chatCompletion(config, {
        model: "fusion",
        messages: [{ role: "user", content: "ping" }],
      });
      // Priced by product/identity/price-table.yaml: 1500*$0.003/1k + 500*$0.015/1k.
      assert.equal(result.metering.costUsd, 0.012);
      assert.equal(result.metering.requestId, "chatcmpl-default");
      assert.equal(received.length, 1);
      assert.equal(received[0], result.metering);
    } finally {
      unsubscribe();
    }
  } finally {
    await mock.close();
  }
});

test("chatCompletion with no usage in the response still emits a zero-cost event", async () => {
  const mock = await startMockServer((_request, respond) => {
    respond(200, chatCompletionBody({ id: "chatcmpl-nousage", usage: undefined, model: "auto" }));
  });
  try {
    const config: GatewayConfig = { baseUrl: mock.url, apiKey: "test-key" };
    const sink = recordingSink();
    const result = await chatCompletion(
      config,
      { model: "auto", messages: [{ role: "user", content: "ping" }] },
      { sink, priceTable: createPriceTable({ "auto": "9" }) }, // any rate: cost stays 0
    );
    assert.equal(result.usage, undefined);
    assert.deepEqual(result.metering, {
      model: "auto",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      requestId: "chatcmpl-nousage",
      timestamp: result.metering.timestamp,
    });
    assert.equal(sink.events.length, 1);
    assert.ok(!Number.isNaN(Date.parse(result.metering.timestamp)), "timestamp must be ISO-8601");
  } finally {
    await mock.close();
  }
});
