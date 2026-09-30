import assert from "node:assert/strict";
import test from "node:test";
import {
  chatCompletion,
  GatewayAuthError,
  GatewayHttpError,
  listModels,
  planGate,
  readConfig,
  type ChatCompletionRequest,
  type GatewayConfig,
} from "../src/index.js";
import { startMockServer } from "./mock-gateway.js";

test("readConfig defaults the base URL and reads LATCH_API_KEY from the environment", () => {
  const defaults = readConfig({});
  assert.equal(defaults.baseUrl, "https://gateway.xlaunch.work");
  assert.equal(defaults.apiKey, undefined);

  const configured = readConfig({
    LATCH_GATEWAY_URL: "http://127.0.0.1:8443/",
    LATCH_API_KEY: "latch-key-123",
  });
  assert.equal(configured.baseUrl, "http://127.0.0.1:8443");
  assert.equal(configured.apiKey, "latch-key-123");
});

test("listModels fetches the catalog from /v1/models with the bearer header", async () => {
  const mock = await startMockServer((_request, respond) => {
    respond(200, {
      object: "list",
      data: [{ id: "fusion", owned_by: "latch" }, { id: "auto" }],
    });
  });
  try {
    const config: GatewayConfig = { baseUrl: mock.url, apiKey: "test-key" };
    const catalog = await listModels(config);
    assert.equal(catalog.object, "list");
    assert.deepEqual(
      catalog.data.map((model) => model.id),
      ["fusion", "auto"],
    );

    const [request] = mock.requests;
    assert.ok(request, "mock gateway received no request");
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer test-key");
  } finally {
    await mock.close();
  }
});

test("chatCompletion posts the authorized JSON shape to /v1/chat/completions", async () => {
  const mock = await startMockServer((request, respond) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      respond(200, {
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "fusion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "pong" },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }
    respond(404, { error: { message: "unexpected route" } });
  });
  try {
    const config: GatewayConfig = { baseUrl: mock.url, apiKey: "test-key" };
    const request: ChatCompletionRequest = {
      model: "fusion",
      messages: [{ role: "user", content: "ping" }],
    };
    const completion = await chatCompletion(config, request);
    assert.equal(completion.content, "pong");
    // No usage object in this response: usage is undefined, metering zeros.
    assert.equal(completion.usage, undefined);
    assert.equal(completion.metering.totalTokens, 0);
    assert.equal(completion.metering.costUsd, 0);

    const [captured] = mock.requests;
    assert.ok(captured, "mock gateway received no request");
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "/v1/chat/completions");
    assert.equal(captured.headers.authorization, "Bearer test-key");
    assert.equal(captured.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(captured.rawBody), {
      model: "fusion",
      messages: [{ role: "user", content: "ping" }],
    });
  } finally {
    await mock.close();
  }
});

test("a 401 from the gateway maps to GatewayAuthError", async () => {
  const mock = await startMockServer((_request, respond) => {
    respond(401, { error: { message: "invalid api key" } });
  });
  try {
    const config: GatewayConfig = { baseUrl: mock.url, apiKey: "wrong-key" };
    await assert.rejects(listModels(config), (error: unknown) => {
      assert.ok(error instanceof GatewayAuthError);
      assert.equal(error.status, 401);
      assert.match(error.message, /invalid api key/);
      return true;
    });
    const request: ChatCompletionRequest = {
      model: "fusion",
      messages: [{ role: "user", content: "ping" }],
    };
    await assert.rejects(chatCompletion(config, request), (error: unknown) => {
      assert.ok(error instanceof GatewayAuthError);
      assert.equal(error.status, 401);
      return true;
    });
  } finally {
    await mock.close();
  }
});

test("a non-401 gateway failure maps to GatewayHttpError with status and body", async () => {
  const mock = await startMockServer((_request, respond) => {
    respond(503, { error: { message: "gateway overloaded" } });
  });
  try {
    const config: GatewayConfig = { baseUrl: mock.url, apiKey: "test-key" };
    await assert.rejects(listModels(config), (error: unknown) => {
      assert.ok(error instanceof GatewayHttpError);
      assert.ok(!(error instanceof GatewayAuthError));
      assert.equal(error.status, 503);
      assert.match(error.message, /gateway overloaded/);
      return true;
    });
  } finally {
    await mock.close();
  }
});

test("planGate is a stub that allows every model and reports plan unknown", () => {
  assert.deepEqual(planGate("fusion"), { allowed: true, plan: "unknown" });
  assert.deepEqual(planGate("any-other-model"), { allowed: true, plan: "unknown" });
});
