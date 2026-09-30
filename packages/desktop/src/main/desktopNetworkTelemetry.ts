/* eslint-disable max-lines -- 网络指标采集/聚合 */
import { mapZCodeEnvToArmsRumEnv } from "@zcode/shared";
import type { NetworkObservation } from "@zcode/rpc";
import {
  flushInterfaceNetworkStats,
  recordNetworkObservation,
  resetNetworkTelemetryAggregator,
  type InterfaceNetworkStats,
} from "./networkTelemetryAggregator.js";
import { desktopRuntimeEnv } from "./desktopRuntimeEnv.js";

/** 与资源指标对齐：开发 1min、生产 5min 聚合上报 */
const NETWORK_REPORT_INTERVAL_MS = desktopRuntimeEnv === "development" ? 60_000 : 300_000;

interface NetworkLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface NetworkGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

let globalContext: NetworkGlobalContext | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;

function reportNetworkCustom(
  name: string,
  metricValue: number,
  properties: Record<string, string | number | boolean | undefined>,
): void {
  if (!globalContext) {
    return;
  }

  // ARMS RUM SDK 已移除：聚合窗口仍按周期排空（保持 aggregator 状态与日志节奏），
  // 指标不再外发。保留 name/metricValue/properties 形参以维持调用点与日志语义不变。
  void name;
  void metricValue;
  void properties;
}

function reportInterfaceStats(stats: InterfaceNetworkStats): void {
  reportNetworkCustom("perf_network_window", stats.duration.mean, {
    transport: stats.transport,
    interface: stats.interface,
    request_total: stats.requestTotal,
    success_count: stats.successCount,
    fail_count: stats.failCount,
    retry_count: stats.retryCount,
    // value 已表达 duration mean；阶段耗时只保留 mean，给 counts 与主错误归因留固定预算。
    duration_ms_peak: stats.duration.peak,
    duration_ms_p95: stats.duration.p95,
    duration_ms_sample_count: stats.duration.sample_count,
    ...(stats.dns.sample_count > 0 ? { dns_ms_mean: stats.dns.mean } : {}),
    ...(stats.tcp.sample_count > 0 ? { tcp_ms_mean: stats.tcp.mean } : {}),
    ...(stats.tls.sample_count > 0 ? { tls_ms_mean: stats.tls.mean } : {}),
    ...(stats.ttfb.sample_count > 0 ? { ttfb_ms_mean: stats.ttfb.mean } : {}),
    ...(stats.download.sample_count > 0 ? { download_ms_mean: stats.download.mean } : {}),
    ...(stats.primaryErrorKind
      ? {
          primary_error_kind: stats.primaryErrorKind,
          primary_error_count: stats.primaryErrorCount,
        }
      : {}),
  });
}

function flushNetworkReports(logger: NetworkLogger): void {
  const stats = flushInterfaceNetworkStats();
  if (stats.length === 0) {
    return;
  }

  for (const item of stats) {
    reportInterfaceStats(item);
  }

  logger.info(`[network] perf_network flushed interfaces=${stats.length}`);
}

export function ingestHostNetworkObservations(observations: NetworkObservation[]): void {
  for (const observation of observations) {
    recordNetworkObservation(observation);
  }
}

export function configureDesktopNetworkTelemetry(context: NetworkGlobalContext): void {
  // ARMS RUM SDK 已移除：仅保留 context 记录，供采集链路判定启用状态。
  globalContext = context;
}

export function registerDesktopNetworkTelemetry(logger: NetworkLogger): void {
  stopDesktopNetworkTelemetry();
  resetNetworkTelemetryAggregator();

  reportTimer = setInterval(() => {
    try {
      flushNetworkReports(logger);
    } catch (error) {
      logger.warn("[network] report failed:", error);
    }
  }, NETWORK_REPORT_INTERVAL_MS);

  logger.info(`[network] reporting started interval=${NETWORK_REPORT_INTERVAL_MS}ms`);
}

export function stopDesktopNetworkTelemetry(): void {
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
}
