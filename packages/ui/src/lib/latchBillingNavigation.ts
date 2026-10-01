/**
 * Latch 计费入口的环境感知 seam —— 所有 "升级/充值/管理账单" CTA 的目标解析统一收口到这里。
 *
 * 桌面端沿用既有行为：openExternal 打开 xlaunch.work 账户页（manage/purchase resolver）。
 * Web 端 openExternal 落到 window.open（外站新标签），对 Latch 订阅转化是死路：
 * 这里改走应用内路由 —— 已登录（浏览器本地有 Latch 会话 token）进 /pricing，
 * 未登录先去 /signin 并带 return_to 回跳；显式选择套餐时用 ?plan= 直达 checkout
 * （由 /pricing 页承接并自动发起 POST /api/latch-billing/checkout）。
 *
 * Web 判定复用 useRootOAuthEffects 的宿主约定：浏览器里没有 preload 注入的 window.zcode。
 */
import {
  LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY,
  resolveLatchAccountManageUrl,
  resolveLatchAccountPurchaseUrl,
} from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";

/** Latch 套餐 id，与 POST /api/latch-billing/checkout 的 planId 契约一致。 */
export type LatchBillingPlanId = "latch-monthly" | "latch-yearly";

/** 桌面端外链意图：管理账单（账户页）与购买/升级（?plan=pro）。 */
export type LatchBillingIntent = "manage" | "purchase";

/** Latch 计费在应用内的两个路由（packages/web main.tsx 按路径分发）。 */
export const LATCH_BILLING_PRICING_PATH = "/pricing";
export const LATCH_BILLING_SIGNIN_PATH = "/signin";

/** StatusCards（Coding Plan 状态卡）的 Latch 管理外链：gateway 的用量页。 */
export const LATCH_GATEWAY_USAGE_URL = "https://gateway.xlaunch.work/usage";

/** Latch 订阅定价页（$14/月、$99/年）——所有升级 CTA 的最终落地页。 */
export const LATCH_PRICING_URL = "https://latch.xlaunch.work/pricing";

/** Web 判定供其它 Electron-only 界面（如升级 webview 弹窗）在挂载前分流使用。 */
export function isWebRuntime(): boolean {
  return typeof window !== "undefined" && !("zcode" in window);
}

/**
 * Web 端 Latch 登录态：/signin 登录后 token 镜像在浏览器本地
 * （browserLatchAccountRepo 与 services 侧凭据键同名）。只判断存在性，不在这里校验时效，
 * checkout 401 由 /pricing 页兜底回登录。
 */
function readWebLatchSessionToken(): string | null {
  try {
    return window.localStorage.getItem(LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY);
  } catch {
    return null;
  }
}

function webPricingTarget(planId?: LatchBillingPlanId): string {
  return planId ? `${LATCH_BILLING_PRICING_PATH}?plan=${planId}` : LATCH_BILLING_PRICING_PATH;
}

function webSignInTarget(returnTo: string): string {
  return `${LATCH_BILLING_SIGNIN_PATH}?return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * 环境感知地打开 Latch 计费入口。Web 端不需要 platform；桌面端 platform 缺失时
 * 与旧实现一致只记日志不打断（CTA 所在横幅/面板不能被导航失败炸掉）。
 */
export function openLatchBillingEntry(options: {
  platform: Pick<IPlatformService, "openExternal"> | null;
  intent: LatchBillingIntent;
  /** 用户已显式选择套餐时传入：Web 端直达 checkout（?plan= 由 /pricing 页自动发起）。 */
  planId?: LatchBillingPlanId;
}): void {
  const { platform, intent, planId } = options;
  if (isWebRuntime()) {
    const pricingTarget = webPricingTarget(planId);
    window.location.assign(
      readWebLatchSessionToken() ? pricingTarget : webSignInTarget(pricingTarget),
    );
    return;
  }
  if (!platform) {
    logger.warn("[latchBilling] platform 不可用，无法打开 Latch 账户页");
    return;
  }
  try {
    // 购买/升级统一落 Latch 定价页（$14/$99 的真实 checkout）；管理账单才去账户页。
    platform.openExternal(intent === "manage" ? resolveLatchAccountManageUrl() : LATCH_PRICING_URL);
  } catch (error) {
    logger.warn("[latchBilling] 解析 Latch 账户页地址失败", { error });
  }
}

function normalizeExternalUrl(value: string): string | null {
  try {
    return new URL(value.trim()).href;
  } catch {
    return null;
  }
}

function tryResolveLatchAccountUrl(resolve: () => string): string | null {
  try {
    return normalizeExternalUrl(resolve());
  } catch {
    return null;
  }
}

/**
 * 通用 openExternal 调用点用：判断该外链是否 Latch 计费目标（账户页与 gateway 用量页，
 * 含 env 覆盖后的 resolver 结果）。只接管 Latch 计费链接，其余供应商外链原样放行。
 */
export function isLatchBillingExternalUrl(url: string): boolean {
  const normalized = normalizeExternalUrl(url);
  if (!normalized) {
    return false;
  }
  const targets = [
    tryResolveLatchAccountUrl(resolveLatchAccountManageUrl),
    tryResolveLatchAccountUrl(resolveLatchAccountPurchaseUrl),
    normalizeExternalUrl(LATCH_GATEWAY_USAGE_URL),
  ].filter((value): value is string => value !== null);
  return targets.includes(normalized);
}

/**
 * openExternal 的守卫变体：是 Latch 计费外链就改走环境感知 seam 并返回 true（已接管），
 * 否则返回 false 由调用方继续原 openExternal 流程。与 handleOpenApiKeyUrl 这类
 * 同时承接多种外链的入口配合，避免把供应商 API Key 页面也劫持进 /pricing。
 */
export function openExternalOrLatchBilling(
  url: string,
  platform: Pick<IPlatformService, "openExternal"> | null,
): boolean {
  if (!isLatchBillingExternalUrl(url)) {
    return false;
  }
  const manageUrl = tryResolveLatchAccountUrl(resolveLatchAccountManageUrl);
  openLatchBillingEntry({
    platform,
    intent: manageUrl !== null && normalizeExternalUrl(url) === manageUrl ? "manage" : "purchase",
  });
  return true;
}
