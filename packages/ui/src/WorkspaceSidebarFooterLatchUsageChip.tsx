/**
 * WorkspaceSidebarFooterLatchUsageChip —— 侧栏 footer 的 Latch 套餐 + 余额 chip。
 *
 * 数据来自 latchAccountStatusSummary()（hooks/useLatchAccountStatusSummary，
 * 刷新策略对齐 useUsageEntitlement）；未登录（无本地 session）时整体不渲染，
 * 与 WorkspaceSidebarFooterPlanBadge 的 chip 视觉保持同一套样式。
 * 余额是预付余额（/me 的 balanceMicros，整数 micro-USD），不是用量。
 */
import type { LatchAccountPlanId, LatchAccountStatusSummary } from "@zcode/services";
import { TID_SIDEBAR_LATCH_USAGE_CHIP } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useLatchAccountStatusSummary } from "@/hooks/useLatchAccountStatusSummary.js";

/** 余额展示：≥$0.01 保留两位小数；正但不足一分钱时显示 <$0.01，避免被舍入成“已耗尽”。 */
export function formatLatchBalanceUsd(balanceMicros: number): string {
  const usd = balanceMicros / 1_000_000;
  if (usd > 0 && usd < 0.01) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}

function latchPlanLabelId(plan: LatchAccountPlanId | undefined): string {
  switch (plan) {
    case "pro":
      return "sidebar.usage.latch.plan.pro";
    case "team":
      return "sidebar.usage.latch.plan.team";
    default:
      // plan 为 null 是“按量付费”的真实状态（gateway planFor），不是缺数据。
      return "sidebar.usage.latch.plan.free";
  }
}

export function WorkspaceSidebarFooterLatchUsageChip({ enabled = true }: { enabled?: boolean }) {
  const { intl } = useZCodeIntl();
  const { summary } = useLatchAccountStatusSummary({ enabled });
  // 未登录不渲染：签名态由摘要携带，凭据服务未注入时摘要拿不到 session 同样为空。
  if (!summary?.signedIn || typeof summary.balanceMicros !== "number") {
    return null;
  }
  const planLabel = intl.formatMessage({ id: latchPlanLabelId(summary.plan) });
  const balanceLabel = formatLatchBalanceUsd(summary.balanceMicros);
  const chipLabel = `${planLabel} · ${balanceLabel}`;
  const title = summary.email
    ? intl.formatMessage(
        { id: "sidebar.usage.latch.balanceTitleWithEmail" },
        { balance: balanceLabel, email: summary.email },
      )
    : intl.formatMessage({ id: "sidebar.usage.latch.balanceTitle" }, { balance: balanceLabel });

  return (
    <span
      data-testid={TID_SIDEBAR_LATCH_USAGE_CHIP}
      data-latch-plan={summary.plan ?? "free"}
      className="min-w-0 max-w-28 shrink truncate rounded-full border border-border bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle"
      title={title}
    >
      {chipLabel}
    </span>
  );
}

/** 供测试/其他入口复用的纯投影：摘要 → chip 文案。 */
export function resolveLatchUsageChipLabels(
  summary: LatchAccountStatusSummary,
  formatMessage: (id: string, values?: Record<string, string>) => string,
): { planLabel: string; balanceLabel: string } {
  return {
    // 这里的 formatMessage 是 (id, values?) => string 的纯投影签名，不是 intl 的描述符对象。
    planLabel: formatMessage(latchPlanLabelId(summary.plan)),
    balanceLabel: formatLatchBalanceUsd(summary.balanceMicros ?? 0),
  };
}
