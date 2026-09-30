// Latch 账号同源代理：浏览器无法直连 gateway customer-api（跨域被网关 CORS 白名单
// 拒绝），Web 客户端的所有账号请求都打到 /api/latch-account/*，由这里逐端点转发。
// 上游地址与 services 侧 latch-account 模块共用同一份 env 解析（LATCH_ACCOUNT_API_URL，
// 缺省 https://gateway.xlaunch.work/customer-api），契约以只读参考
// xlaunch-gateway/server/src/routes/customer.ts 为准。
//
// 本模块只做转发：不解析、不改写、也不记录任何请求/响应体 —— signup/login 的请求体带
// 密码，/keys 的响应带只出现一次的完整 key，任何一行日志都可能把敏感值带出去。
import type { Context, Hono } from "hono";
import {
  LATCH_MIN_PASSWORD_LENGTH,
  buildLatchAccountApiUrl,
  isValidLatchEmail,
  isValidLatchPassword,
  readLatchAccountEnv,
  type RuntimeLatchAccountEnv,
} from "@zcode/services";

// 上游 15s 超时：账号面都是轻查询/轻写入，超时按网关不可达处理（504）。
const LATCH_ACCOUNT_PROXY_TIMEOUT_MS = 15_000;

// server 目前没有共享的限流中间件约定（http.ts 只有 token 鉴权与静态资源逻辑），
// 这里对携带密码的两个端点做进程内固定窗口限流，避免脚本借同源代理反复打线上
// signup/login。keyed by 连接对端地址；多实例部署时各实例独立计数。
const LATCH_AUTH_RATE_LIMIT = 20;
const LATCH_AUTH_RATE_WINDOW_MS = 60_000;
const rateLimitBuckets = new Map<string, { windowStartMs: number; count: number }>();

// 网关错误契约：{ error: { message, type?, code? } }。代理自身的 4xx/5xx 也用同一
// 形状，Web 端 latchAccountService 的错误分类（读 error.message）才能统一工作。
interface CustomerApiErrorBody {
  error: { message: string };
}

// hono 的 c.json 需要字面量状态码联合；网关实际只会回这些状态，未知的按 502 兜底。
type CustomerApiStatus =
  | 200
  | 201
  | 400
  | 401
  | 403
  | 404
  | 409
  | 410
  | 422
  | 429
  | 500
  | 502
  | 503
  | 504;

const CUSTOMER_API_KNOWN_STATUSES: readonly CustomerApiStatus[] = [
  200, 201, 400, 401, 403, 404, 409, 410, 422, 429, 500, 502, 503, 504,
];

function toCustomerApiStatus(status: number): CustomerApiStatus {
  return CUSTOMER_API_KNOWN_STATUSES.includes(status as CustomerApiStatus)
    ? (status as CustomerApiStatus)
    : 502;
}

function customerApiError(c: Context, status: CustomerApiStatus, message: string): Response {
  return c.json({ error: { message } } satisfies CustomerApiErrorBody, status);
}

interface CustomerApiForwardInput {
  env: RuntimeLatchAccountEnv;
  path: string;
  method: "GET" | "POST";
  token?: string;
  body?: unknown;
}

interface CustomerApiForwardResult {
  status: CustomerApiStatus;
  payload: unknown;
  retryAfterSeconds?: number;
}

/**
 * 请求体 / 响应体只在这一条通路上出现，且不落入任何日志。
 *
 * @param input - 目标端点、转发用 token 与可选 JSON 请求体。
 * @returns 网关状态码 + 原样 JSON 载荷（错误形状 {error:{message}} 原样透传）。
 */
async function forwardToCustomerApi(
  input: CustomerApiForwardInput,
): Promise<CustomerApiForwardResult> {
  let response: Response;
  try {
    response = await fetch(buildLatchAccountApiUrl(input.env, input.path), {
      method: input.method,
      headers: {
        Accept: "application/json",
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(LATCH_ACCOUNT_PROXY_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut) {
      return { status: 504, payload: { error: { message: "Latch account API timed out" } } };
    }
    return { status: 502, payload: { error: { message: "Latch account API is unreachable" } } };
  }

  const raw = await response.text();
  let payload: unknown;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      return {
        status: 502,
        payload: { error: { message: "Unexpected non-JSON response from the Latch account API" } },
      };
    }
  } else {
    payload = {};
  }

  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds =
    response.status === 429 && retryAfterHeader && /^\d+$/.test(retryAfterHeader)
      ? Number(retryAfterHeader)
      : undefined;
  return {
    status: toCustomerApiStatus(response.status),
    payload,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

function respondWithForwarded(c: Context, result: CustomerApiForwardResult): Response {
  return c.json(result.payload, result.status, {
    "cache-control": "no-store",
    ...(result.retryAfterSeconds === undefined
      ? {}
      : { "retry-after": String(result.retryAfterSeconds) }),
  });
}

/** 与网关 requireCustomer 同款取 token 口径：Authorization: Bearer（大小写不敏感）。 */
function readBearerToken(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header) {
    return null;
  }
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token ? token : null;
}

function requireBearerToken(c: Context): string | Response {
  const token = readBearerToken(c);
  if (!token) {
    return customerApiError(c, 401, "Sign in required");
  }
  return token;
}

async function readJsonObjectBody(c: Context): Promise<Record<string, unknown> | Response> {
  const raw = await c.req.json().catch(() => undefined);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return customerApiError(c, 400, "A JSON request body is required");
  }
  return raw as Record<string, unknown>;
}

// 校验复用 services 侧的 isValidLatchEmail / isValidLatchPassword：与服务模块、
// gateway zod schema（email trim max 200；password 10..200）保持同一口径，密码不满足
// 时在代理层直接 400，不把注定失败的请求体送上网络。
function validateCredentials(
  body: Record<string, unknown>,
): { email: string; password: string } | { error: string } {
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!isValidLatchEmail(email)) {
    return { error: "A valid email address is required" };
  }
  if (!isValidLatchPassword(password)) {
    return {
      error: `A password of at least ${String(LATCH_MIN_PASSWORD_LENGTH)} characters is required`,
    };
  }
  return { email, password };
}

