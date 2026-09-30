import assert from "node:assert/strict";
import test from "node:test";
import type { ICredentialService } from "../src/credential/credential.js";
import {
  DEFAULT_LATCH_ACCOUNT_API_BASE_URL,
  LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY,
  LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY,
  LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY,
} from "../src/latch-account/config.js";
import {
  latchLogout,
  latchSignIn,
  latchSignUp,
  listLatchKeys,
  mintLatchGatewayKey,
  revokeLatchKey,
  fetchLatchAccountStatus,
  fetchLatchLedger,
  type LatchAccountFetch,
} from "../src/latch-account/latchAccountService.js";
import {
  provisionLatchGatewayProvider,
  type LatchProviderSettingsSource,
} from "../src/latch-account/latchAccountProvisioning.js";
import {
  invalidateLatchAccountStatusSummary,
  latchAccountStatusSummary,
} from "../src/latch-account/latchAccountStatusSummary.js";
import {
  clearLatchAccountSession,
  createLatchAccountSessionStore,
  loadLatchAccountSession,
  saveLatchAccountSession,
} from "../src/latch-account/latchAccountSession.js";
import {
  LatchAccountError,
  isValidLatchEmail,
  isValidLatchPassword,
} from "../src/latch-account/latchAccountTypes.js";

const VALID_PASSWORD = "correct-horse-9";
const BASE_URL = DEFAULT_LATCH_ACCOUNT_API_BASE_URL;

/** Fake ICredentialService backed by a Map, exposing its contents for assertions. */
function fakeCredentialStore(): { store: ICredentialService; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    store: {
      async load(key: string) {
        return values.get(key) ?? null;
      },
      async save(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    },
    values,
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Mock fetch that records every request so tests can assert on URL/method/headers/body. */
function recordingFetch(
  handler: (request: RecordedRequest) => Response,
): LatchAccountFetch & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn = ((input: Parameters<LatchAccountFetch>[0], init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    requests.push(request);
    return Promise.resolve(handler(request));
  }) as LatchAccountFetch;
  return Object.assign(fetchFn, { requests });
}

/** Assert no persisted credential ever contains the password (hard rule). */
function assertPasswordNeverPersisted(values: Map<string, string>, password: string): void {
  assert.equal(
    [...values.entries()].some(([, value]) => value.includes(password)),
    false,
    "the password must never be persisted",
  );
}

test("latchSignUp posts trimmed credentials and returns the session", async () => {
  const fetchFn = recordingFetch(() =>
    jsonResponse(201, {
      token: "tok-signup",
      email: "user@example.com",
      harnessAccessUrl: "https://harness.example/auth/access/tok",
    }),
  );
  const result = await latchSignUp("  user@example.com  ", VALID_PASSWORD, { fetch: fetchFn });

  assert.deepEqual(result, {
    token: "tok-signup",
    email: "user@example.com",
    harnessAccessUrl: "https://harness.example/auth/access/tok",
  });
  assert.equal(fetchFn.requests.length, 1);
  const request = fetchFn.requests[0]!;
  assert.equal(request.url, `${BASE_URL}/signup`);
  assert.equal(request.method, "POST");
  assert.deepEqual(request.body, { email: "user@example.com", password: VALID_PASSWORD });
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers["authorization"], undefined, "signup must not send a token");
});

test("latchSignUp maps 409 to email_taken and keeps the server message", async () => {
  const fetchFn = recordingFetch(() =>
    jsonResponse(409, { error: { message: "An account with that email already exists" } }),
  );
  await assert.rejects(
    latchSignUp("user@example.com", VALID_PASSWORD, { fetch: fetchFn }),
    (error: unknown) => {
      assert.ok(error instanceof LatchAccountError);
      assert.equal(error.kind, "email_taken");
      assert.equal(error.status, 409);
      assert.equal(error.message, "An account with that email already exists");
      return true;
    },
  );
});

