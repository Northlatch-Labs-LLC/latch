// Latch 套餐页（第一方订阅入口，路由 /pricing）：套餐卡 + Stripe hosted Checkout 跳转。
// 数据/契约见 latchBillingClient.ts；会话沿用 /signin 的浏览器本地 Latch 会话
// （browserLatchAccountRepo）。设计要点：
//   - 未登录：只给 "先去登录" CTA（/signin?return_to=/pricing…），登录后回跳原样续流程；
//   - 已登录：点订阅 → POST /api/latch-billing/checkout（Bearer 会话 token）→ 整页跳转
//     返回的 Stripe url；401 清掉过期会话回到登录提示；
//   - ?checkout=success|cancelled：展示结果横幅，并经代理重打 /api/latch-account/me
//     刷新账号状态（余额/套餐）；
//   - ?plan=<id>（来自计费 seam 的 "选好套餐直达 checkout" 路径）：登录态下自动发起结账。
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, RocketIcon } from "lucide-react";
import { Button } from "@zcode/ui";
import {
  LatchAccountError,
  type LatchAccountSession,
  type LatchAccountStatus,
} from "@zcode/services";
import { BrowserLatchAccountRepo } from "../auth/browserLatchAccountRepo.js";
import { resolveLocale } from "../auth/latchSignInCopy.js";
import { latchWebAccountStatus } from "../auth/latchAccountProxyClient.js";
import {
  FALLBACK_LATCH_BILLING_CONFIG,
  LatchBillingCheckoutError,
  createLatchBillingCheckout,
  fetchLatchBillingConfig,
  type LatchBillingConfig,
  type LatchBillingPlanId,
} from "./latchBillingClient.js";
import { getLatchPricingCopy } from "./latchPricingCopy.js";

function isLatchBillingPlanId(value: string | null): value is LatchBillingPlanId {
  return value === "latch-monthly" || value === "latch-yearly";
}

function isLatchCheckoutOutcome(value: string | null): value is "success" | "cancelled" {
  return value === "success" || value === "cancelled";
}

function formatPlanPrice(locale: string, priceUsd: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(priceUsd);
}

/** balanceMicros 是 micro-USD；与设置页 LatchAccountSection 同一格式。 */
function formatBalanceUsd(locale: string, balanceMicros: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(balanceMicros / 1_000_000);
}

