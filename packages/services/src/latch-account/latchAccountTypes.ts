// Latch 账号契约类型：与 gateway customer-api 的响应一一对应（只挑客户端需要的字段）。
// 形状来源：xlaunch-gateway server/src/routes/customer.ts 与 services/customer-plan.ts、
// services/billing.ts（只读参考，不修改）。
import { LATCH_MIN_PASSWORD_LENGTH } from "./config.js";

/** POST /signup 与 POST /login 的共同返回。 */
export interface LatchAccountAuthResult {
  token: string;
  email: string;
  /** 欢迎邮件里那份托管 harness 入口；gateway 未配置 harness 域名时缺失。 */
  harnessAccessUrl?: string;
}

export type LatchAccountPlanId = "pro" | "team";

/** /me 的 plan 字段：套餐在署记录；null 表示按量计费（真实状态，不是缺失）。 */
export interface LatchAccountPlanHeld {
  plan: LatchAccountPlanId;
  since: string;
  renewsAtMs: number | null;
}

export interface LatchAccountTreasury {
  sui: string;
  evmChain: string;
  evm: string;
}

/** GET /me 的返回。 */
export interface LatchAccountStatus {
  email: string;
  balanceMicros: number;
  billingEnabled: boolean;
  usdPerMillionTokens: number;
  plan: LatchAccountPlanHeld | null;
  treasury: LatchAccountTreasury;
}

export type LatchLedgerEntryKind = "credit" | "debit";

/** GET /ledger 的单条记录（用量对账单，最多 200 条）。 */
export interface LatchLedgerEntry {
  id: number;
  kind: LatchLedgerEntryKind;
  usdMicros: number;
  reason: string;
  refId: number | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

/** GET /ledger 的返回。 */
export interface LatchLedger {
  balanceMicros: number;
  entries: LatchLedgerEntry[];
}

/** POST /keys 的返回：完整 key（sk-cp- 前缀）只在铸造这一次返回。 */
export interface LatchGatewayKeyMinted {
  id: number;
  name: string;
  key: string;
}

/** GET /keys 的条目：只有 maskedKey，拿不到完整 key。 */
export interface LatchGatewayKeySummary {
  id: number;
  name: string;
  maskedKey: string;
  enabled: boolean;
  createdAt: string;
}

/** 本地登录态（凭据存储镜像）；密码绝不进入这个结构。 */
export interface LatchAccountSession {
  token: string;
  email: string;
}

/**
 * 客户端错误分类。HTTP → kind 的映射：
 * 400 → validation；401（登录）→ invalid_credentials；401（其他）→ unauthorized；
 * 409 → email_taken；402/account_balance_exhausted → insufficient_balance；
 * 429/client_profile_cap_reached → rate_limited（带 retryAfterMs）；5xx → server；
 * fetch 本身失败 → network。
 */
export type LatchAccountErrorKind =
  | "validation"
  | "email_taken"
  | "invalid_credentials"
  | "unauthorized"
  | "rate_limited"
  | "insufficient_balance"
  | "network"
  | "server"
  | "unknown";

interface LatchAccountErrorDetails {
  status?: number;
  serverCode?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class LatchAccountError extends Error {
  readonly kind: LatchAccountErrorKind;
  readonly status?: number;
  /** 网关 error.code（如 account_balance_exhausted），仅透传不解析。 */
  readonly serverCode?: string;
  /** Retry-After 换算成毫秒；仅 rate_limited 可能携带。 */
  readonly retryAfterMs?: number;

  constructor(
    kind: LatchAccountErrorKind,
    message: string,
    details: LatchAccountErrorDetails = {},
  ) {
    super(message, ...(details.cause === undefined ? [] : [{ cause: details.cause }]));
    this.name = "LatchAccountError";
    this.kind = kind;
    if (typeof details.status === "number") this.status = details.status;
    if (details.serverCode) this.serverCode = details.serverCode;
    if (typeof details.retryAfterMs === "number") this.retryAfterMs = details.retryAfterMs;
  }
}

// 客户端校验：与服务端 zod schema（email max 200、password 10..200）对齐的最小镜像。
const LATCH_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidLatchEmail(email: string): boolean {
  const trimmed = email.trim();
  return trimmed.length > 0 && trimmed.length <= 200 && LATCH_EMAIL_PATTERN.test(trimmed);
}

export function isValidLatchPassword(password: string): boolean {
  return password.length >= LATCH_MIN_PASSWORD_LENGTH && password.length <= 200;
}
