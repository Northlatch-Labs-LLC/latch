// Latch 账号服务的 HTTP 客户端面：customer-api 的请求核心、登录、/me、/ledger、
// 推理 Key 管理与登出。内嵌 gateway provider 接线与状态摘要拆在同目录的
// latchAccountProvisioning.ts / latchAccountStatusSummary.ts（oxlint max-lines 400）。
// 只做客户端；契约以只读参考 xlaunch-gateway server/src/routes/customer.ts 为准。
import {
  LATCH_MIN_PASSWORD_LENGTH,
  buildLatchAccountApiUrl,
  type RuntimeLatchAccountEnv,
} from "./config.js";
import {
  clearLatchAccountSession,
  createLatchAccountSessionStore,
  resolveLatchAccountCredentialService,
  type LatchAccountStoreOptions,
} from "./latchAccountSession.js";
import {
  LatchAccountError,
  isValidLatchEmail,
  isValidLatchPassword,
  type LatchAccountAuthResult,
  type LatchAccountErrorKind,
  type LatchAccountStatus,
  type LatchGatewayKeyMinted,
  type LatchGatewayKeySummary,
  type LatchLedger,
} from "./latchAccountTypes.js";

export type LatchAccountFetch = typeof fetch;

// 与 useUsageEntitlement 的刷新超时对齐；账号接口是轻查询，20s 足够宽容。
const LATCH_ACCOUNT_DEFAULT_TIMEOUT_MS = 20_000;

