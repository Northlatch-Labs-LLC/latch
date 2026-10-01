// /pricing 页的 Latch 计费客户端：同源调用 server 的 /api/latch-billing/*。
// 契约（server 侧实现在 packages/server/src/latchBilling.ts 的 registerLatchBillingRoutes）：
//   GET  /api/latch-billing/config  -> { plans: [{id,name,amountCents,interval,…}], note? }
//        字段是服务端目录原样（name / amountCents 分单位）；本文件在返回前归一化成
//        消费端的 {label, priceUsd}，服务端字段漂移时不会把 undefined 渲染成 "$NaN"。
//   POST /api/latch-billing/checkout { planId } + Bearer <Latch 会话 token>
//     -> { url }（Stripe hosted Checkout）；401 未登录；400 未知 planId。
// 成功/取消回跳 /pricing?checkout=success|cancelled。
const LATCH_BILLING_CONFIG_PATH = "/api/latch-billing/config";
const LATCH_BILLING_CHECKOUT_PATH = "/api/latch-billing/checkout";

/** 契约里的两个套餐 id；服务端下发的计划列表以此为准，这里只用于请求校验。 */
export type LatchBillingPlanId = "latch-monthly" | "latch-yearly";

export interface LatchBillingPlanOption {
  id: LatchBillingPlanId;
  label: string;
  priceUsd: number;
  interval: "month" | "year";
}

export interface LatchBillingConfig {
  plans: LatchBillingPlanOption[];
  note: string;
}

export type LatchBillingCheckoutErrorKind = "unauthorized" | "unknown_plan" | "server" | "network";

export class LatchBillingCheckoutError extends Error {
  readonly kind: LatchBillingCheckoutErrorKind;
  readonly status?: number;

  constructor(kind: LatchBillingCheckoutErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LatchBillingCheckoutError";
    this.kind = kind;
    if (typeof status === "number") {
      this.status = status;
    }
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

async function latchBillingRequest<T>(input: {
  path: string;
  method: "GET" | "POST";
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(input.path, {
      method: input.method,
      headers: {
        Accept: "application/json",
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: input.signal
        ? AbortSignal.any([input.signal, timeoutController.signal])
        : timeoutController.signal,
    });
    const raw = (await response.text()).trim();
    let payload: unknown = {};
    if (raw) {
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        throw new LatchBillingCheckoutError(
          "server",
          "Unexpected non-JSON response from the Latch billing API",
          response.status,
        );
      }
    }
    if (!response.ok) {
      if (response.status === 401) {
        throw new LatchBillingCheckoutError("unauthorized", "Sign in required", 401);
      }
      if (response.status === 400) {
        throw new LatchBillingCheckoutError("unknown_plan", "Unknown plan", 400);
      }
      throw new LatchBillingCheckoutError(
        "server",
        `Latch billing API request failed (${String(response.status)})`,
        response.status,
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof LatchBillingCheckoutError) {
      throw error;
    }
    throw new LatchBillingCheckoutError(
      "network",
      error instanceof Error && error.name === "AbortError"
        ? "Latch billing API request timed out"
        : "Latch billing API is unreachable",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/latch-billing/config：套餐与网关额度说明。 */
export function fetchLatchBillingConfig(signal?: AbortSignal): Promise<LatchBillingConfig> {
  return latchBillingRequest<unknown>({
    path: LATCH_BILLING_CONFIG_PATH,
    method: "GET",
    signal,
  }).then(normalizeLatchBillingConfig);
}

function isLatchBillingPlanId(value: string): value is LatchBillingPlanId {
  return value === "latch-monthly" || value === "latch-yearly";
}

/**
 * server 下发的是目录原样条目（{id, name, priceId, amountCents, …}，无顶层 note）。
 * 归一化成客户端契约 {id, label, priceUsd, interval}：字段逐个运行时收窄，坏值回落
 * FALLBACK 的同 id 条目，绝不把 undefined 透传给渲染层。
 */
function normalizeLatchBillingConfig(payload: unknown): LatchBillingConfig {
  const rawPlans =
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { plans?: unknown }).plans)
      ? ((payload as { plans: unknown[] }).plans as unknown[])
      : [];
  const plans = rawPlans
    .map((plan): LatchBillingPlanOption | null => {
      if (typeof plan !== "object" || plan === null) {
        return null;
      }
      const record = plan as Record<string, unknown>;
      const id = typeof record["id"] === "string" ? record["id"] : "";
      if (!isLatchBillingPlanId(id)) {
        return null;
      }
      const fallback = FALLBACK_LATCH_BILLING_CONFIG.plans.find((item) => item.id === id);
      const label =
        typeof record["name"] === "string" && record["name"] !== ""
          ? record["name"]
          : (fallback?.label ?? id);
      const priceUsd =
        typeof record["amountCents"] === "number" &&
        Number.isFinite(record["amountCents"]) &&
        record["amountCents"] > 0
          ? record["amountCents"] / 100
          : (fallback?.priceUsd ?? 0);
      const interval =
        record["interval"] === "month" || record["interval"] === "year"
          ? record["interval"]
          : id === "latch-yearly"
            ? ("year" as const)
            : ("month" as const);
      return { id, label, priceUsd, interval };
    })
    .filter((plan): plan is LatchBillingPlanOption => plan !== null);
  return {
    plans: plans.length > 0 ? plans : FALLBACK_LATCH_BILLING_CONFIG.plans,
    note:
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as { note?: unknown }).note === "string"
        ? (payload as { note: string }).note
        : "",
  };
}

/**
 * POST /api/latch-billing/checkout：返回 Stripe hosted Checkout 的 url。
 * token 是 Latch 账号会话 token（browserLatchAccountRepo 的本地镜像），只进请求头，绝不落日志。
 */
export function createLatchBillingCheckout(
  planId: LatchBillingPlanId,
  token: string,
  signal?: AbortSignal,
): Promise<{ url: string }> {
  return latchBillingRequest<{ url: string }>({
    path: LATCH_BILLING_CHECKOUT_PATH,
    method: "POST",
    token,
    body: { planId },
    signal,
  });
}

/** config 拉取失败时的兜底：与上述契约的套餐面一致，保证 /pricing 页始终可渲染。 */
export const FALLBACK_LATCH_BILLING_CONFIG: LatchBillingConfig = {
  plans: [
    { id: "latch-monthly", label: "Latch Monthly", priceUsd: 14, interval: "month" },
    { id: "latch-yearly", label: "Latch Yearly", priceUsd: 99, interval: "year" },
  ],
  note: "",
};