test("latchSignUp validates client-side before any network call", async () => {
  const fetchFn = recordingFetch(() => jsonResponse(201, { token: "t", email: "e" }));
  for (const [email, password] of [
    ["", VALID_PASSWORD],
    ["not-an-email", VALID_PASSWORD],
    ["user@example.com", "short"],
    ["user@example.com", ""],
  ] as [string, string][]) {
    await assert.rejects(latchSignUp(email, password, { fetch: fetchFn }), (error: unknown) => {
      assert.ok(error instanceof LatchAccountError);
      assert.equal(error.kind, "validation");
      return true;
    });
  }
  assert.equal(fetchFn.requests.length, 0, "validation failures must not hit the network");
  assert.equal(isValidLatchEmail("user@example.com"), true);
  assert.equal(isValidLatchEmail("user@no-tld"), false);
  assert.equal(isValidLatchPassword(VALID_PASSWORD), true);
  assert.equal(isValidLatchPassword("012345678"), false, "9 chars is below the server minimum");
});

test("latchSignIn maps 401 to invalid_credentials and network failure to network", async () => {
  const unauthorizedFetch = recordingFetch(() =>
    jsonResponse(401, { error: { message: "Invalid email or password" } }),
  );
  await assert.rejects(
    latchSignIn("user@example.com", VALID_PASSWORD, { fetch: unauthorizedFetch }),
    (error: unknown) => {
      assert.ok(error instanceof LatchAccountError);
      assert.equal(error.kind, "invalid_credentials");
      assert.equal(error.status, 401);
      return true;
    },
  );

  const failingFetch = (() => Promise.reject(new TypeError("fetch failed"))) as LatchAccountFetch;
  await assert.rejects(
    latchSignIn("user@example.com", VALID_PASSWORD, { fetch: failingFetch }),
    (error: unknown) => {
      assert.ok(error instanceof LatchAccountError);
      assert.equal(error.kind, "network");
      return true;
    },
  );

  // 服务端把 body 校验失败也归为 400，客户端归为 validation（而非 invalid_credentials）。
  const badRequestFetch = recordingFetch(() =>
    jsonResponse(400, { error: { message: "Email and password are required" } }),
  );
  await assert.rejects(
    latchSignIn("user@example.com", VALID_PASSWORD, { fetch: badRequestFetch }),
    (error: unknown) => {
      assert.ok(error instanceof LatchAccountError);
      assert.equal(error.kind, "validation");
      return true;
    },
  );
});

test("fetchLatchAccountStatus parses the /me payload and honors env overrides", async () => {
  const fetchFn = recordingFetch(() =>
    jsonResponse(200, {
      email: "user@example.com",
      balanceMicros: 4_200_000,
      billingEnabled: true,
      usdPerMillionTokens: 300,
      plan: { plan: "pro", since: "2026-09-01", renewsAtMs: 1_790_000_000_000 },
      treasury: { sui: "0xsui", evmChain: "base", evm: "0xevm" },
    }),
  );
  const status = await fetchLatchAccountStatus("tok-me", {
    fetch: fetchFn,
    env: { LATCH_ACCOUNT_API_URL: "http://127.0.0.1:9999/customer-api" },
  });

  assert.equal(fetchFn.requests[0]!.url, "http://127.0.0.1:9999/customer-api/me");
  assert.equal(fetchFn.requests[0]!.headers["authorization"], "Bearer tok-me");
  assert.deepEqual(status.plan, {
    plan: "pro",
    since: "2026-09-01",
    renewsAtMs: 1_790_000_000_000,
  });
  assert.equal(status.balanceMicros, 4_200_000);
  assert.equal(status.billingEnabled, true);
  assert.deepEqual(status.treasury, { sui: "0xsui", evmChain: "base", evm: "0xevm" });

  // 免费账号：plan 为 null 是真实答案，不能被归一化成 undefined/缺失。
  const freeFetch = recordingFetch(() =>
    jsonResponse(200, {
      email: "user@example.com",
      balanceMicros: 0,
      billingEnabled: true,
      usdPerMillionTokens: 300,
      plan: null,
      treasury: { sui: "", evmChain: "", evm: "" },
    }),
  );
  const freeStatus = await fetchLatchAccountStatus("tok-free", { fetch: freeFetch });
  assert.equal(freeStatus.plan, null);
});