export function LatchPricingPage() {
  const locale = resolveLocale();
  const copy = getLatchPricingCopy(locale);
  const repoRef = useRef(new BrowserLatchAccountRepo());
  const autoCheckoutStartedRef = useRef(false);

  const [config, setConfig] = useState<LatchBillingConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const [session, setSession] = useState<LatchAccountSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [accountStatus, setAccountStatus] = useState<LatchAccountStatus | null>(null);
  const [outcome, setOutcome] = useState<"success" | "cancelled" | null>(null);
  const [pendingPlan, setPendingPlan] = useState<LatchBillingPlanId | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  // ?plan= 只在首帧解析一次：后续导航/回跳不再重复触发自动结账。
  const [autoPlan] = useState<LatchBillingPlanId | null>(() => {
    const plan = new URLSearchParams(window.location.search).get("plan");
    return isLatchBillingPlanId(plan) ? plan : null;
  });

  // 会话与账号状态：每次进页都重打 /me（含 ?checkout= 回跳后的状态刷新）；401 清过期会话。
  useEffect(() => {
    const checkout = new URLSearchParams(window.location.search).get("checkout");
    setOutcome(isLatchCheckoutOutcome(checkout) ? checkout : null);
    // 支付成功不让用户停在套餐页：短暂展示成功横幅后直接回工作区继续干活。
    if (checkout === "success") {
      const redirect = window.setTimeout(() => window.location.assign("/"), 6000);
      return () => window.clearTimeout(redirect);
    }
    const stored = repoRef.current.loadSession();
    setSession(stored);
    setSessionChecked(true);
    if (!stored) {
      return;
    }
    let cancelled = false;
    latchWebAccountStatus(stored.token)
      .then((status) => {
        if (!cancelled) {
          setAccountStatus(status);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof LatchAccountError && error.kind === "unauthorized") {
          repoRef.current.clearSession();
          setSession(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 套餐面：服务端 /api/latch-billing/config 为准；拉取失败回落契约默认套餐，
  // 保证 CTA 与结算入口不因一次 config 抖动整个不可用。
  useEffect(() => {
    let cancelled = false;
    fetchLatchBillingConfig()
      .then((next) => {
        if (!cancelled) {
          setConfig(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfig(FALLBACK_LATCH_BILLING_CONFIG);
          setConfigError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startCheckout = useCallback(
    async (planId: LatchBillingPlanId, activeSession: LatchAccountSession): Promise<void> => {
      setPendingPlan(planId);
      setPlanError(null);
      try {
        const { url } = await createLatchBillingCheckout(planId, activeSession.token);
        // Stripe hosted Checkout：整页离开，成功/取消由 /pricing?checkout=… 接住。
        window.location.assign(url);
      } catch (error: unknown) {
        if (error instanceof LatchBillingCheckoutError) {
          if (error.kind === "unauthorized") {
            repoRef.current.clearSession();
            setSession(null);
          }
          setPlanError(
            error.kind === "unauthorized"
              ? copy.errorUnauthorized
              : error.kind === "unknown_plan"
                ? copy.errorUnknownPlan
                : error.kind === "network"
                  ? copy.errorNetwork
                  : copy.errorServer,
          );
        } else {
          setPlanError(copy.errorServer);
        }
      } finally {
        setPendingPlan(null);
      }
    },
    [copy],
  );

  // ?plan= 自动结账：会话与套餐面就绪后发起一次；未登录时不自动跳，
  // 登录 CTA 的 return_to 会带上 plan 参数，登录回来接着走这一步。
  useEffect(() => {
    if (autoCheckoutStartedRef.current || !autoPlan || !sessionChecked || !config) {
      return;
    }
    if (!session) {
      autoCheckoutStartedRef.current = true;
      return;
    }
    autoCheckoutStartedRef.current = true;
    void startCheckout(autoPlan, session);
  }, [autoPlan, config, session, sessionChecked, startCheckout]);

  const signInTarget = `/signin?return_to=${encodeURIComponent(
    `${window.location.pathname}${autoPlan ? `?plan=${autoPlan}` : window.location.search}`,
  )}`;

  const plans = config?.plans ?? [];
  const note = config?.note?.trim() ? config.note : copy.defaultNote;

  return (
    <main className="flex min-h-dvh items-start justify-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-2xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-ui-xl font-medium text-brand">{copy.title}</h1>
          <p className="text-ui-sm leading-6 text-foreground-subtle">{copy.subtitle}</p>
        </header>

        {outcome ? (
          <div
            className="space-y-3 rounded-lg border border-border bg-surface px-4 py-3 text-ui-sm leading-6"
            role="status"
          >
            <p className="font-medium text-foreground">
              {outcome === "success" ? copy.outcomeSuccessTitle : copy.outcomeCancelledTitle}
            </p>
            <p className="text-foreground-subtle">
              {outcome === "success" ? copy.outcomeSuccessBody : copy.outcomeCancelledBody}
            </p>
            {outcome === "success" ? (
              <Button
                type="button"
                size="sm"
                onClick={() => window.location.assign("/")}
              >
                {copy.outcomeSuccessContinueCta}
              </Button>
            ) : null}
          </div>
        ) : null}

        {configError ? (
          <p className="text-ui-xs text-foreground-subtle" role="alert">
            {copy.errorConfig}
          </p>
        ) : null}

        {sessionChecked && !session ? (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-card-border bg-card px-4 py-3">
            <p className="text-ui-sm text-foreground-subtle">{copy.signInPrompt}</p>
            <Button type="button" size="sm" onClick={() => window.location.assign(signInTarget)}>
              {copy.signInCta}
            </Button>
          </div>
        ) : null}

        {session ? (
          <div className="space-y-1 rounded-lg border border-card-border bg-card px-4 py-3 text-ui-sm">
            <p className="text-foreground-subtle">
              {copy.signedInAs} <span className="break-all text-foreground">{session.email}</span>
            </p>
            {accountStatus ? (
              <p className="text-foreground-subtle">
                {copy.balanceLabel}{" "}
                <span className="text-foreground">
                  {formatBalanceUsd(locale, accountStatus.balanceMicros)}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        {planError ? (
          <div
            className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-sm leading-6 text-foreground-subtle"
            role="alert"
          >
            {planError}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {plans.map((plan) => {
            const pending = pendingPlan === plan.id;
            return (
              <div
                key={plan.id}
                className="flex flex-col gap-3 rounded-xl border border-card-border bg-card p-5"
              >
                <h2 className="text-ui-lg font-medium text-foreground">{plan.label}</h2>
                <p className="text-foreground">
                  <span className="text-ui-xl font-semibold">
                    {formatPlanPrice(locale, plan.priceUsd)}
                  </span>
                  <span className="text-ui-sm text-foreground-subtle">
                    {plan.interval === "month" ? copy.intervalMonthSuffix : copy.intervalYearSuffix}
                  </span>
                </p>
                <p className="text-ui-xs leading-5 text-foreground-subtle">
                  {copy.planCreditIncludes.replace(
                    "{amount}",
                    formatPlanPrice(locale, plan.priceUsd),
                  )}
                </p>
                {session ? (
                  <Button
                    type="button"
                    size="lg"
                    className="mt-auto w-full"
                    disabled={pendingPlan !== null}
                    onClick={() => void startCheckout(plan.id, session)}
                  >
                    {pending ? (
                      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <RocketIcon className="size-4" aria-hidden="true" />
                    )}
                    {pending ? copy.checkoutStarting : copy.subscribeCta}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    className="mt-auto w-full"
                    onClick={() => window.location.assign(signInTarget)}
                  >
                    {copy.signInCta}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-ui-xs leading-5 text-foreground-subtle">{note}</p>
      </section>
    </main>
  );
}
