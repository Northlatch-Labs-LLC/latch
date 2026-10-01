/**
 * ChatErrorBannerLatchGatewayActions —— ChatErrorBanner 里网关配额/鉴权错误的操作按钮组。
 *
 * 订阅门三旅程（分类见 lib/latchGatewayQuotaError.ts）：
 * 402 余额耗尽 / 429 token 上限 → 主 CTA 充值，次 CTA Get Pro（都指向计费入口 seam）；
 * 401 key 失效 → 主 CTA 重新登录 Latch（统一登录入口默认就是 Latch 账号表单），
 * 次 CTA 仍指向计费入口（可在网页端重铸 key）。
 *
 * 目标解析统一走 lib/latchBillingNavigation.ts：桌面 openExternal 账户页，
 * Web 端改应用内 /pricing（未登录先 /signin），外站 window.open 死路已收口。
 */
import { LogInIcon, RocketIcon } from "lucide-react";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { Button } from "./components/ui/button.js";
import { cn } from "./components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { openLatchBillingEntry } from "@/lib/latchBillingNavigation.js";
import type { LatchGatewayQuotaClassification } from "@/lib/latchGatewayQuotaError.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

export function ChatErrorBannerLatchGatewayActions({
  quota,
  actionButtonClassName,
}: {
  quota: LatchGatewayQuotaClassification;
  actionButtonClassName: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);

  // 打开 Latch 计费入口（充值/管理或 Pro 购买）：目标解析在 seam 里按环境分流
  // （桌面 openExternal 账户页；Web 应用内 /pricing 或 /signin）。失败只记日志不打断横幅。
  const openLatchBilling = (intent: "manage" | "purchase") => {
    openLatchBillingEntry({ platform, intent });
  };

  const primaryMessageId =
    quota.kind === "gateway-reauth"
      ? "chat.error.latchGateway.signIn"
      : "chat.error.latchGateway.addCredit";
  const secondaryMessageId =
    quota.kind === "gateway-reauth"
      ? "chat.error.latchGateway.addCredit"
      : "chat.error.latchGateway.getPro";

  return (
    <>
      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={() => {
          if (quota.kind === "gateway-reauth") {
            requestLoginEntry();
            return;
          }
          openLatchBilling("manage");
        }}
        className={cn(
          actionButtonClassName,
          "button-gradient gap-1.5 text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
        )}
        aria-label={intl.formatMessage({ id: primaryMessageId })}
      >
        {quota.kind === "gateway-reauth" ? (
          <LogInIcon className="size-3.5" />
        ) : (
          <RocketIcon className="size-3.5" />
        )}
        {intl.formatMessage({ id: primaryMessageId })}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          if (quota.kind === "gateway-reauth") {
            openLatchBilling("manage");
            return;
          }
          openLatchBilling("purchase");
        }}
        className={cn(actionButtonClassName, "gap-1.5")}
        aria-label={intl.formatMessage({ id: secondaryMessageId })}
      >
        {intl.formatMessage({ id: secondaryMessageId })}
      </Button>
    </>
  );
}