test("fetchLatchLedger parses balance and usage entries", async () => {
  const fetchFn = recordingFetch(() =>
    jsonResponse(200, {
      balanceMicros: 1_500_000,
      entries: [
        {
          id: 12,
          kind: "debit",
          usdMicros: 900,
          reason: "inference",
          refId: 7,
          inputTokens: 1500,
          outputTokens: 500,
          createdAt: "2026-09-29T10:00:00Z",
        },
        {
          id: 11,
          kind: "credit",
          usdMicros: 5_000_000,
          reason: "top-up",
          refId: null,
          inputTokens: 0,
          outputTokens: 0,
          createdAt: "2026-09-28T10:00:00Z",
        },
      ],
    }),
  );
  const ledger = await fetchLatchLedger("tok-ledger", { fetch: fetchFn });

  assert.equal(fetchFn.requests[0]!.url, `${BASE_URL}/ledger`);
  assert.equal(ledger.balanceMicros, 1_500_000);
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.entries[0]!.kind, "debit");
  assert.equal(ledger.entries[0]!.inputTokens, 1500);
  assert.equal(ledger.entries[0]!.outputTokens, 500);
  assert.equal(ledger.entries[0]!.usdMicros, 900);
  assert.equal(ledger.entries[1]!.refId, null);
});

test("mintLatchGatewayKey posts the name and persists the key id", async () => {
  const { store, values } = fakeCredentialStore();
  const fetchFn = recordingFetch(() =>
    jsonResponse(201, { id: 42, name: "latch desktop", key: "sk-cp-full-key" }),
  );
  const minted = await mintLatchGatewayKey("tok-mint", " latch desktop ", {
    fetch: fetchFn,
    credentialService: store,
  });

  assert.deepEqual(minted, { id: 42, name: "latch desktop", key: "sk-cp-full-key" });
  const request = fetchFn.requests[0]!;
  assert.equal(request.url, `${BASE_URL}/keys`);
  assert.equal(request.method, "POST");
  assert.deepEqual(request.body, { name: "latch desktop" });
  assert.equal(request.headers["authorization"], "Bearer tok-mint");
  assert.equal(values.get(LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY), "42");
  assert.equal(values.get(LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY)?.includes("sk-cp-full"), false);
});

test("listLatchKeys returns masked summaries and revokeLatchKey deletes by id", async () => {
  const fetchFn = recordingFetch((request) => {
    if (request.url === `${BASE_URL}/keys` && request.method === "GET") {
      return jsonResponse(200, [
        {
          id: 42,
          name: "latch desktop",
          maskedKey: "sk-cp-***key",
          enabled: true,
          createdAt: "2026-09-29T10:00:00Z",
        },
      ]);
    }
    return jsonResponse(200, { success: true });
  });
  const keys = await listLatchKeys("tok-keys", { fetch: fetchFn });
  assert.equal(keys.length, 1);
  assert.equal(keys[0]!.maskedKey, "sk-cp-***key");
  assert.equal(keys[0]!.enabled, true);

  await revokeLatchKey("tok-keys", 42, { fetch: fetchFn });
  const revoke = fetchFn.requests[1]!;
  assert.equal(revoke.url, `${BASE_URL}/keys/42`);
  assert.equal(revoke.method, "DELETE");

  const noopFetch = recordingFetch(() => jsonResponse(200, {}));
  await assert.rejects(
    revokeLatchKey("tok-keys", "not-a-number", { fetch: noopFetch }),
    (error: unknown) => {
      assert.ok(error instanceof LatchAccountError);
      assert.equal(error.kind, "validation");
      return true;
    },
  );
  assert.equal(noopFetch.requests.length, 0);
});

