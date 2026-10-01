// Latch plans page (first-party subscription entry, route /pricing): plan
// cards + Stripe hosted Checkout redirect.
// Data/contract in latchBillingClient.ts; the session is the browser-local
// Latch session from /signin (browserLatchAccountRepo). Design notes:
//   - Signed out: only a "sign in first" CTA (/signin?return_to=/pricing…);
//     after login the flow resumes from the same spot.
//   - Signed in: subscribe -> POST /api/latch-billing/checkout (Bearer
//     session token) -> full-page redirect to the returned Stripe url; 401
//     clears the stale session and falls back to the sign-in prompt;
//   - ?checkout=success|cancelled: shows an outcome banner and re-fetches
//     /api/latch-account/me through the proxy to refresh account state
//     (balance/plan);
//   - ?plan=<id> (the billing seam's "plan chosen, straight to checkout"
//     path): starts checkout automatically when signed in.
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

/** balanceMicros is micro-USD; same format as the settings page's LatchAccountSection. */
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
  // ?plan= is parsed once on the first frame: later navigation/redirects do
  // not retrigger the auto-checkout.
  const [autoPlan] = useState<LatchBillingPlanId | null>(() => {
    const plan = new URLSearchParams(window.location.search).get("plan");
    return isLatchBillingPlanId(plan) ? plan : null;
  });

  // Session + account status: /me is re-fetched on every page entry
  // (including the state refresh after a ?checkout= redirect); 401 clears
  // the stale session.
  useEffect(() => {
    const checkout = new URLSearchParams(window.location.search).get("checkout");
    setOutcome(isLatchCheckoutOutcome(checkout) ? checkout : null);
    // A successful payment must not strand the user on the pricing page:
    // show the success banner briefly, then return to the workspace.
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

  // Plan surface: the server's /api/latch-billing/config is the source of
  // truth; on fetch failure fall back to the contract's default plans so a
  // single config blip never takes the CTAs and checkout entry fully down.
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
        // Stripe hosted Checkout: leaves the page entirely; success/cancel
        // is caught by /pricing?checkout=….
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

  // ?plan= auto-checkout: starts once, when session + plan surface are ready;
  // when signed out it never auto-redirects — the sign-in CTA's return_to
  // carries the plan param so the flow resumes here after login.
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
