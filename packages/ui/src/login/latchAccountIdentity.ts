// Latch 账号身份：把 gateway 登录态映射成 App user（UserInfo）。
// OAuth 登录的 user 来自 zai/bigmodel 回调；Latch 账号没有 OAuth 用户信息，
// 用 latch: 前缀的合成 id 区分，供 onboarding 认领与身份展示复用同一套 user 事实源。
import type { UserInfo } from "@zcode/shared";

const LATCH_IDENTITY_ID_PREFIX = "latch:";

export function buildLatchIdentityUser(email: string): UserInfo {
  const trimmed = email.trim();
  return {
    id: `${LATCH_IDENTITY_ID_PREFIX}${trimmed}`,
    username: trimmed,
    displayName: trimmed,
  };
}

/** 判断 App user 是否由 Latch 账号登录写入；退出 Latch 账号时只清理自己的身份。 */
export function isLatchIdentityUser(user: UserInfo | null): boolean {
  return Boolean(user?.id.startsWith(LATCH_IDENTITY_ID_PREFIX));
}
