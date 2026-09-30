// 设置页「Latch 账号」分区：展示 gateway customer-api 的登录态摘要
// （email / 套餐 / 余额，来自 latchAccountStatusSummary），提供「管理账单」外链与退出登录。
// 退出只销毁 Latch 账号会话；已接线的 xlaunch-gateway provider 保持原样（key 仍可用）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LATCH_ACCOUNT_MANAGE_URL,
  clearLatchAccountSession,
  invalidateLatchAccountStatusSummary,
  latchAccountStatusSummary,
  latchLogout,
  loadLatchAccountSession,
  resolveLatchAccountManageUrl,
  type LatchAccountStatusSummary,
} from "@zcode/services";
import { ExternalLinkIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { TID_SETTINGS_LATCH_MANAGE_BILLING, TID_SETTINGS_LATCH_SIGN_OUT } from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isLatchIdentityUser } from "@/login/latchAccountIdentity.js";
import { logger } from "@/logger.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/** balanceMicros 是 micro-USD；按 locale 展示成美元，最多保留 4 位小数。 */
function formatLatchBalanceUsd(locale: string, balanceMicros: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(balanceMicros / 1_000_000);
}

function LatchAccountRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-ui-base text-foreground-subtle">{label}</span>
      <span className="min-w-0 truncate text-ui-base font-medium text-foreground">{value}</span>
    </div>
  );
}

export function LatchAccountSection() {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const { credentialService, providerSettingsService } = useServices();
  const user = useZCodeStore((state) => state.user);
  const setUser = useZCodeStore((state) => state.setUser);
  const [summary, setSummary] = useState<LatchAccountStatusSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const refreshSeqRef = useRef(0);

  const loadSummary = useCallback(
    async (options?: { force?: boolean }) => {
      const seq = ++refreshSeqRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const next = await latchAccountStatusSummary({
          credentialService,
          providerSettings: providerSettingsService,
          force: options?.force === true,
        });
        if (refreshSeqRef.current === seq) {
          setSummary(next);
        }
      } catch (error) {
        if (refreshSeqRef.current !== seq) {
          return;
        }
        logger.warn("[Settings] 读取 Latch 账号摘要失败", { error });
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (refreshSeqRef.current === seq) {
          setLoading(false);
        }
      }
    },
    [credentialService, providerSettingsService],
  );

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const manageUrl = useMemo(() => {
    try {
      return resolveLatchAccountManageUrl();
    } catch {
      // LATCH_ACCOUNT_MANAGE_URL 配置了非法值时回落产品默认域，不能让设置分区崩掉。
      return DEFAULT_LATCH_ACCOUNT_MANAGE_URL;
    }
  }, []);

  const handleManageBilling = () => {
    platform.openExternal(manageUrl);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      const session = await loadLatchAccountSession({ credentialService });
      if (session?.token) {
        // latchLogout：远端会话销毁失败也会清掉本地 session，不让用户卡在僵尸登录态。
        await latchLogout(session.token, { credentialService });
      } else {
        await clearLatchAccountSession({ credentialService });
      }
    } catch (error) {
      // latchLogout 已保证本地 session 尽力清除；这里只记录剩余的本地清理失败。
      logger.warn("[Settings] Latch 账号退出登录失败", { error });
    } finally {
      invalidateLatchAccountStatusSummary();
      // 只清理 Latch 自己写入的合成身份；OAuth 登录的 user 不受影响。
      if (isLatchIdentityUser(user)) {
        setUser(null);
      }
      setSigningOut(false);
      void loadSummary({ force: true });
    }
  };

  const planLabel = summary?.plan
    ? intl.formatMessage({ id: `settings.latch.plan.${summary.plan}` })
    : intl.formatMessage({ id: "settings.latch.plan.payAsYouGo" });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.latch.description" })}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void loadSummary({ force: true })}
        >
          {loading ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          {intl.formatMessage({ id: "common.refresh" })}
        </Button>
      </div>

      {loadError ? (
        <Alert variant="warning">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="border border-border bg-card py-0 shadow-none">
        <CardHeader className="border-b border-border">
          <CardTitle>{intl.formatMessage({ id: "settings.latch.cardTitle" })}</CardTitle>
          <CardDescription>
            {summary?.signedIn
              ? intl.formatMessage({ id: "settings.latch.signedIn.description" })
              : intl.formatMessage({ id: "settings.latch.signedOut.description" })}
          </CardDescription>
          {summary?.signedIn ? (
            <CardAction>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={TID_SETTINGS_LATCH_MANAGE_BILLING}
                onClick={handleManageBilling}
              >
                <ExternalLinkIcon className="size-3.5" />
                {intl.formatMessage({ id: "settings.latch.manageBilling" })}
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="px-6 py-4">
          {loading && !summary ? (
            <div className="flex items-center justify-center gap-2 py-6 text-ui-base text-foreground-subtle">
              <Loader2Icon className="size-4 animate-spin" />
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          ) : summary?.signedIn ? (
            <div className="divide-y divide-border">
              <LatchAccountRow
                label={intl.formatMessage({ id: "settings.latch.emailLabel" })}
                value={summary.email ?? ""}
              />
              <LatchAccountRow
                label={intl.formatMessage({ id: "settings.latch.planLabel" })}
                value={planLabel}
              />
              {typeof summary.balanceMicros === "number" ? (
                <LatchAccountRow
                  label={intl.formatMessage({ id: "settings.latch.balanceLabel" })}
                  value={formatLatchBalanceUsd(locale, summary.balanceMicros)}
                />
              ) : null}
              <div className="flex justify-end pt-4">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={TID_SETTINGS_LATCH_SIGN_OUT}
                  disabled={signingOut}
                  onClick={() => void handleSignOut()}
                >
                  {signingOut ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                  {intl.formatMessage({ id: "settings.latch.signOut" })}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.latch.signedOut.hint" })}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
