// `latch login/logout/whoami` 的 Latch 账号主流程：customer-api 登录 → 保存会话 →
// 铸造 gateway 推理 Key → 把 Key 接进 ~/.latch/v2/provider_config.json（bootstrap 的
// latch-gateway-provider，与 persistStandaloneCodingPlanConnection 同一条持久化路径）。
// 密码只进 HTTPS 请求体与本地变量：不写日志、不进凭据文件、不回显终端。
import { createSharedZCodeCredentialStore } from "@zcode/adapters/auth";
import type { RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { CliEnv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
  LATCH_MIN_PASSWORD_LENGTH,
  LatchAccountError,
  fetchLatchAccountStatus,
  isValidLatchEmail,
  isValidLatchPassword,
  latchLogout,
  latchSignIn,
  loadLatchAccountSession,
  loadLatchGatewayKeyId,
  logLatchAccountWarning,
  mintLatchGatewayKey,
  revokeLatchKey,
  saveLatchAccountSession,
  invalidateLatchAccountStatusSummary,
  resolveLatchAccountApiBaseUrl,
  resolveLatchAccountManageUrl,
  type ICredentialService,
  type LatchAccountStatus,
} from "@zcode/services/latch-account";

/** CLI 侧铸造的 gateway key 名称；与桌面端 'Latch CLI' 语义一致，便于在 /keys 里辨认。 */
export const LATCH_CLI_GATEWAY_KEY_NAME = "Latch CLI";

/**
 * CLI 的 Latch 会话存储：复用 SharedZCodeCredentialStore（~/.latch/v2/credentials.json，
 * 与 zai/bigmodel OAuth 凭据同一加密文件），只暴露 ICredentialService 三个方法。
 */
export function createCliLatchCredentialService(env: CliEnv): ICredentialService {
  const store = createSharedZCodeCredentialStore({ env });
  return {
    load: (key) => store.load(key),
    save: (key, value) => store.save(key, value),
    delete: (key) => store.delete(key),
  };
}

export interface LatchAccountCredentials {
  email: string;
  password: string;
}

/** 终端收集 email + 密码；密码走丢弃型 output，任何字符都不回显。 */
export async function promptLatchAccountCredentials(
  ctx: RunContext,
): Promise<LatchAccountCredentials> {
  const email = (await askVisibleQuestion(ctx, "Latch account email: ")).trim();
  const password = await askHiddenQuestion(ctx, "Latch account password: ");
  return { email, password };
}

function askVisibleQuestion(ctx: RunContext, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: ctx.stdin,
      output: ctx.stdout,
      terminal: ctx.stdin.isTTY === true,
    });
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("Cancelled."));
      return;
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function askHiddenQuestion(ctx: RunContext, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // terminal 模式下 readline 的回显全部经过 output；换成只丢弃的 output 后，
    // 输入的密码字符不会出现在任何流里。提示语直接写真实 stdout。
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = createInterface({
      input: ctx.stdin,
      output: sink,
      terminal: ctx.stdin.isTTY === true,
    });
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("Cancelled."));
      return;
    });
    ctx.stdout.write(question);
    rl.question("", (answer) => {
      rl.close();
      // 隐藏输入没有回车换行；补一个换行让后续输出不粘在提示语后面。
      ctx.stdout.write("\n");
      resolve(answer);
    });
  });
}

export interface LatchAccountLoginOutcome {
  readonly email: string;
  readonly keyId: number;
  readonly maskedKey: string;
  readonly gatewayUrl: string;
  readonly manageUrl: string;
  readonly providerId: string;
  readonly model: string;
  readonly configPath: string;
  readonly credentialsPath: string;
}