test("session persistence round-trips token and email and clear removes every key", async () => {
  const { store, values } = fakeCredentialStore();
  await saveLatchAccountSession(
    { token: "tok-session", email: " user@example.com " },
    {
      credentialService: store,
    },
  );
  assert.equal(values.get(LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY), "tok-session");
  assert.equal(values.get(LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY), "user@example.com");

  const session = await loadLatchAccountSession({ credentialService: store });
  assert.deepEqual(session, { token: "tok-session", email: "user@example.com" });

  await createLatchAccountSessionStore(store).saveGatewayKeyId("42");
  await clearLatchAccountSession({ credentialService: store });
  assert.equal(await loadLatchAccountSession({ credentialService: store }), null);
  assert.equal(values.size, 0, "clear must also drop the stored gateway key id");
  assertPasswordNeverPersisted(values, VALID_PASSWORD);
});

test("latchLogout clears the local session even when the gateway call fails", async () => {
  const { store, values } = fakeCredentialStore();
  await createLatchAccountSessionStore(store).saveLatchAccountSession({
    token: "tok-out",
    email: "user@example.com",
  });
  await createLatchAccountSessionStore(store).saveGatewayKeyId("42");

  const successFetch = recordingFetch(() => jsonResponse(200, { success: true }));
  await latchLogout("tok-out", { fetch: successFetch, credentialService: store });
  assert.equal(successFetch.requests[0]!.url, `${BASE_URL}/logout`);
  assert.equal(successFetch.requests[0]!.method, "POST");
  assert.equal(await loadLatchAccountSession({ credentialService: store }), null);

  await createLatchAccountSessionStore(store).saveLatchAccountSession({
    token: "tok-out-2",
    email: "user@example.com",
  });
  const failingFetch = (() => Promise.reject(new TypeError("fetch failed"))) as LatchAccountFetch;
  await latchLogout("tok-out-2", { fetch: failingFetch, credentialService: store });
  assert.equal(await loadLatchAccountSession({ credentialService: store }), null);
  assert.equal(values.get(LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY), undefined);
});

test("provisionLatchGatewayProvider wires the key exactly like LoginApiKeyForm", async () => {
  const gatewayTemplate = {
    templateId: "xlaunch-gateway",
    templateNameMap: { "en-US": "Xlaunch Gateway" },
    config: { access: { type: "api-key", apiKeyManagementUrl: "https://gateway.xlaunch.work" } },
  };
  let created: unknown;
  const providerSettings = {
    getView: async () => ({
      revision: 1,
      providerTemplates: [gatewayTemplate],
      providerOrder: [],
      providers: [],
    }),
    createPersonalProvider: async (input: unknown) => {
      created = input;
      return { providerId: "personal-xlaunch-gateway", view: null };
    },
  } as unknown as LatchProviderSettingsSource;

  const result = await provisionLatchGatewayProvider(" sk-cp-full-key ", providerSettings);
  assert.equal(result.providerId, "personal-xlaunch-gateway");
  assert.deepEqual(created, {
    templateId: "xlaunch-gateway",
    initialConfig: { access: { type: "api-key", apiKey: "sk-cp-full-key" } },
  });

  const missingTemplate = {
    getView: async () => ({ revision: 1, providerTemplates: [], providerOrder: [], providers: [] }),
    createPersonalProvider: async () => {
      throw new Error("must not be called");
    },
  } as unknown as LatchProviderSettingsSource;
  await assert.rejects(
    provisionLatchGatewayProvider("sk-cp-full-key", missingTemplate),
    (error: unknown) => {
      assert.ok(error instanceof LatchAccountError);
      assert.equal(error.kind, "unknown");
      return true;
    },
  );
});

