// Latch 登录态持久化：沿用 oauthCredentialRepo 的惯例，把 session 镜像进
// ICredentialService（加密 ~/.latch/v2/credentials.json）。密码绝不落盘，
// 本模块也只有 token/email/key id 三个键可以写入。
import type { ICredentialService } from "../credential/credential.js";
import {
  LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY,
  LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY,
  LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY,
} from "./config.js";
import type { LatchAccountSession } from "./latchAccountTypes.js";

export interface LatchAccountSessionStore {
  saveLatchAccountSession(session: LatchAccountSession): Promise<void>;
  loadLatchAccountSession(): Promise<LatchAccountSession | null>;
  clearLatchAccountSession(): Promise<void>;
  /** 铸造推理 Key 成功后记录 id，用于状态摘要判断“是否已有 gateway key”。 */
  saveGatewayKeyId(keyId: string): Promise<void>;
  loadGatewayKeyId(): Promise<string | null>;
}

export function createLatchAccountSessionStore(
  credentialService: ICredentialService,
): LatchAccountSessionStore {
  return {
    async saveLatchAccountSession(session: LatchAccountSession): Promise<void> {
      await credentialService.save(LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY, session.token);
      if (session.email.trim()) {
        await credentialService.save(LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY, session.email.trim());
      } else {
        await credentialService.delete(LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY);
      }
    },

    async loadLatchAccountSession(): Promise<LatchAccountSession | null> {
      const token = await credentialService.load(LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY);
      if (!token) {
        return null;
      }
      const email = (await credentialService.load(LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY)) ?? "";
      return { token, email };
    },

    async clearLatchAccountSession(): Promise<void> {
      // key id 与 token/email 同生命周期：登出即失配，必须一起清掉。
      await credentialService.delete(LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY);
      await credentialService.delete(LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY);
      await credentialService.delete(LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY);
    },

    async saveGatewayKeyId(keyId: string): Promise<void> {
      await credentialService.save(LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY, keyId);
    },

    async loadGatewayKeyId(): Promise<string | null> {
      return credentialService.load(LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY);
    },
  };
}

// Host（node.ts）启动时注入默认凭据服务；Renderer/Web 通过 RPC 拿到 ICredentialService
// 后同样注入。未注入时显式报错，而不是悄悄换一条存储路径。
let defaultCredentialService: ICredentialService | null = null;

export function setLatchAccountCredentialService(service: ICredentialService | null): void {
  defaultCredentialService = service;
}

export interface LatchAccountStoreOptions {
  credentialService?: ICredentialService;
}

export function resolveLatchAccountCredentialService(
  options?: LatchAccountStoreOptions,
): ICredentialService {
  const service = options?.credentialService ?? defaultCredentialService;
  if (!service) {
    throw new Error(
      "Latch account credential service is not configured; call setLatchAccountCredentialService() or pass credentialService explicitly",
    );
  }
  return service;
}

export async function saveLatchAccountSession(
  session: LatchAccountSession,
  options?: LatchAccountStoreOptions,
): Promise<void> {
  await createLatchAccountSessionStore(
    resolveLatchAccountCredentialService(options),
  ).saveLatchAccountSession(session);
}

export async function loadLatchAccountSession(
  options?: LatchAccountStoreOptions,
): Promise<LatchAccountSession | null> {
  return createLatchAccountSessionStore(
    resolveLatchAccountCredentialService(options),
  ).loadLatchAccountSession();
}

export async function clearLatchAccountSession(options?: LatchAccountStoreOptions): Promise<void> {
  await createLatchAccountSessionStore(
    resolveLatchAccountCredentialService(options),
  ).clearLatchAccountSession();
}

export async function loadLatchGatewayKeyId(
  options?: LatchAccountStoreOptions,
): Promise<string | null> {
  return createLatchAccountSessionStore(
    resolveLatchAccountCredentialService(options),
  ).loadGatewayKeyId();
}
