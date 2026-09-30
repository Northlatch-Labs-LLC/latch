// 浏览器侧 Latch 凭据服务：给 services 的 mint/logout 流一个 ICredentialService 的
// localStorage 实现。Web 登录的 key-id 镜像必须留在浏览器本地——/ws 的
// services.credentialService 是宿主进程共享的加密存储（~/.latch/v2/credentials.json），
// 多用户自托管 Web 时最后一个登录者会覆盖所有人的 latch:account:key_id（状态串台），
// 所以这里绝不能把宿主侧服务传给 mintLatchGatewayKey / latchLogout。
// 键与 browserLatchAccountRepo 保持同一批 localStorage 键；只放行 latch:account:*
// 三个键，与 services 侧会话存储的写入面一致（token/email/key id，密码绝不落盘）。
import {
  LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY,
  LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY,
  LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY,
  type ICredentialService,
} from "@zcode/services";

interface BrowserLatchCredentialServiceStorage {
  localStorage: Storage;
}

const LATCH_ACCOUNT_BROWSER_KEYS: ReadonlySet<string> = new Set([
  LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY,
  LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY,
  LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY,
]);

function assertLatchAccountKey(key: string): void {
  if (!LATCH_ACCOUNT_BROWSER_KEYS.has(key)) {
    throw new Error(
      `Browser latch credential service only manages latch:account:* keys, got: ${key}`,
    );
  }
}

/** 浏览器本地的 Latch 凭据镜像：生命周期 = 当前浏览器 profile，与宿主存储隔离。 */
export function createBrowserLatchCredentialService(
  storage: BrowserLatchCredentialServiceStorage = { localStorage: window.localStorage },
): ICredentialService {
  return {
    async load(key: string): Promise<string | null> {
      assertLatchAccountKey(key);
      return storage.localStorage.getItem(key);
    },
    async save(key: string, value: string): Promise<void> {
      assertLatchAccountKey(key);
      storage.localStorage.setItem(key, value);
    },
    async delete(key: string): Promise<void> {
      assertLatchAccountKey(key);
      storage.localStorage.removeItem(key);
    },
  };
}
