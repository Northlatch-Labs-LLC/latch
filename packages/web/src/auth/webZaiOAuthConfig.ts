import type { WebZaiOAuthProviderConfig } from "./zaiWebOAuthProvider.js";
import {
  buildZCodeEndpointUrls,
  DEFAULT_ZAI_OAUTH_ORIGIN,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  resolveBigModelApiOrigin,
} from "@zcode/shared";

interface WebImportMetaEnv {
  VITE_DEV_ORIGIN?: string;
  VITE_ZAI_OAUTH_CLIENT_ID?: string;
  VITE_ZAI_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_APP_ID?: string;
  VITE_OAUTH_TOKEN_URL?: string;
  VITE_ZCODE_BASE_URL?: string;
  VITE_ZCODE_ENDPOINT_ORIGIN?: string;
  VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO?: string;
}

export interface WebZaiOAuthConfig extends WebZaiOAuthProviderConfig {
  devOrigin?: string;
  shareRedirectUri: string;
  allowDevReturnToRedirect: boolean;
  /** Z.ai web OAuth 是否已显式配置；未配置时不得构造 vendor 授权跳转。 */
  zaiWebOAuthConfigured: boolean;
  /**
   * BigModel web OAuth 是否已显式配置（VITE_BIGMODEL_OAUTH_ORIGIN 已注入）。
   * 与 zaiWebOAuthConfigured 同一 fail-safe 口径：未配置时登录入口必须拒绝，
   * 绝不能借 resolveBigModelApiOrigin 的生产 origin 兜底把用户带去 bigmodel.cn。
   */
  bigmodelWebOAuthConfigured: boolean;
}

function normalizeZaiOAuthOrigin(value: string): string {
  return new URL(value.trim()).origin;
}

function buildZaiOAuthAuthorizeUrl(origin: string | undefined): string {
  // 未显式配置 VITE_ZAI_OAUTH_ORIGIN 时回落到 Latch 端点（请求会 404 失败保护），
  // 绝不回退到 vendor 授权域；是否可用由 zaiWebOAuthConfigured 把关。
  return `${normalizeZaiOAuthOrigin(origin?.trim() || DEFAULT_ZAI_OAUTH_ORIGIN)}/api/oauth/authorize`;
}

/**
 * BigModel 的授权入口。
 *
 * 必须跟随环境：测试环境写死 bigmodel.cn 会把测试账号带到生产授权页。构建期由
 * vite.config 用 resolveBigModelApiOrigin 注入 VITE_BIGMODEL_OAUTH_ORIGIN；这里的
 * resolveBigModelApiOrigin({}) 只是类型完备所需的最后兜底（等价于生产 origin），
 * 运行时不可达：startLogin 与登录入口 UI 都以 bigmodelWebOAuthConfigured 把关，
 * 未配置时根本不会走到构造授权跳转这一步。
 */
function buildBigModelAuthorizeUrl(origin: string | undefined): string {
  const trimmed = origin?.trim();
  return `${trimmed ? new URL(trimmed).origin : resolveBigModelApiOrigin({})}/login`;
}

function createWebZaiOAuthConfig(env: WebImportMetaEnv = {}): WebZaiOAuthConfig {
  const devOrigin = env.VITE_DEV_ORIGIN?.trim().replace(/\/$/, "");
  const zaiOAuthClientId = env.VITE_ZAI_OAUTH_CLIENT_ID?.trim() || "";
  const zaiOAuthOrigin = env.VITE_ZAI_OAUTH_ORIGIN?.trim() || "";
  const bigmodelOAuthOrigin = env.VITE_BIGMODEL_OAUTH_ORIGIN?.trim() || "";
  const zcodeEndpointUrls = buildZCodeEndpointUrls(
    env.VITE_ZCODE_BASE_URL?.trim() ||
      env.VITE_ZCODE_ENDPOINT_ORIGIN?.trim() ||
      DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  );

  return {
    // ZAI 当前 OAuth 授权入口使用 /api/oauth 前缀，继续走 /auth/oauth 会打开旧入口。
    authorizeUrl: buildZaiOAuthAuthorizeUrl(zaiOAuthOrigin || undefined),
    // 上游部署 web 与 token API 同源，相对路径即可；Latch 独立部署（deploy/web）没有
    // vendor API，必须用 VITE_OAUTH_TOKEN_URL 显式指向 vendor token 端点（zai/bigmodel
    // 共用同一 zcode 后端，body 里以 provider 区分），否则授权码交换会 404 失败。
    // 缺省保持相对路径，不改变上游同源部署的既有行为。
    tokenUrl: env.VITE_OAUTH_TOKEN_URL?.trim() || "/api/v1/oauth/token",
    // client_id 会出现在授权 URL 中，属于公开配置；这里允许 VITE_ 注入，但不能放 secret/token。
    // 未注入时保持为空：Z.ai web OAuth 视为未配置（见 zaiWebOAuthConfigured），
    // 绝不回退到已退役的 vendor client id。
    clientId: zaiOAuthClientId,
    bigmodelAuthorizeUrl: buildBigModelAuthorizeUrl(bigmodelOAuthOrigin || undefined),
    // BigModel 用 appId 而不是 client_id，且默认值就是桌面端在用的 "zcode"。
    bigmodelAppId: env.VITE_BIGMODEL_OAUTH_APP_ID?.trim() || "zcode",
    redirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    shareRedirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    ...(devOrigin ? { devOrigin } : {}),
    allowDevReturnToRedirect: env.VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO === "true",
    // Web 端第一方登录是 Latch gateway key；Z.ai web OAuth 仅在 client id 与授权 origin
    // 都显式配置时启用，缺任一项即视为未配置，登录入口必须拒绝构造授权跳转。
    zaiWebOAuthConfigured: Boolean(zaiOAuthClientId) && Boolean(zaiOAuthOrigin),
    // BigModel 与 Z.ai 同一 fail-safe 口径：只在授权 origin 显式注入时可用，
    // 绝不借生产 origin 兜底发起登录。
    bigmodelWebOAuthConfigured: Boolean(bigmodelOAuthOrigin),
  };
}

const env = ((import.meta as ImportMeta & { env?: WebImportMetaEnv }).env ??
  {}) as WebImportMetaEnv;

export const WEB_ZAI_OAUTH_CONFIG: WebZaiOAuthConfig = createWebZaiOAuthConfig(env);

export function resolveWebAuthDevReturnTo(config: WebZaiOAuthConfig): string | undefined {
  return config.devOrigin ? `${config.devOrigin}/share/callback` : undefined;
}
