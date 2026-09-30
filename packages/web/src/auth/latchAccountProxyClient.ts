// Web 端 Latch 账号客户端：浏览器不能直连 gateway customer-api（跨域被网关 CORS
// 白名单拒绝），所有账号请求都必须走同源代理 /api/latch-account/*（注册于
// packages/server/src/latchAccountProxy.ts）。
// 这里通过 services 模块的 env 覆盖（LATCH_ACCOUNT_API_URL）把整个请求面换到代理
// 路径上：错误分类（LatchAccountError 的 kind/status/serverCode）、20s 客户端超时、
// 409/401/429 语义与桌面端共用同一份实现，Web 端绝不出现 gateway 域名字面量。
import {
  fetchLatchAccountStatus,
  latchLogout,
  latchSignIn,
  latchSignUp,
  mintLatchGatewayKey,
  type LatchAccountRequestOptions,
  type RuntimeLatchAccountEnv,
} from "@zcode/services";

const LATCH_ACCOUNT_PROXY_PATH = "/api/latch-account";

/** 同源代理 base：dev 下由 vite 的 /api 代理转发到本地 server，生产即同一台 server。 */
function resolveLatchAccountProxyEnv(): RuntimeLatchAccountEnv {
  return {
    LATCH_ACCOUNT_API_URL: `${window.location.origin}${LATCH_ACCOUNT_PROXY_PATH}`,
  };
}

/** POST /api/latch-account/signup（201 登录态；409 email_taken）。 */
export function latchWebSignUp(
  email: string,
  password: string,
  options: LatchAccountRequestOptions = {},
): ReturnType<typeof latchSignUp> {
  return latchSignUp(email, password, { ...options, env: resolveLatchAccountProxyEnv() });
}

/** POST /api/latch-account/login（401 归类为 invalid_credentials）。 */
export function latchWebSignIn(
  email: string,
  password: string,
  options: LatchAccountRequestOptions = {},
): ReturnType<typeof latchSignIn> {
  return latchSignIn(email, password, { ...options, env: resolveLatchAccountProxyEnv() });
}

/** GET /api/latch-account/me：会话校验与账号快照。 */
export function latchWebAccountStatus(token: string): ReturnType<typeof fetchLatchAccountStatus> {
  return fetchLatchAccountStatus(token, { env: resolveLatchAccountProxyEnv() });
}

/** POST /api/latch-account/keys：完整 key 只在这一次响应里出现。 */
export function latchWebMintGatewayKey(
  token: string,
  name: string,
  options: Parameters<typeof mintLatchGatewayKey>[2] = {},
): ReturnType<typeof mintLatchGatewayKey> {
  return mintLatchGatewayKey(token, name, { ...options, env: resolveLatchAccountProxyEnv() });
}

/** POST /api/latch-account/logout：网关会话销毁 + 本地登录态清理。 */
export function latchWebLogout(
  token: string,
  options: Parameters<typeof latchLogout>[1] = {},
): ReturnType<typeof latchLogout> {
  return latchLogout(token, { ...options, env: resolveLatchAccountProxyEnv() });
}
