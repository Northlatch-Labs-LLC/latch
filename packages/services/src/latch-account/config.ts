// Latch 账号服务的配置面：xlaunch gateway customer-api 的地址、账号页链接与凭据键。
// 唯一账号后端是线上 gateway customer API（架构决策 2026-09-30），这里只做客户端集成。
// env 覆盖沿用 master-switch 命名（LATCH_ACCOUNT_*），与 zaiProviderConfig 一样在运行期
// 按传入 env 解析，桌面/Web/测试可以整体换源；未配置时回落到 Latch 产品域（fail-safe）。

export const DEFAULT_LATCH_ACCOUNT_API_BASE_URL = "https://gateway.xlaunch.work/customer-api";
export const DEFAULT_LATCH_ACCOUNT_MANAGE_URL = "https://xlaunch.work/account";
export const DEFAULT_LATCH_ACCOUNT_PURCHASE_URL = "https://xlaunch.work/account?plan=pro";

export const LATCH_ACCOUNT_API_URL_ENV_KEY = "LATCH_ACCOUNT_API_URL";
export const LATCH_ACCOUNT_MANAGE_URL_ENV_KEY = "LATCH_ACCOUNT_MANAGE_URL";
export const LATCH_ACCOUNT_PURCHASE_URL_ENV_KEY = "LATCH_ACCOUNT_PURCHASE_URL";

export interface RuntimeLatchAccountEnv {
  [key: string]: string | undefined;
  LATCH_ACCOUNT_API_URL?: string;
  LATCH_ACCOUNT_MANAGE_URL?: string;
  LATCH_ACCOUNT_PURCHASE_URL?: string;
}

// Session 只持久化 token/email/已铸造推理 Key 的 id；密码绝不落盘（硬规则）。
export const LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY = "latch:account:token";
export const LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY = "latch:account:email";
export const LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY = "latch:account:key_id";

// 内嵌 gateway provider 模板（config/provider/zcode-builtin.json），登录后把推理 Key 接进去。
export const LATCH_GATEWAY_PROVIDER_TEMPLATE_ID = "xlaunch-gateway";

// 与 gateway 侧 MIN_PASSWORD_LENGTH（server/src/services/customer-auth.ts）保持一致；
// 客户端先行校验，避免拿弱密码去打线上 signup。
export const LATCH_MIN_PASSWORD_LENGTH = 10;

export function readLatchAccountEnv(): RuntimeLatchAccountEnv {
  return typeof process === "undefined" ? {} : process.env;
}

function readLatchAccountEnvValue(env: RuntimeLatchAccountEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function requireHttpHttpsUrl(value: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Latch account URL must use http or https");
  }
  return parsed;
}

/** API base URL 允许带路径（customer-api），只统一去掉结尾斜杠。 */
export function normalizeLatchAccountApiBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Latch account API base URL is empty");
  }
  return requireHttpHttpsUrl(trimmed).toString().replace(/\/+$/, "");
}

function normalizeLatchAccountPageUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Latch account page URL is empty");
  }
  requireHttpHttpsUrl(trimmed);
  return trimmed;
}

export function resolveLatchAccountApiBaseUrl(
  env: RuntimeLatchAccountEnv = readLatchAccountEnv(),
): string {
  return normalizeLatchAccountApiBaseUrl(
    readLatchAccountEnvValue(env, LATCH_ACCOUNT_API_URL_ENV_KEY) ??
      DEFAULT_LATCH_ACCOUNT_API_BASE_URL,
  );
}

export function resolveLatchAccountManageUrl(
  env: RuntimeLatchAccountEnv = readLatchAccountEnv(),
): string {
  return normalizeLatchAccountPageUrl(
    readLatchAccountEnvValue(env, LATCH_ACCOUNT_MANAGE_URL_ENV_KEY) ??
      DEFAULT_LATCH_ACCOUNT_MANAGE_URL,
  );
}

export function resolveLatchAccountPurchaseUrl(
  env: RuntimeLatchAccountEnv = readLatchAccountEnv(),
): string {
  return normalizeLatchAccountPageUrl(
    readLatchAccountEnvValue(env, LATCH_ACCOUNT_PURCHASE_URL_ENV_KEY) ??
      DEFAULT_LATCH_ACCOUNT_PURCHASE_URL,
  );
}

export function buildLatchAccountApiUrl(env: RuntimeLatchAccountEnv, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveLatchAccountApiBaseUrl(env)}${normalizedPath}`;
}
