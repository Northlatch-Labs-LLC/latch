import {
  ZAI_PROVIDER_ID,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZaiOAuthUrl,
  resolveZaiOAuthClientId,
} from "@zcode/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
  readBoolean,
  readEnv,
} from "./configUtils.js";

// 静态默认值只保留 provider 元数据；所有 OAuth 地址与 appId 都在运行期按 env 构建，
// 未配置时回落到 Latch 端点（fail-safe），绝不写死 vendor 域名或已退役的 client id。
const ZAI_OAUTH_PROVIDER_CONFIG: Pick<
  OAuthProviderRuntimeConfig,
  "id" | "displayName" | "enabled" | "order"
> = {
  id: ZAI_PROVIDER_ID,
  displayName: "Z.ai",
  enabled: true,
  order: 1,
};

export function createZaiProviderRuntimeConfig(env: NodeJS.ProcessEnv): OAuthProviderRuntimeConfig {
  return {
    ...ZAI_OAUTH_PROVIDER_CONFIG,
    enabled: readBoolean(env, "ZAI_OAUTH_ENABLED", ZAI_OAUTH_PROVIDER_CONFIG.enabled),
    authorizeUrl:
      readEnv(env, "ZAI_OAUTH_AUTHORIZE_URL") ??
      buildRuntimeZaiOAuthUrl(env, "/api/oauth/authorize"),
    tokenUrl:
      readEnv(env, "ZAI_OAUTH_TOKEN_URL") ?? buildZCodeApiUrlFromEnv(env, "/api/v1/oauth/token"),
    userinfoUrl: resolveZaiUserinfoUrl(env),
    businessLoginUrl:
      readEnv(env, "ZAI_BUSINESS_LOGIN_URL") ??
      buildRuntimeZaiBusinessUrl(env, "/api/auth/z/login"),
    appId:
      // client_id 是公开 OAuth app 标识，按环境覆盖，避免测试/生产 OAuth 应用混用。
      // 未配置时保持为空：ZAI provider 视为未配置，适配器不得构造授权跳转（见 ZaiProviderAdapter）。
      resolveZaiOAuthClientId(env),
    redirectUri: buildDesktopOAuthRedirectUriFromEnv(env),
  };
}

export function resolveZaiUserinfoUrl(env: NodeJS.ProcessEnv): string {
  return (
    readEnv(env, "ZAI_OAUTH_USERINFO_URL") ?? buildRuntimeZaiOAuthUrl(env, "/api/oauth/userinfo")
  );
}
