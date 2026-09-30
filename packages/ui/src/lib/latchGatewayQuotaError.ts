/**
 * Xlaunch Gateway（Latch 内嵌 provider）配额错误分类。
 *
 * 这是“订阅门”错误的 UI 侧唯一分类点：网关在推理侧按 key 拒绝请求
 * （只读参考 xlaunch-gateway server/src/routes/proxy.ts enforceSpendCap）：
 *
 * | HTTP | error.code                     | 语义                     | UI 旅程        |
 * |------|--------------------------------|--------------------------|----------------|
 * | 402  | account_balance_exhausted      | 账户余额耗尽             | 充值/升级横幅  |
 * | 429  | client_profile_cap_reached     | key 的 token 上限（Retry-After 1h/24h） | 升级横幅 |
 * | 401  | （无 code，message=Invalid API key） | key 失效/被吊销     | 重新登录 Latch |
 *
 * 到达路径（读链路核对过，行号见下）：
 * 网关响应体 `{error:{code,message}}` → adapters `readProviderBusinessFailureFromBody`
 * (apps/zcode-cli/packages/adapters/src/model/model-execution.ts) 把 `error.code`
 * 提为 `ProviderBusinessError.providerCode` → `classifyProviderBusinessFailure`
 * (failure-classifier.ts) 终止型映射（本仓库 failure-provider-business-codes.ts
 * 已登记两个 code）→ `toAdapterError` (runner-retry.ts) 把 providerCode 写进
 * `context.providerCode` → core `toErrorPayloadFrame`/`selectErrorCode`
 * (apps/zcode-cli/packages/core/src/errors/error-payload.ts) 让
 * **providerCode 优先于外层 code** 成为最终 `code` → sessionErrorInfo.code →
 * `normalizeZCodeUiError` (src/lib/zcodeUiError.ts) 原样透传为 `ZCodeUiError.code`。
 *
 * 401 没有 code：走分类器通用 401 分支（code=`provider_not_configured`、
 * message="Provider authentication failed."），网关原文 "Invalid API key" 保留在
 * underlyingErrorMessage/detail 里 —— 因此 401 的判定同时要求 attribution.statusCode
 * === 401 与该原文出现，避免把其他 provider 的 401 误判成网关。
 */
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

/** 网关 402 的 error.code（routes/proxy.ts enforceSpendCap）。 */
export const LATCH_GATEWAY_BALANCE_EXHAUSTED_CODE = "account_balance_exhausted";
/** 网关 429 的 error.code（routes/proxy.ts enforceSpendCap）。 */
export const LATCH_GATEWAY_PROFILE_CAP_CODE = "client_profile_cap_reached";
/** 网关 401 的响应体原文（routes/proxy.ts requireInferenceAuth）。 */
export const LATCH_GATEWAY_INVALID_KEY_MESSAGE = "invalid api key";

export type LatchGatewayQuotaKind =
  /** 402：余额耗尽 —— 主 CTA 充值/升级。 */
  | "out-of-credit"
  /** 429：key 的 token 上限 —— 主 CTA 充值/升级，尊重 Retry-After。 */
  | "token-cap-reached"
  /** 401：key 失效 —— 主 CTA 重新登录 Latch。 */
  | "gateway-reauth";

export interface LatchGatewayQuotaClassification {
  kind: LatchGatewayQuotaKind;
  /** 网关拒绝时使用的 HTTP 状态码（402/429/401）；attribution 缺失时为 null。 */
  statusCode: number | null;
  /**
   * 429 的 Retry-After 毫秒数。注意：v4 会话错误通道（sessionErrorInfoSchema 的
   * errorAttributionSchema 是 strict 的，packages/shared/src/zcode-protocol-v4/snapshot.ts）
   * 目前不携带 retryAfterMs，只有调用方从其他通道拿到时才可能非空。
   */
  retryAfterMs: number | null;
}

/** 分类输入：ZCodeUiError 的错误面（含可选的 retryAfterMs 旁路）。 */
export type LatchGatewayQuotaErrorLike = Pick<ZCodeUiError, "code" | "message" | "attribution"> & {
  detail?: string;
  underlyingErrorMessage?: string;
  retryAfterMs?: number;
};

/** 各 kind 对应的 i18n message id（文案由 integrator 注入 locale）。 */
export const LATCH_GATEWAY_QUOTA_MESSAGE_IDS: Record<LatchGatewayQuotaKind, string> = {
  "out-of-credit": "chat.error.latchGateway.outOfCredit",
  "token-cap-reached": "chat.error.latchGateway.tokenCapReached",
  "gateway-reauth": "chat.error.latchGateway.reauthRequired",
};

function readProviderErrorCode(error: LatchGatewayQuotaErrorLike): string | null {
  const code = error.code?.trim();
  if (code) {
    return code;
  }
  const attributed = error.attribution?.providerErrorCode?.trim();
  return attributed ? attributed : null;
}

function mentionsInvalidGatewayKey(error: LatchGatewayQuotaErrorLike): boolean {
  const haystacks = [error.message, error.underlyingErrorMessage, error.detail];
  return haystacks.some((text) =>
    (text ?? "").toLowerCase().includes(LATCH_GATEWAY_INVALID_KEY_MESSAGE),
  );
}

/**
 * 把一条会话错误分类成网关配额旅程；不属于网关配额契约时返回 null
 * （调用方回落到普通错误横幅）。纯函数，可单测。
 */
export function classifyLatchGatewayQuotaError(
  error: LatchGatewayQuotaErrorLike | null | undefined,
): LatchGatewayQuotaClassification | null {
  if (!error) {
    return null;
  }
  const statusCode =
    typeof error.attribution?.statusCode === "number" ? error.attribution.statusCode : null;
  const providerErrorCode = readProviderErrorCode(error);

  if (providerErrorCode === LATCH_GATEWAY_BALANCE_EXHAUSTED_CODE) {
    return { kind: "out-of-credit", statusCode: statusCode ?? 402, retryAfterMs: null };
  }
  if (providerErrorCode === LATCH_GATEWAY_PROFILE_CAP_CODE) {
    const retryAfterMs =
      typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : null;
    return { kind: "token-cap-reached", statusCode: statusCode ?? 429, retryAfterMs };
  }
  if (statusCode === 401 && mentionsInvalidGatewayKey(error)) {
    return { kind: "gateway-reauth", statusCode: 401, retryAfterMs: null };
  }
  return null;
}

/**
 * Retry-After 的人类可读等待时长（分钟/小时）。只做舍入展示，不做时钟判断；
 * 无值时返回 null，由调用方决定是否省略等待提示。
 */
export function formatLatchGatewayRetryWait(
  retryAfterMs: number | null,
  formatMessage: (id: string, values?: Record<string, string>) => string,
): string | null {
  if (retryAfterMs === null || retryAfterMs <= 0) {
    return null;
  }
  const totalMinutes = Math.round(retryAfterMs / 60_000);
  if (totalMinutes < 60) {
    return formatMessage("chat.error.latchGateway.retryWaitMinutes", {
      count: String(Math.max(totalMinutes, 1)),
    });
  }
  const hours = Math.round(totalMinutes / 60);
  return formatMessage("chat.error.latchGateway.retryWaitHours", {
    count: String(hours),
  });
}
