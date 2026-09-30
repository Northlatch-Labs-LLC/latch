/**
 * useLatchAccountStatusSummary —— 侧栏 plan/余额 chip 的数据源。
 *
 * 刷新策略对齐 useUsageEntitlement 的约定（hooks/useUsageEntitlement.ts）：
 * - 静默后台刷新：有缓存先回显、不打 loading（latchAccountStatusSummary 自带
 *   60s TTL 缓存 + 同 token in-flight 合并 + 失败回退上次成功摘要，见
 *   services latchAccountStatusSummary.ts）；
 * - 一分钟 freshness window：轮询间隔与服务的 TTL 一致，重复挂载不放大 /me 请求；
 * - 失败降级：刷新出错保留上一次成功摘要，未登录态（signedIn:false）只清空 chip。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  latchAccountStatusSummary,
  type ICredentialService,
  type LatchAccountStatusSummary,
  type LatchAccountStatusSummaryOptions,
} from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/** 与 services 侧 LATCH_ACCOUNT_STATUS_SUMMARY_TTL_MS 对齐的轮询间隔。 */
const LATCH_ACCOUNT_SUMMARY_POLL_MS = 60_000;

interface UseLatchAccountStatusSummaryOptions {
  /** 轮询开关（侧栏不可见时可停）。 */
  enabled?: boolean;
  /** 覆盖凭据服务；缺省用当前 workspace services 的 credentialService。 */
  credentialService?: ICredentialService;
  /** 测试注入轮询间隔。 */
  pollMs?: number;
}

interface LatchAccountSummaryState {
  summary: LatchAccountStatusSummary | null;
  loading: boolean;
}

const INITIAL_STATE: LatchAccountSummaryState = { summary: null, loading: false };

export function useLatchAccountStatusSummary(options: UseLatchAccountStatusSummaryOptions = {}) {
  const services = useOptionalServices();
  const credentialService = options.credentialService ?? services?.credentialService;
  const enabled = options.enabled ?? true;
  const pollMs = options.pollMs ?? LATCH_ACCOUNT_SUMMARY_POLL_MS;
  const [state, setState] = useState<LatchAccountSummaryState>(INITIAL_STATE);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(
    async (refreshOptions?: { force?: boolean }) => {
      if (!enabled) {
        return;
      }
      const requestOptions: LatchAccountStatusSummaryOptions = {
        ...(credentialService ? { credentialService } : {}),
        ...(services?.providerSettingsService
          ? { providerSettings: services.providerSettingsService }
          : {}),
        ...(refreshOptions?.force === true ? { force: true } : {}),
      };
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;
      try {
        const summary = await latchAccountStatusSummary(requestOptions);
        if (requestSeqRef.current !== requestSeq) {
          return;
        }
        setState({
          // 未登录摘要只表示“没有本地 session”，不携带余额/套餐，chip 直接隐藏。
          summary: summary.signedIn ? summary : null,
          loading: false,
        });
      } catch (error) {
        if (requestSeqRef.current !== requestSeq) {
          return;
        }
        // 刷新失败保留上一次成功摘要（与 useUsageEntitlement 的后台失败策略一致）。
        logger.warn("[useLatchAccountStatusSummary] 刷新 Latch 账号摘要失败", { error });
        setState((current) => ({ ...current, loading: false }));
      }
    },
    [credentialService, enabled, services?.providerSettingsService],
  );

  useEffect(() => {
    if (!enabled) {
      // 关闭轮询时清空摘要，避免换环境后显示上一个账号的余额。
      setState(INITIAL_STATE);
      return;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  return {
    summary: state.summary,
    loading: state.loading,
    refresh,
  };
}
