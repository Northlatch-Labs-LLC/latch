// Latch 自有订阅计费模块：Latch 产品的 Stripe（test 模式起步）Checkout 与 webhook，
// 与 xlaunch 的计费服务完全分离 —— 不改 xlaunch billing service，只复用它的
// gateway service-api 入账契约（POST /service-api/credits，paymentId 幂等）。
//
// 契约参考（只读）：xlaunch-agent-web/server/src/gateway.ts（applyCredit）、
// src/webhook.ts（CreditInstruction / 事件到入账的判定）、src/checkout.ts（session 参数）。
//
// 安全口径：
// - Stripe 密钥与 gateway service token 只从本进程 env 读取（LATCH_STRIPE_SECRET_KEY /
//   LATCH_GATEWAY_SERVICE_TOKEN），绝不写入日志或响应体。
// - webhook 不依赖签名密钥：解析出事件 id 后用密钥回查 GET /v1/events/:id，只处理
//   回查到的事件 —— 真实性来自这次 API 调用，而不是请求体本身。
// - 幂等：入账的 paymentId 用「被支付对象」的 id（session / invoice），gateway 按
//   paymentId 去重；本进程内再用已处理事件 id 集合兜一层，同一事件不重复入账。
import type { Context, Hono } from "hono";
import { buildLatchAccountApiUrl, readLatchAccountEnv } from "@zcode/services";

// Stripe API 与 gateway service-api 的上游 15s/10s 超时：超时按上游不可达处理，
// webhook 返回 5xx 让 Stripe 重试（Stripe 会对非 2xx 响应自动重投）。
const STRIPE_API_TIMEOUT_MS = 15_000;
const GATEWAY_SERVICE_TIMEOUT_MS = 10_000;

const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";

// gateway service-api 基址：与 latchAccountProxy 的 customer-api 同一个 gateway 域，
// env 可整体覆盖（LATCH_GATEWAY_SERVICE_API_URL），缺省为线上网关。
const DEFAULT_LATCH_GATEWAY_SERVICE_API_BASE_URL = "https://gateway.xlaunch.work/service-api";
const LATCH_GATEWAY_SERVICE_API_URL_ENV_KEY = "LATCH_GATEWAY_SERVICE_API_URL";
const LATCH_STRIPE_SECRET_KEY_ENV_KEY = "LATCH_STRIPE_SECRET_KEY";
const LATCH_GATEWAY_SERVICE_TOKEN_ENV_KEY = "LATCH_GATEWAY_SERVICE_TOKEN";

// Checkout 回跳地址：Latch 产品自己的 pricing 页（不是 xlaunch 的 account 页）。
const LATCH_CHECKOUT_SUCCESS_URL = "https://latch.xlaunch.work/pricing?checkout=success";
const LATCH_CHECKOUT_CANCEL_URL = "https://latch.xlaunch.work/pricing?checkout=cancelled";

// 计划目录与入账额度。creditCents（订阅每期附赠的 gateway credit）是创始人可调
// 政策常量，只在这一处定义：目录文案（config 接口）与 webhook 入账都读这里。
// priceId 来自 Stripe API 实测（test 模式，GET /v1/prices?active=true）。
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

// 键显式放宽为 string：webhook metadata / 请求体里的 planId 是任意字符串，
// get() 要接受 string 再判空（Map 键若收窄成目录字面量联合，.get(string) 编不过）。
const LATCH_PLANS_BY_ID = new Map<string, (typeof LATCH_PLANS)[number]>(
  LATCH_PLANS.map((plan) => [plan.id, plan] as const),
);

// checkout 时写进 session 与 subscription 的 metadata 键：webhook 回查事件后靠它们
// 定位入账账户（对齐 estate 的 META 用法，键名换成 Latch 命名空间）。
const LATCH_META = {
  kind: "latch_kind",
  email: "latch_customer_email",
  plan: "latch_plan",
} as const;

// 网关错误契约与 latchAccountProxy 同款：{ error: { message } }，Web 端错误分类统一读
// error.message。
interface LatchBillingErrorBody {
  error: { message: string };
}