export function maskLatchGatewayKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}…`;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

/** 校验后登录 customer-api；密码只传给 latchSignIn 的请求体。 */
export async function signInLatchAccount(
  credentials: LatchAccountCredentials,
  env: CliEnv,
): Promise<{ token: string; email: string }> {
  const email = credentials.email.trim();
  if (!isValidLatchEmail(email)) {
    throw new LatchAccountError("validation", "A valid email address is required");
  }
  if (!isValidLatchPassword(credentials.password)) {
    throw new LatchAccountError(
      "validation",
      `A password of at least ${String(LATCH_MIN_PASSWORD_LENGTH)} characters is required`,
    );
  }
  return latchSignIn(email, credentials.password, { env });
}

/** 高级用法：非交互脚本经 LATCH_ACCOUNT_SESSION_TOKEN 注入会话 token，用 /me 补齐 email 并顺带校验有效性。 */
export async function resolveLatchAccountTokenSession(
  token: string,
  env: CliEnv,
): Promise<{ token: string; email: string }> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new LatchAccountError("validation", "A Latch account session token is required");
  }
  const status = await fetchLatchAccountStatus(trimmed, { env });
  return { token: trimmed, email: status.email };
}

/** 登录成功后的公共落地：保存会话 → 铸 Key → 接进 provider_config.json。 */
export async function completeLatchAccountLogin(input: {
  readonly token: string;
  readonly email: string;
  readonly env: CliEnv;
  readonly deps: RunDependencies;
}): Promise<LatchAccountLoginOutcome> {
  const credentialService = createCliLatchCredentialService(input.env);
  await saveLatchAccountSession({ token: input.token, email: input.email }, { credentialService });
  const minted = await mintLatchGatewayKey(input.token, LATCH_CLI_GATEWAY_KEY_NAME, {
    env: input.env,
    credentialService,
  });
  const configure =
    input.deps.configureLatchGatewayProvider ??
    (await loadBootstrapModule()).configureLatchGatewayProvider;
  const connection = await configure(minted.key, { env: input.env });
  invalidateLatchAccountStatusSummary(input.token);
  return {
    email: input.email,
    keyId: minted.id,
    maskedKey: maskLatchGatewayKey(minted.key),
    gatewayUrl: resolveLatchAccountApiBaseUrl(input.env),
    manageUrl: resolveLatchAccountManageUrl(input.env),
    providerId: connection.providerId,
    model: `${connection.providerId}/${connection.modelId}`,
    configPath: connection.configPath,
    credentialsPath: createSharedZCodeCredentialStore({ env: input.env }).filePath,
  };
}

export interface LatchAccountLogoutOutcome {
  readonly credentialsPath: string;
  readonly hadSession: boolean;
  readonly revokedKeyId: string | null;
  readonly removedProviderIds: readonly string[];
}

/**
 * Latch 账号登出：先吊销本 CLI 铸造的 gateway key（网络失败仅告警），再 POST /logout
 * 并清本地会话（clearLatchAccountSession 同步清 key id），最后移除 provider_config.json
 * 里的 gateway personal provider——与 logoutZCodeCli 只清本地凭据的口径一致。
 */
export async function logoutLatchAccount(
  env: CliEnv,
  deps: RunDependencies,
): Promise<LatchAccountLogoutOutcome> {
  const credentialService = createCliLatchCredentialService(env);
  const session = await loadLatchAccountSession({ credentialService });
  let revokedKeyId: string | null = null;
  if (session) {
    const keyId = await loadLatchGatewayKeyId({ credentialService });
    if (keyId) {
      try {
        await revokeLatchKey(session.token, keyId, { env });
        revokedKeyId = keyId;
      } catch (error) {
        // 吊销失败不能把用户困在“已删本地、线上仍有效”的半态；告警后继续本地清理。
        logLatchAccountWarning(`failed to revoke gateway key #${keyId}`, error);
      }
    }
    try {
      await latchLogout(session.token, { env, credentialService });
    } catch (error) {
      logLatchAccountWarning("gateway logout failed; local session cleared where possible", error);
    }
    invalidateLatchAccountStatusSummary();
  }
  const removeProviders =
    deps.removeLatchGatewayProviders ?? (await loadBootstrapModule()).removeLatchGatewayProviders;
  const removal = await removeProviders({ env });
  return {
    credentialsPath: createSharedZCodeCredentialStore({ env }).filePath,
    hadSession: Boolean(session),
    revokedKeyId,
    removedProviderIds: removal.removedProviderIds,
  };
}

export type LatchAccountWhoami =
  | { readonly signedIn: false }
  | {
      readonly signedIn: true;
      readonly email: string;
      readonly plan: string;
      readonly balanceMicros: number;
      readonly billingEnabled: boolean;
    };

/** whoami：本地会话 + /me 快照；会话失效按未登录呈现，不抛错。 */
export async function readLatchAccountWhoami(env: CliEnv): Promise<LatchAccountWhoami> {
  const credentialService = createCliLatchCredentialService(env);
  const session = await loadLatchAccountSession({ credentialService });
  if (!session) return { signedIn: false };
  let status: LatchAccountStatus;
  try {
    status = await fetchLatchAccountStatus(session.token, { env });
  } catch (error) {
    if (error instanceof LatchAccountError && error.kind === "unauthorized") {
      return { signedIn: false };
    }
    throw error;
  }
  return {
    signedIn: true,
    email: status.email || session.email,
    plan: status.plan ? status.plan.plan : "pay-as-you-go",
    balanceMicros: status.balanceMicros,
    billingEnabled: status.billingEnabled,
  };
}

/** 统一错误出口：只携带 message，绝不携带密码/token。 */
export function formatLatchAccountError(error: unknown): string {
  if (error instanceof LatchAccountError) {
    const retry =
      error.kind === "rate_limited" && typeof error.retryAfterMs === "number"
        ? ` Retry after ${Math.ceil(error.retryAfterMs / 1000)}s.`
        : "";
    return `${error.message}${retry}`;
  }
  return error instanceof Error ? error.message : String(error);
}
