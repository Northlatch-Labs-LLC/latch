// Shared fixtures for the latchBilling route tests. Not a test file itself.
import { Hono } from "hono";
import { registerLatchBillingRoutes } from "../src/latchBilling.js";

export const STRIPE_SECRET_KEY = "sk_test_unit_mock";
export const SERVICE_TOKEN = "svc_test_unit_mock";
export const SESSION_TOKEN = "latch_session_token_mock";
export const CUSTOMER_EMAIL = "buyer@northlatch.dev";

export interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
  authorization: string | undefined;
}

export type MockHandler = (call: FetchCall) => Response | Promise<Response>;

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Replace global fetch with a mock; captured calls are returned; restore runs via t.after. */
export function mockFetchFor(t: { after(fn: () => void): void }, handler: MockHandler): FetchCall[] {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: FetchCall = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: headers.Authorization ?? headers.authorization,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

const ENV_KEYS = [
  "LATCH_STRIPE_SECRET_KEY",
  "LATCH_GATEWAY_SERVICE_TOKEN",
  "LATCH_ACCOUNT_API_URL",
  "LATCH_GATEWAY_SERVICE_API_URL",
];

export function setBillingEnv(
  t: { after(fn: () => void): void },
  overrides: Record<string, string | undefined>,
): void {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

export function newBillingApp(): Hono {
  const app = new Hono();
  registerLatchBillingRoutes(app);
  return app;
}

export function bearerHeaders(token: string = SESSION_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
