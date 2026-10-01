// LatchPricingPage 的文案：双语 copy 表（en-US / zh-CN 键完全一致，由接口类型约束）。
// 独立页不走 react-intl（与 auth/latchSignInCopy.ts 同一约定）；语言解析复用其 resolveLocale。
import type { LatchSignInLocale } from "../auth/latchSignInCopy.js";

export interface LatchPricingCopy {
  title: string;
  subtitle: string;
  /** config.note 缺失时的网关额度说明兜底文案。 */
  defaultNote: string;
  planCreditIncludes: string;
  intervalMonthSuffix: string;
  intervalYearSuffix: string;
  signInPrompt: string;
  signInCta: string;
  signedInAs: string;
  balanceLabel: string;
  subscribeCta: string;
  checkoutStarting: string;
  outcomeSuccessTitle: string;
  outcomeSuccessBody: string;
  /** 订阅成功后的续行 CTA：回工作区开干。 */
  outcomeSuccessContinueCta: string;
  outcomeCancelledTitle: string;
  outcomeCancelledBody: string;
  errorConfig: string;
  errorUnauthorized: string;
  errorUnknownPlan: string;
  errorServer: string;
  errorNetwork: string;
}

const COPY: Record<LatchSignInLocale, LatchPricingCopy> = {
  "zh-CN": {
    title: "Latch 套餐",
    subtitle: "订阅 Latch，获得随套餐附赠的网关额度；推理用量按 token 从余额中扣减。",
    defaultNote: "套餐价格已包含对应的网关赠送额度，用完可随时加购或升级。",
    planCreditIncludes: "包含 {amount} 网关额度",
    intervalMonthSuffix: "/月",
    intervalYearSuffix: "/年",
    signInPrompt: "先登录你的 Latch 账号，再选择套餐。",
    signInCta: "先去登录",
    signedInAs: "当前账号",
    balanceLabel: "余额",
    subscribeCta: "订阅",
    checkoutStarting: "正在跳转 Stripe 结账…",
    outcomeSuccessTitle: "订阅成功",
    outcomeSuccessBody: "已收到你的付款，网关额度正在入账（账号状态已刷新）。",
    outcomeSuccessContinueCta: "继续使用 Latch",
    outcomeCancelledTitle: "已取消结账",
    outcomeCancelledBody: "本次未产生任何扣款，你可以随时重新发起订阅。",
    errorConfig: "套餐信息加载失败，已展示标准套餐。",
    errorUnauthorized: "登录状态已过期，请重新登录后再试。",
    errorUnknownPlan: "未知的套餐，请刷新页面后重试。",
    errorServer: "Latch 计费服务暂时不可用，请稍后重试。",
    errorNetwork: "暂时无法连接 Latch 计费服务，请检查网络后重试。",
  },
  "en-US": {
    title: "Latch plans",
    subtitle:
      "Subscribe to Latch and get bundled gateway credit; inference usage is metered per token against your balance.",
    defaultNote: "Each plan includes its gateway credit allowance — top up or upgrade any time.",
    planCreditIncludes: "includes {amount} of gateway credit",
    intervalMonthSuffix: "/mo",
    intervalYearSuffix: "/yr",
    signInPrompt: "Sign in to your Latch account first, then pick a plan.",
    signInCta: "Sign in first",
    signedInAs: "Signed in as",
    balanceLabel: "Balance",
    subscribeCta: "Subscribe",
    checkoutStarting: "Redirecting to Stripe Checkout…",
    outcomeSuccessTitle: "Subscription complete",
    outcomeSuccessBody:
      "Payment received — your gateway credit is being added (account status refreshed).",
    outcomeSuccessContinueCta: "Continue to Latch",
    outcomeCancelledTitle: "Checkout cancelled",
    outcomeCancelledBody: "You were not charged. You can start a subscription any time.",
    errorConfig: "Could not load plan details — showing the standard plans.",
    errorUnauthorized: "Your session expired — sign in again and retry.",
    errorUnknownPlan: "Unknown plan — reload the page and try again.",
    errorServer: "The Latch billing service is temporarily unavailable. Try again later.",
    errorNetwork: "Cannot reach the Latch billing service. Check your network and try again.",
  },
};

export function getLatchPricingCopy(locale: LatchSignInLocale): LatchPricingCopy {
  return COPY[locale];
}