// 代理自身会回的状态码；Stripe 透传的 4xx/5xx 也收敛到这个集合，未知的按 502 兜底。
const BILLING_ERROR_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504] as const;

type BillingErrorStatus = (typeof BILLING_ERROR_STATUSES)[number];

function billingError(c: Context, status: BillingErrorStatus, message: string): Response {
  return c.json({ error: { message } } satisfies LatchBillingErrorBody, status, {
    "cache-control": "no-store",
  });
}

/** Stripe 错误透传：4xx/5xx 原样映射（未知状态按 502），message 用 Stripe 的原文。 */
function toBillingErrorStatus(status: number): BillingErrorStatus {
  return BILLING_ERROR_STATUSES.includes(status as BillingErrorStatus)
    ? (status as BillingErrorStatus)
    : 502;
}

function readEnvValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Stripe 密钥 / service token 缺失时计费不可用：返回 503，让前端提示而非静默失败。 */
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

// 进程内已处理事件 id 集合：并发重投/手动重发时同一事件只入账一次；gateway 侧
// paymentId 去重是最终防线。集合有上限，防长期运行内存泄漏。
const PROCESSED_EVENT_IDS_LIMIT = 10_000;
const processedEventIds = new Set<string>();

function markEventProcessed(eventId: string): boolean {
  if (processedEventIds.has(eventId)) {
    return false;
  }
  if (processedEventIds.size >= PROCESSED_EVENT_IDS_LIMIT) {
    // 简单淘汰：清空后重记。gateway paymentId 去重仍然兜底，不会造成重复入账。
    processedEventIds.clear();
  }
  processedEventIds.add(eventId);
  return true;
}

// ---- Stripe REST（fetch + form-encoded，不引入 Stripe SDK）------------------

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

/** Stripe 调用统一入口：Bearer 密钥鉴权、超时、错误透传；密钥与令牌不落日志。 */
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

// ---- webhook 事件 → 入账指令（对齐 estate webhook.ts 的判定语义）-------------

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
 * 从 invoice 上读 metadata：Stripe 新版 API 放在 parent.subscription_details.metadata，
 * 旧版在 subscription_details.metadata（estate webhook.ts 同款兼容读法）。
 */
function invoiceMetadataOf(invoice: Record<string, unknown>): Record<string, unknown> {
  const parent = metadataOf(invoice["parent"]);
  const details = metadataOf(parent["subscription_details"] ?? invoice["subscription_details"]);
  return metadataOf(details["metadata"]);
}

/** invoice 覆盖期结束时间（毫秒）；读不到给 null，绝不猜。 */
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
 * 事件到入账指令的判定，语义对齐 estate webhook.ts outcomeOf：
 * - checkout.session.completed 只在 payment 模式下入账（Latch 在售的只有订阅，
 *   订阅 session 不入账，由它的第一期 invoice.paid 入账，避免首月双份）；
 * - invoice.paid 携带 Latch subscription metadata 才入账，额度用目录里的
 *   creditCents（创始人可调常量）。
 *
 * 关键前提：founder 的 Latch test key 与 xlaunch estate 计费服务共用同一个 Stripe
 * 账户（已实测：账户下同时挂着 billing.xlaunch.work / synapse / gridframes 的
 * webhook），所以本 webhook 也会收到 estate 的事件 —— 缺少 Latch metadata 的事件
 * 一律忽略，绝不按 customer_email 兜底入账，否则会把 estate 的支付双份入账。
 */