test("latchAccountStatusSummary combines session, /me and stored key state", async () => {
  invalidateLatchAccountStatusSummary();
  const { store, values } = fakeCredentialStore();
  const sessionStore = createLatchAccountSessionStore(store);
  await sessionStore.saveLatchAccountSession({ token: "tok-summary", email: "user@example.com" });
  await sessionStore.saveGatewayKeyId("42");

  const fetchFn = recordingFetch(() =>
    jsonResponse(200, {
      email: "user@example.com",
      balanceMicros: 4_200_000,
      billingEnabled: true,
      usdPerMillionTokens: 300,
      plan: { plan: "team", since: "2026-09-01", renewsAtMs: null },
      treasury: { sui: "", evmChain: "", evm: "" },
    }),
  );
  const summary = await latchAccountStatusSummary({ fetch: fetchFn, credentialService: store });

  assert.deepEqual(summary, {
    signedIn: true,
    email: "user@example.com",
    plan: "team",
    balanceMicros: 4_200_000,
    billingEnabled: true,
    hasGatewayKey: true,
  });
  assert.equal(fetchFn.requests.length, 1);

  // 短 TTL 缓存：同一 token 的第二次读取不再打网络。
  const cached = await latchAccountStatusSummary({ fetch: fetchFn, credentialService: store });
  assert.equal(cached.plan, "team");
  assert.equal(fetchFn.requests.length, 1);

  // force 绕过缓存；in-flight 合并：并发调用只打一次网络。
  invalidateLatchAccountStatusSummary("tok-summary");
  const [forced, inflightA, inflightB] = await Promise.all([
    latchAccountStatusSummary({ fetch: fetchFn, credentialService: store, force: true }),
    latchAccountStatusSummary({ fetch: fetchFn, credentialService: store }),
    latchAccountStatusSummary({ fetch: fetchFn, credentialService: store }),
  ]);
  assert.equal(forced.signedIn, true);
  assert.equal(inflightA.email, "user@example.com");
  assert.equal(inflightB.email, "user@example.com");
  // 1 次首次读取 + force/in-flight 合并后只补 1 次：并发读取不能放大成多个 /me。
  assert.equal(fetchFn.requests.length, 2);
  assertPasswordNeverPersisted(values, VALID_PASSWORD);
});

test("latchAccountStatusSummary falls back to stale cache and reports signed-out cleanly", async () => {
  invalidateLatchAccountStatusSummary();
  const { store } = fakeCredentialStore();
  const sessionStore = createLatchAccountSessionStore(store);
  await sessionStore.saveLatchAccountSession({ token: "tok-stale", email: "user@example.com" });

  let fail = false;
  const fetchFn = recordingFetch(() => {
    if (fail) {
      return jsonResponse(500, { error: { message: "gateway down" } });
    }
    return jsonResponse(200, {
      email: "user@example.com",
      balanceMicros: 10,
      billingEnabled: true,
      usdPerMillionTokens: 300,
      plan: null,
      treasury: { sui: "", evmChain: "", evm: "" },
    });
  });

  const first = await latchAccountStatusSummary({ fetch: fetchFn, credentialService: store });
  assert.equal(first.signedIn, true);
  assert.equal(first.plan, undefined, "free plan (null) surfaces as no plan");

  fail = true;
  // 缓存已过期（maxAgeMs: 0）但刷新失败时，轮询应降级返回旧值而不是把 UI 打回未登录。
  const stale = await latchAccountStatusSummary({
    fetch: fetchFn,
    credentialService: store,
    maxAgeMs: 0,
  });
  assert.equal(stale.signedIn, true);
  assert.equal(stale.balanceMicros, 10);

  // 无缓存的 401 必须抛 unauthorized，且不得悄悄清掉本地 session。
  invalidateLatchAccountStatusSummary();
  const unauthorizedFetch = recordingFetch(() =>
    jsonResponse(401, { error: { message: "Sign in required", type: "authentication_error" } }),
  );
  await assert.rejects(
    latchAccountStatusSummary({ fetch: unauthorizedFetch, credentialService: store }),
    (error: unknown) => {
      assert.ok(error instanceof LatchAccountError);
      assert.equal(error.kind, "unauthorized");
      return true;
    },
  );
  assert.deepEqual(await loadLatchAccountSession({ credentialService: store }), {
    token: "tok-stale",
    email: "user@example.com",
  });

  // 未登录：不打网络，直接返回未登录摘要。
  const signedOutFetch = recordingFetch(() => jsonResponse(200, {}));
  const signedOut = await latchAccountStatusSummary({
    fetch: signedOutFetch,
    credentialService: fakeCredentialStore().store,
    session: null,
  });
  assert.deepEqual(signedOut, { signedIn: false, hasGatewayKey: false });
  assert.equal(signedOutFetch.requests.length, 0);
});
