/**
 * ChatErrorBannerLatchGatewayActions —— ChatErrorBanner 里网关配额/鉴权错误的操作按钮组。
 *
 * 订阅门三旅程（分类见 lib/latchGatewayQuotaError.ts）：
 * 402 余额耗尽 / 429 token 上限 → 主 CTA 充值（账户页），次 CTA Get Pro（购买页）；
 * 401 key 失效 → 主 CTA 重新登录 Latch（统一登录入口默认就是 Latch 账号表单），
 * 次 CTA 仍指向账户页（可在网页端重铸 key）。
 */
import { resolveLatchAccountManageUrl, resolveLatchAccountPurchaseUrl } from "@zcode/services";
import { LogInIcon, RocketIcon } from "lucide-react";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { Button } from "./components/ui/button.js";
import { cn } from "./components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
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

  // 打开网关账户页（充值/管理）或 Pro 购买页；URL 来自 services 的 env 解析器，
  // 默认 https://xlaunch.work/account 与 ?plan=pro。环境变量配错时只记日志不打断横幅。
  const openLatchAccountUrl = (resolve: () => string) => {
    if (!platform) {
      logger.warn("[ChatErrorBanner] platform 不可用，无法打开 Latch 账户页");
      return;
    }
    try {
      platform.openExternal(resolve());
    } catch (error) {
      logger.warn("[ChatErrorBanner] 解析 Latch 账户页地址失败", { error });
    }
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
          openLatchAccountUrl(resolveLatchAccountManageUrl);
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
            openLatchAccountUrl(resolveLatchAccountManageUrl);
            return;
          }
          openLatchAccountUrl(resolveLatchAccountPurchaseUrl);
        }}
        className={cn(actionButtonClassName, "gap-1.5")}
        aria-label={intl.formatMessage({ id: secondaryMessageId })}
      >
        {intl.formatMessage({ id: secondaryMessageId })}
      </Button>
    </>
  );
}
