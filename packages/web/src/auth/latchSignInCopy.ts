// LatchSignInPage 的文案与纯助手：双语 copy 表、语言解析、错误映射与回跳目标解析。
// 从页面拆出是为了让页面本体保持在 lint 行数约束内；内容与行为未变。
import { LatchAccountError } from "@zcode/services";

export type LatchSignInLocale = "zh-CN" | "en-US";

export interface LatchSignInCopy {
  title: string;
  description: string;
  emailLabel: string;
  passwordLabel: string;
  passwordHint: string;
  signInAction: string;
  signUpAction: string;
  switchToSignUp: string;
  switchToSignIn: string;
  signingInStatus: string;
  creatingAccountStatus: string;
  mintingStatus: string;
  provisioningStatus: string;
  servicesConnecting: string;
  errorServicesTitle: string;
  errorServicesAction: string;
  errorEmailInvalid: string;
  errorPasswordMin: string;
  errorEmailTaken: string;
  errorEmailTakenHint: string;
  errorInvalidCredentials: string;
  errorRateLimited: string;
  errorNetwork: string;
  errorServer: string;
  errorUnknown: string;
  signedInTitle: string;
  signedInAs: string;
  provisionedNote: string;
  provisionFailedTitle: string;
  provisionRetryAction: string;
  continueAction: string;
  signOutAction: string;
}

const COPY: Record<LatchSignInLocale, LatchSignInCopy> = {
  "zh-CN": {
    title: "登录 Latch 账号",
    description:
      "Latch 账号即 xlaunch 网关账号。登录后会自动铸造一枚 “Latch Web” 推理 Key，并接入内置网关 provider。",
    emailLabel: "邮箱",
    passwordLabel: "密码",
    passwordHint: "至少 10 个字符",
    signInAction: "登录",
    signUpAction: "创建账号",
    switchToSignUp: "没有账号？创建一个",
    switchToSignIn: "已有账号？直接登录",
    signingInStatus: "正在登录…",
    creatingAccountStatus: "正在创建账号…",
    mintingStatus: "正在铸造 Latch Web Key…",
    provisioningStatus: "正在接入内置网关 provider…",
    servicesConnecting: "正在连接 Latch 服务…",
    errorServicesTitle: "无法连接 Latch 服务",
    errorServicesAction: "刷新重试",
    errorEmailInvalid: "请输入有效的邮箱地址",
    errorPasswordMin: "密码至少需要 10 个字符",
    errorEmailTaken: "该邮箱已注册过 Latch 账号",
    errorEmailTakenHint: "改用登录即可继续。",
    errorInvalidCredentials: "邮箱或密码不正确",
    errorRateLimited: "尝试过于频繁，请稍后再试",
    errorNetwork: "暂时无法连接 Latch 账号服务，请检查网络后重试",
    errorServer: "Latch 账号服务暂时不可用，请稍后重试",
    errorUnknown: "登录失败，请重试",
    signedInTitle: "已登录",
    signedInAs: "当前账号",
    provisionedNote: "网关 provider 已接入，正在返回…",
    provisionFailedTitle: "账号已登录，但网关接入未完成",
    provisionRetryAction: "重新尝试接入",
    continueAction: "继续",
    signOutAction: "退出登录",
  },
  "en-US": {
    title: "Sign in to your Latch account",
    description:
      'Your Latch account is your xlaunch gateway account. Signing in mints a "Latch Web" inference key and connects the embedded gateway provider.',
    emailLabel: "Email",
    passwordLabel: "Password",
    passwordHint: "At least 10 characters",
    signInAction: "Sign in",
    signUpAction: "Create account",
    switchToSignUp: "No account yet? Create one",
    switchToSignIn: "Already have an account? Sign in",
    signingInStatus: "Signing in…",
    creatingAccountStatus: "Creating your account…",
    mintingStatus: "Minting your Latch Web key…",
    provisioningStatus: "Connecting the embedded gateway provider…",
    servicesConnecting: "Connecting to the Latch server…",
    errorServicesTitle: "Cannot reach the Latch server",
    errorServicesAction: "Reload and retry",
    errorEmailInvalid: "Enter a valid email address",
    errorPasswordMin: "Password must be at least 10 characters",
    errorEmailTaken: "That email already has a Latch account",
    errorEmailTakenHint: "Sign in instead to continue.",
    errorInvalidCredentials: "Incorrect email or password",
    errorRateLimited: "Too many attempts — try again later",
    errorNetwork: "Cannot reach the Latch account service. Check your network and try again.",
    errorServer: "The Latch account service is temporarily unavailable. Try again later.",
    errorUnknown: "Sign-in failed. Please try again.",
    signedInTitle: "Signed in",
    signedInAs: "Signed in as",
    provisionedNote: "Gateway provider connected — heading back…",
    provisionFailedTitle: "Signed in, but the gateway connection did not finish",
    provisionRetryAction: "Retry connection",
    continueAction: "Continue",
    signOutAction: "Sign out",
  },
};

export function resolveLocale(language?: string): LatchSignInLocale {
  const candidate = language ?? globalThis.navigator?.language ?? "";
  return /^zh(?:-|$)/iu.test(candidate) ? "zh-CN" : "en-US";
}

export function getLatchSignInCopy(locale: LatchSignInLocale = resolveLocale()): LatchSignInCopy {
  return COPY[locale];
}

/** 只接受同源路径作为回跳目标，且不能回到 /signin 自身，防止登录成功后死循环。 */
export function resolveSafeSignInReturnTo(
  value: string | null | undefined,
  origin: string = window.location.origin,
): string {
  if (!value || !value.trim()) {
    return "/";
  }
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname === "/signin") {
      return "/";
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

export function describeLatchError(error: unknown, copy: LatchSignInCopy): string {
  if (error instanceof LatchAccountError) {
    switch (error.kind) {
      case "email_taken":
        return copy.errorEmailTaken;
      case "invalid_credentials":
        return copy.errorInvalidCredentials;
      case "rate_limited":
        return copy.errorRateLimited;
      case "network":
        return copy.errorNetwork;
      case "server":
        return copy.errorServer;
      default:
        return error.message || copy.errorUnknown;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