function outcomeOf(event: Record<string, unknown>): EventOutcome {
  const type = readText(event["type"]);
  const object = metadataOf(metadataOf(event["data"])["object"]);
  const metadata = metadataOf(object["metadata"]);

  if (type === "checkout.session.completed") {
    // 只认 Latch 自己写的 metadata（checkout 时写入 session）。
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
    // 只认 subscription metadata 里的 Latch 账户（estate 的 invoice 不带 Latch
    // metadata，在这里被忽略）。绝不用 customer_email 兜底。
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

// ---- gateway service-api（对齐 estate gateway.ts applyCredit / applyPlan）----

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
  // 404 = 账户不存在（estate 语义：视为已处理，不重试）；401/5xx 等按不可达处理，
  // webhook 返回 5xx 让 Stripe 重试（payment 是真实的，不能因 token 轮换而丢弃）。
  if (response.status === 404) {
    return { state: "no-such-customer" };
  }
  if (response.status !== 200 && response.status !== 201) {
    return { state: "unavailable", message: `gateway service API answered ${response.status}` };
  }
  return { state: "applied" };
}

/**
 * 用 Latch 服务器自己的 session token 换账户邮箱：与 /api/latch-account/me 同一条
 * customer-api 通路（"resolve the customer email like the account proxy does"）。
 * 邮箱绝不取自请求体。
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
 * 注册 /api/latch-billing/* 路由。
 *
 * @param app - http.ts 里创建的 Hono 实例；必须先于静态资源 catch-all 注册。
 */
export function registerLatchBillingRoutes(app: Hono): void {
  // 计划目录：公开（定价页未登录也要渲染），不涉及任何机密。
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
          // 文案口径：订阅含等额 gateway credit（'includes $14 / $99 of gateway credit'）。
          creditLabel: `includes $${plan.creditCents / 100} of gateway credit`,
        })),
      },
      200,
      { "cache-control": "no-store" },
    ),
  );

  // 发起 Checkout：Bearer 为 Latch session token，邮箱从 customer-api /me 解析。
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

    // metadata 同时写在 session 与 subscription 上：续期 invoice 只带 subscription 的
    // metadata，webhook 靠它定位入账账户（estate checkout.ts 同款做法）。
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
      // payload 是宽型（T | {error}），`in` 收窄推不到 error.message；用显式类型的
      // 局部变量读取 Stripe 错误文案，运行时行为不变。
      const errorPayload = result.payload as { error?: { message?: unknown } } | null;
      const message =
        typeof errorPayload === "object" &&
        errorPayload !== null &&
        typeof errorPayload.error?.message === "string"
          ? errorPayload.error.message
          : "Stripe checkout is unavailable";
      // Stripe 自己的错误（400/402/429…）按原状态码与 message 透传；超时/不可达已在上层
      // 折算成 504/502。
      return billingError(c, toBillingErrorStatus(result.status), message);
    }
    const sessionUrl = readText(metadataOf(result.payload)["url"]);
    if (!sessionUrl) {
      return billingError(c, 502, "Stripe checkout is unavailable");
    }
    return c.json({ url: sessionUrl }, 200, { "cache-control": "no-store" });
  });

  // Stripe webhook：不验签名（API 建的端点按 founder 口径不持有签名密钥），改为
  // 回查 GET /v1/events/:id —— 只处理回查到的事件，真实性来自这次 API 调用。
  app.post("/api/latch-billing/webhook", async (c) => {
    const secretKey = readStripeSecretKey();
    if (!secretKey) {
      return billingError(c, 503, "Latch billing is not configured");
    }
    const serviceToken = readEnvValue(LATCH_GATEWAY_SERVICE_TOKEN_ENV_KEY);
    if (!serviceToken) {
      // 没有入账令牌时不能消费支付事件：回 5xx 让 Stripe 重试，而不是静默丢弃。
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
      // 回查失败 = 事件不可信或 Stripe 不可达：一律 4xx/5xx 让 Stripe 重试。
      return billingError(c, 502, "Stripe event could not be verified");
    }
    const event = fetched.payload as Record<string, unknown>;
    const eventId = readText(event["id"]);
    if (!eventId || eventId !== postedEventId) {
      return billingError(c, 400, "Stripe event could not be verified");
    }
    if (!markEventProcessed(eventId)) {
      // 同一事件已在本次运行内处理过：直接确认，绝不二次入账。
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
    // plan 记录失败不回滚 credit：与 estate 一致，credit 先落账，plan 留给后续事件。
    if (outcome.plan) {
      await callGatewayServiceApi(serviceToken, "/plan", outcome.plan);
    }
    return c.json({ received: true, outcome: creditResult.state }, 200, {
      "cache-control": "no-store",
    });
  });
}