function resolveClientKey(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

/** 固定窗口限流；超限回 429 + Retry-After（与网关 429 语义一致，不透传上游）。 */
function consumeAuthRateLimit(key: string): number | null {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStartMs >= LATCH_AUTH_RATE_WINDOW_MS) {
    rateLimitBuckets.set(key, { windowStartMs: now, count: 1 });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > LATCH_AUTH_RATE_LIMIT) {
    return Math.max(1, Math.ceil((bucket.windowStartMs + LATCH_AUTH_RATE_WINDOW_MS - now) / 1000));
  }
  return null;
}

// 桶数量与连接 IP 同量级；窗口滚动时顺手清理过期项，避免长期运行泄漏。
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStartMs >= LATCH_AUTH_RATE_WINDOW_MS) {
      rateLimitBuckets.delete(key);
    }
  }
}, LATCH_AUTH_RATE_WINDOW_MS).unref();

/**
 * 注册 /api/latch-account/* 代理路由。
 *
 * @param app - http.ts 里创建的 Hono 实例；必须先于静态资源 catch-all 注册。
 */
export function registerLatchAccountProxyRoutes(app: Hono): void {
  const env = readLatchAccountEnv();

  const handleAuthEndpoint = (path: "/signup" | "/login") => async (c: Context) => {
    const retryAfterSeconds = consumeAuthRateLimit(resolveClientKey(c));
    if (retryAfterSeconds !== null) {
      return c.json(
        {
          error: { message: "Too many Latch account attempts; try again later" },
        } satisfies CustomerApiErrorBody,
        429,
        { "cache-control": "no-store", "retry-after": String(retryAfterSeconds) },
      );
    }
    const body = await readJsonObjectBody(c);
    if (body instanceof Response) {
      return body;
    }
    const credentials = validateCredentials(body);
    if ("error" in credentials) {
      return customerApiError(c, 400, credentials.error);
    }
    return respondWithForwarded(
      c,
      await forwardToCustomerApi({ env, path, method: "POST", body: credentials }),
    );
  };

  app.post("/api/latch-account/signup", handleAuthEndpoint("/signup"));
  app.post("/api/latch-account/login", handleAuthEndpoint("/login"));

  app.get("/api/latch-account/me", async (c) => {
    const token = requireBearerToken(c);
    if (token instanceof Response) {
      return token;
    }
    return respondWithForwarded(
      c,
      await forwardToCustomerApi({ env, path: "/me", method: "GET", token }),
    );
  });

  app.get("/api/latch-account/ledger", async (c) => {
    const token = requireBearerToken(c);
    if (token instanceof Response) {
      return token;
    }
    return respondWithForwarded(
      c,
      await forwardToCustomerApi({ env, path: "/ledger", method: "GET", token }),
    );
  });

  app.post("/api/latch-account/keys", async (c) => {
    const token = requireBearerToken(c);
    if (token instanceof Response) {
      return token;
    }
    const body = await readJsonObjectBody(c);
    if (body instanceof Response) {
      return body;
    }
    // 与网关 keySchema（name trim 1..100）同口径。
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) {
      return customerApiError(c, 400, "A key name of 1-100 characters is required");
    }
    return respondWithForwarded(
      c,
      await forwardToCustomerApi({ env, path: "/keys", method: "POST", token, body: { name } }),
    );
  });

  app.post("/api/latch-account/logout", async (c) => {
    const token = requireBearerToken(c);
    if (token instanceof Response) {
      return token;
    }
    return respondWithForwarded(
      c,
      await forwardToCustomerApi({ env, path: "/logout", method: "POST", token, body: {} }),
    );
  });
}