export interface LatchAccountRequestOptions {
  fetch?: LatchAccountFetch;
  env?: RuntimeLatchAccountEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

type LatchAccountMethod = "GET" | "POST" | "DELETE";

interface LatchAccountRequestInput {
  path: string;
  method: LatchAccountMethod;
  token?: string;
  body?: unknown;
  /** 登录接口的 401 语义是密码错，而不是会话失效。 */
  unauthorizedKind?: LatchAccountErrorKind;
}

interface LatchAccountErrorPayload {
  error?: { message?: unknown; type?: unknown; code?: unknown };
}

function errorPayloadField(payload: unknown, field: "message" | "code"): string | undefined {
  const error = (payload as LatchAccountErrorPayload | null | undefined)?.error;
  const value = error?.[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function toLatchAccountNetworkError(error: unknown): LatchAccountError {
  if (error instanceof LatchAccountError) {
    return error;
  }
  const timedOut = error instanceof Error && error.name === "AbortError";
  return new LatchAccountError(
    "network",
    timedOut ? "Latch account API request timed out" : "Latch account API is unreachable",
    { cause: error },
  );
}

function mapLatchAccountHttpError(
  status: number,
  payload: unknown,
  retryAfterMs: number | undefined,
  unauthorizedKind: LatchAccountErrorKind | undefined,
): LatchAccountError {
  const serverMessage = errorPayloadField(payload, "message");
  const serverCode = errorPayloadField(payload, "code");
  const details = {
    status,
    ...(serverCode ? { serverCode } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
  if (status === 400) {
    return new LatchAccountError(
      "validation",
      serverMessage ?? "Latch account request was rejected",
      details,
    );
  }
  if (status === 401) {
    return new LatchAccountError(
      unauthorizedKind ?? "unauthorized",
      serverMessage ?? "Sign in required",
      details,
    );
  }
  if (status === 409) {
    return new LatchAccountError(
      "email_taken",
      serverMessage ?? "An account with that email already exists",
      details,
    );
  }
  // 推理侧配额契约（routes/proxy.ts）：402 余额耗尽、429 并发/档案上限。
  if (status === 402 || serverCode === "account_balance_exhausted") {
    return new LatchAccountError(
      "insufficient_balance",
      serverMessage ?? "Account balance is exhausted",
      details,
    );
  }
  if (status === 429 || serverCode === "client_profile_cap_reached") {
    return new LatchAccountError("rate_limited", serverMessage ?? "Too many requests", details);
  }
  if (status >= 500) {
    return new LatchAccountError(
      "server",
      serverMessage ?? "Latch account API is unavailable",
      details,
    );
  }
  return new LatchAccountError(
    "unknown",
    serverMessage ?? `Latch account API request failed (${String(status)})`,
    details,
  );
}

function parseLatchAccountJsonBody(raw: string, status: number): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new LatchAccountError(
      "unknown",
      "Unexpected non-JSON response from the Latch account API",
      { status },
    );
  }
}

async function latchAccountRequest<T>(
  input: LatchAccountRequestInput,
  options: LatchAccountRequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? LATCH_ACCOUNT_DEFAULT_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      buildLatchAccountApiUrl(options.env ?? {}, input.path),
      {
        method: input.method,
        headers: {
          Accept: "application/json",
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal,
      },
    ).catch((error: unknown) => {
      throw toLatchAccountNetworkError(error);
    });
    const payload = parseLatchAccountJsonBody(await response.text(), response.status);
    if (!response.ok) {
      throw mapLatchAccountHttpError(
        response.status,
        payload,
        parseRetryAfterMs(response.headers.get("retry-after")),
        input.unauthorizedKind,
      );
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

function requireLatchToken(token: string): void {
  if (!token.trim()) {
    throw new LatchAccountError("validation", "A Latch account session token is required");
  }
}

function assertLatchCredentials(email: string, password: string): void {
  if (!isValidLatchEmail(email)) {
    throw new LatchAccountError("validation", "A valid email address is required");
  }
  if (!isValidLatchPassword(password)) {
    throw new LatchAccountError(
      "validation",
      `A password of at least ${String(LATCH_MIN_PASSWORD_LENGTH)} characters is required`,
    );
  }
}

/** POST /signup：201 返回登录态；409 归类为 email_taken；密码只出现在请求体里。 */
export async function latchSignUp(
  email: string,
  password: string,
  options: LatchAccountRequestOptions = {},
): Promise<LatchAccountAuthResult> {
  assertLatchCredentials(email, password);
  return latchAccountRequest<LatchAccountAuthResult>(
    { path: "/signup", method: "POST", body: { email: email.trim(), password } },
    options,
  );
}

/** POST /login：401 归类为 invalid_credentials（其余端点的 401 归类为 unauthorized）。 */
export async function latchSignIn(
  email: string,
  password: string,
  options: LatchAccountRequestOptions = {},
): Promise<LatchAccountAuthResult> {
  assertLatchCredentials(email, password);
  return latchAccountRequest<LatchAccountAuthResult>(
    {
      path: "/login",
      method: "POST",
      body: { email: email.trim(), password },
      unauthorizedKind: "invalid_credentials",
    },
    options,
  );
}

/** GET /me：账号、余额、套餐与 treasury 的权威快照。 */
export async function fetchLatchAccountStatus(
  token: string,
  options: LatchAccountRequestOptions = {},
): Promise<LatchAccountStatus> {
  requireLatchToken(token);
  return latchAccountRequest<LatchAccountStatus>({ path: "/me", method: "GET", token }, options);
}

/** GET /ledger：用量对账单（服务端最多返回 200 条）。 */
export async function fetchLatchLedger(
  token: string,
  options: LatchAccountRequestOptions = {},
): Promise<LatchLedger> {
  requireLatchToken(token);
  return latchAccountRequest<LatchLedger>({ path: "/ledger", method: "GET", token }, options);
}

function assertLatchKeyName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new LatchAccountError("validation", "A key name of 1-100 characters is required");
  }
}

/** POST /keys：完整 key 只在这次响应里出现；成功后把 key id 镜像进凭据存储。 */
export async function mintLatchGatewayKey(
  token: string,
  name: string,
  options: LatchAccountRequestOptions & LatchAccountStoreOptions = {},
): Promise<LatchGatewayKeyMinted> {
  requireLatchToken(token);
  assertLatchKeyName(name);
  const minted = await latchAccountRequest<LatchGatewayKeyMinted>(
    { path: "/keys", method: "POST", token, body: { name: name.trim() } },
    options,
  );
  try {
    await createLatchAccountSessionStore(
      resolveLatchAccountCredentialService(options),
    ).saveGatewayKeyId(String(minted.id));
  } catch (error) {
    logLatchAccountWarning("save gateway key id failed", error);
  }
  return minted;
}

/** GET /keys：只有 maskedKey，完整 key 不可再生。 */
export async function listLatchKeys(
  token: string,
  options: LatchAccountRequestOptions = {},
): Promise<LatchGatewayKeySummary[]> {
  requireLatchToken(token);
  return latchAccountRequest<LatchGatewayKeySummary[]>(
    { path: "/keys", method: "GET", token },
    options,
  );
}

/** DELETE /keys/:id：吊销后该 key 立即不可用于推理。 */
export async function revokeLatchKey(
  token: string,
  keyId: string | number,
  options: LatchAccountRequestOptions = {},
): Promise<void> {
  requireLatchToken(token);
  const id = String(keyId).trim();
  if (!/^\d+$/.test(id)) {
    throw new LatchAccountError("validation", "A numeric key id is required");
  }
  await latchAccountRequest<unknown>({ path: `/keys/${id}`, method: "DELETE", token }, options);
}

/**
 * POST /logout + 清本地登录态。服务端 logout 只是销毁会话记录；
 * 网络/服务端失败不能把用户困在已不可用的登录态里，本地 session 总是清除。
 */
export async function latchLogout(
  token: string,
  options: LatchAccountRequestOptions & LatchAccountStoreOptions = {},
): Promise<void> {
  requireLatchToken(token);
  try {
    await latchAccountRequest<unknown>({ path: "/logout", method: "POST", token }, options);
  } catch (error) {
    logLatchAccountWarning("gateway logout failed; clearing local session anyway", error);
  }
  await clearLatchAccountSession(options);
}

/**
 * browser-safe 日志兜底：root index 会被 renderer 引入，不能走依赖 process 的
 * serviceLogger；同目录其他模块（provisioning/summary）也复用这一条出口。
 */
export function logLatchAccountWarning(message: string, error: unknown): void {
  console.warn(`[latchAccountService] ${message}`, error);
}
