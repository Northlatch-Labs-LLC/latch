// 浏览器侧 Latch 登录态仓储：对齐 browserOAuthCredentialRepo 的收敛方式，把
// {token, email} 镜像进 localStorage。键名与 services 侧的凭据键
// （latch:account:token / latch:account:email）保持一致，便于排查对照。
// 密码绝不进入本模块（硬规则）：这里只有 token/email/key id 三个键会被碰到。
import {
  LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY,
  LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY,
  LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY,
  type LatchAccountSession,
} from "@zcode/services";

interface BrowserLatchAccountRepoStorage {
  localStorage: Storage;
}

function hasText(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 统一收敛 localStorage 读写，避免业务层散落登录态判断。 */
export class BrowserLatchAccountRepo {
  private readonly localStorage: Storage;

  constructor(storage: BrowserLatchAccountRepoStorage = { localStorage: window.localStorage }) {
    this.localStorage = storage.localStorage;
  }

  saveSession(session: LatchAccountSession): void {
    this.localStorage.setItem(LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY, session.token);
    if (session.email.trim()) {
      this.localStorage.setItem(LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY, session.email.trim());
    } else {
      this.localStorage.removeItem(LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY);
    }
  }

  loadSession(): LatchAccountSession | null {
    const token = this.localStorage.getItem(LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY);
    if (!hasText(token)) {
      return null;
    }
    const email = this.localStorage.getItem(LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY) ?? "";
    return { token, email };
  }

  clearSession(): void {
    this.localStorage.removeItem(LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY);
    this.localStorage.removeItem(LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY);
    // key id 与 token/email 同生命周期（对齐 services 侧 clearLatchAccountSession）：
    // 登出即失配，必须一起清掉。
    this.localStorage.removeItem(LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY);
  }
}
