// 账号状态摘要：本地 session + /me + provider 状态的组合视图。
// 缓存/合并策略对齐 useUsageEntitlement：短 TTL 缓存回显、同 token 合并 in-flight、
// 后台刷新失败时保留上一次成功结果，避免轮询把 UI 打回未登录态。
import type { IProviderSettingsService } from "../model-provider/providerFacadeServices.js";
import { LATCH_GATEWAY_PROVIDER_TEMPLATE_ID } from "./config.js";
import {
  fetchLatchAccountStatus,
  logLatchAccountWarning,
  type LatchAccountRequestOptions,
} from "./latchAccountService.js";
import {
  loadLatchAccountSession,
  loadLatchGatewayKeyId,
  type LatchAccountStoreOptions,
} from "./latchAccountSession.js";
import type { LatchAccountPlanId, LatchAccountSession } from "./latchAccountTypes.js";

/** 账号状态摘要：session + /me + provider 状态的组合视图，供侧栏/设置轮询。 */
export interface LatchAccountStatusSummary {
  signedIn: boolean;
  email?: string;
  plan?: LatchAccountPlanId;
  balanceMicros?: number;
  billingEnabled?: boolean;
  hasGatewayKey: boolean;
}

export interface LatchAccountStatusSummaryOptions
  extends LatchAccountRequestOptions, LatchAccountStoreOptions {
  /** 缺省时读本地 session；无 session 直接返回未登录，不打网络。 */
  session?: LatchAccountSession | null;
  providerSettings?: Pick<IProviderSettingsService, "getView">;
  force?: boolean;
  maxAgeMs?: number;
}

const LATCH_ACCOUNT_STATUS_SUMMARY_TTL_MS = 60_000;

interface LatchAccountSummaryCacheEntry {
  at: number;
  summary: LatchAccountStatusSummary;
}

const summaryCache = new Map<string, LatchAccountSummaryCacheEntry>();
const summaryInflight = new Map<string, Promise<LatchAccountStatusSummary>>();

/** 铸造/吊销 key、登出后调用，避免轮询拿到过期摘要。 */
export function invalidateLatchAccountStatusSummary(token?: string): void {
  if (token === undefined) {
    summaryCache.clear();
    summaryInflight.clear();
    return;
  }
  summaryCache.delete(token);
  summaryInflight.delete(token);
}

async function resolveHasGatewayKey(options: LatchAccountStatusSummaryOptions): Promise<boolean> {
  try {
    const storedKeyId = await loadLatchGatewayKeyId(options);
    if (storedKeyId) {
      return true;
    }
  } catch {
    // 凭据服务未注入时只能依赖 provider 视图判断，不让状态摘要直接失败。
  }
  if (!options.providerSettings) {
    return false;
  }
  try {
    const view = await options.providerSettings.getView();
    return view.providers.some(
      (provider) => provider.templateId === LATCH_GATEWAY_PROVIDER_TEMPLATE_ID,
    );
  } catch (error) {
    logLatchAccountWarning("provider settings view read failed", error);
    return false;
  }
}

async function buildLatchAccountStatusSummary(
  session: LatchAccountSession,
  options: LatchAccountStatusSummaryOptions,
): Promise<LatchAccountStatusSummary> {
  const status = await fetchLatchAccountStatus(session.token, options);
  return {
    signedIn: true,
    email: status.email || session.email || undefined,
    ...(status.plan ? { plan: status.plan.plan } : {}),
    balanceMicros: status.balanceMicros,
    billingEnabled: status.billingEnabled,
    hasGatewayKey: await resolveHasGatewayKey(options),
  };
}

export async function latchAccountStatusSummary(
  options: LatchAccountStatusSummaryOptions = {},
): Promise<LatchAccountStatusSummary> {
  const session =
    options.session !== undefined
      ? options.session
      : await loadLatchAccountSession(options).catch(() => null);
  if (!session?.token) {
    return { signedIn: false, hasGatewayKey: false };
  }

  const cacheKey = session.token;
  const maxAgeMs = options.maxAgeMs ?? LATCH_ACCOUNT_STATUS_SUMMARY_TTL_MS;
  if (options.force !== true) {
    const cached = summaryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < maxAgeMs) {
      return cached.summary;
    }
    const inflight = summaryInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }
  }

  const request = buildLatchAccountStatusSummary(session, options).then(
    (summary) => {
      summaryCache.set(cacheKey, { at: Date.now(), summary });
      return summary;
    },
    (error: unknown) => {
      // 刷新失败时降级返回旧摘要，只对无缓存的真实错误抛出。
      const cached = summaryCache.get(cacheKey);
      if (cached) {
        return cached.summary;
      }
      throw error;
    },
  );
  summaryInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (summaryInflight.get(cacheKey) === request) {
      summaryInflight.delete(cacheKey);
    }
  }
}
