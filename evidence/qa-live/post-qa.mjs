// Squad F post-fix live QA driver. Stage arg: auth | billing | zai
// 口令与敏感值只走 env / 内存：不把 password、session token、sk-cp- key 写进本文件或日志。
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const STAGE = process.argv[2] || "auth";
const STATE_FILE = `${OUT}/post-qa-state.json`;
const log = (...a) => console.log(...a);

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};

// 口令由 QA 邮箱确定性派生：不落盘、不进日志，跨 stage 可重登。
function qaPassword(email) {
  return "LatchQa-" + createHash("sha256").update(email).digest("hex").slice(0, 16) + "!9x";
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const consoleErrors = [];
const apiLog = [];
const failedRequests = [];
let phase = "init";
let stateShareUrl = null;
const secretCapture = { token: null, key: null };
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[${phase}] ${m.text().slice(0, 300)}`); });
page.on("pageerror", (e) => consoleErrors.push(`[${phase}] [pageerror] ` + String(e).slice(0, 300)));
page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`[${phase}] ${r.status()} ${r.request().method()} ${r.url()}`); });
page.on("response", async (r) => {
  const url = r.url();
  try {
    if (url.includes("/api/latch-account/") || url.includes("/api/latch-billing/") || url.includes("/shares/")) {
      apiLog.push(`${r.status()} ${r.request().method()} ${url.replace(BASE, "")}`);
    }
    // share confirm 响应：拿分享链接（含 share code，非敏感）。
    if (r.request().method() === "POST" && url.includes("/confirm") && url.includes("/shares/")) {
      const body = await r.json().catch(() => null);
      const u = body?.shareUrl || body?.url || body?.data?.shareUrl || body?.data?.url || null;
      if (u) stateShareUrl = u;
      else if (body && JSON.stringify(body).includes("/share/")) {
        const m = JSON.stringify(body).match(/https?:[^"]*\/share\/[\w-]+/);
        if (m) stateShareUrl = m[0];
      }
    }
    // 铸 key 的完整 key 只在这一响应里出现；留在内存里供本进程直接用，不落盘不打日志。
    if (r.request().method() === "POST" && url.includes("/api/latch-account/keys") && r.status() === 201) {
      const body = await r.json();
      if (body?.key) secretCapture.key = body.key;
    }
    if ((url.includes("/api/latch-account/login") || url.includes("/api/latch-account/signup")) && (r.status() === 200 || r.status() === 201)) {
      const body = await r.json();
      if (body?.token) secretCapture.token = body.token;
    }
  } catch { /* non-JSON body, ignore */ }
});

async function shot(name) { await page.screenshot({ path: `${OUT}/${name}.png` }); log("SHOT", name); }
const bodyText = () => page.evaluate(() => document.body.innerText);
const latchToken = () => page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.toLowerCase().includes("latch")).map((k) => `${k}=${String(window.localStorage.getItem(k)).slice(0, 12)}…`));
async function fetchMe(token) {
  return page.evaluate(async (t) => {
    const r = await fetch("/api/latch-account/me", { headers: { Authorization: `Bearer ${t}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, token);
}
async function gotoSignin() {
  await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
}
async function fillCreds(email, password) {
  // 逐字段点击三连选再键入，规避同步 fill 偶发的受控组件丢字问题。
  for (const [sel, val] of [["#latch-signin-email", email], ["#latch-signin-password", password]]) {
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.type(val, { delay: 5 });
  }
}
async function submitAndWait(name) {
  await page.getByRole("button", { name }).click();
  for (let i = 0; i < 75; i++) {
    await page.waitForTimeout(1000);
    if (!page.url().includes("/signin")) return "navigated:" + page.url();
    const alertEl = page.locator('[role="alert"]');
    if ((await alertEl.count()) > 0) return "alert:" + (await alertEl.first().innerText()).replace(/\n/g, " | ").slice(0, 300);
  }
  return "timeout:" + page.url();
}

// ------------------------------------------------------------------ stage: auth
if (STAGE === "auth") {
  const EMAIL = `latch-qa-${Date.now()}@northlatch.dev`;
  const PASSWORD = qaPassword(EMAIL);

  phase = "signin-landing";
  await gotoSignin();
  await shot("post-01-signin-landing");
  phase = "signup-mode";
  await page.getByRole("button", { name: /create one/i }).click();
  await page.waitForTimeout(500);
  await shot("post-02-signup-mode");
  phase = "signup-submit";
  await fillCreds(EMAIL, PASSWORD);
  const signupOutcome = await submitAndWait(/^create account$/i);
  log("SIGNUP:", signupOutcome, `(email=${EMAIL})`);
  await page.waitForTimeout(3000);
  await shot("post-03-workspace-after-signup");
  log("TOKEN-STORED-AFTER-SIGNUP:", JSON.stringify(await latchToken()));

  phase = "reload-after-signup";
  await page.reload({ waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(2500);
  log("AFTER-RELOAD URL:", page.url(), "TOKEN:", JSON.stringify(await latchToken()));
  await shot("post-04-workspace-after-reload");

  phase = "logout";
  // logout: Connect 菜单 -> Log out；Web 上找不到登出控件时以清 localStorage 等效（缺陷单独记录）。
  await page.click('[data-testid="login-trigger"]');
  await page.waitForTimeout(1000);
  const menuTexts = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"]')].map((el) => `${el.getAttribute("data-testid")}:${el.innerText.trim().slice(0, 40)}`),
  );
  log("CONNECT MENU:", JSON.stringify(menuTexts));
  await shot("post-05-connect-menu-signedin");
  const logoutItem = page.locator('[data-testid="logout-button"]');
  if (await logoutItem.count()) {
    await logoutItem.click();
    await page.waitForTimeout(3000);
    log("LOGOUT VIA: menu");
  } else {
    await page.keyboard.press("Escape");
    await page.evaluate(() => { Object.keys(localStorage).filter((k) => k.startsWith("latch:")).forEach((k) => localStorage.removeItem(k)); });
    await page.reload({ waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(2500);
    log("LOGOUT VIA: localStorage clear (menu logout control ABSENT on web)");
  }
  log("AFTER-SIGNOUT TOKEN:", JSON.stringify(await latchToken()), "URL:", page.url());
  await shot("post-05-after-signout");

  phase = "signin-after-logout";
  await gotoSignin();
  await fillCreds(EMAIL, PASSWORD);
  const loginOutcome = await submitAndWait(/^sign in$/i);
  log("LOGIN:", loginOutcome);
  await page.waitForTimeout(3000);
  log("AFTER-LOGIN TOKEN:", JSON.stringify(await latchToken()));
  await shot("post-06-after-login");

  phase = "reload-after-login";
  await page.reload({ waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(2500);
  log("AFTER-LOGIN-RELOAD URL:", page.url(), "TOKEN:", JSON.stringify(await latchToken()));
  await shot("post-07-after-login-reload");

  writeFileSync(STATE_FILE, JSON.stringify({ ...state, email: EMAIL, signupOutcome, loginOutcome }, null, 2));
  log("=== API ==="); apiLog.forEach((l) => log(l));
  log("=== CONSOLE ERRORS (" + consoleErrors.length + ") ===");
  consoleErrors.forEach((l) => log(l));
  log("=== FAILED REQUESTS (>=400, non-API) ===");
  [...new Set(failedRequests)].forEach((l) => log(l));
}

// --------------------------------------------------------------- stage: billing
if (STAGE === "billing") {
  const PASSWORD = qaPassword(state.email);

  await gotoSignin();
  await fillCreds(state.email, PASSWORD);
  const loginOutcome = await submitAndWait(/^sign in$/i);
  log("LOGIN:", loginOutcome);
  await page.waitForTimeout(2500);
  const token = secretCapture.token;
  log("TOKEN-CAPTURED:", Boolean(token), "KEY-CAPTURED:", Boolean(secretCapture.key));

  const meBefore = token ? await fetchMe(token) : null;
  log("ME-BEFORE:", JSON.stringify(meBefore));

  // CTA 1: Connect menu -> Latch subscription
  await page.click('[data-testid="login-trigger"]');
  await page.waitForTimeout(800);
  const menuItems = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => []);
  log("MENU ITEMS:", JSON.stringify(menuItems.map((t) => t.replace(/\n/g, " / ").slice(0, 60))));
  await shot("post-08-connect-menu");
  const sub = page.getByRole("menuitem", { name: /latch subscription/i });
  if (await sub.count()) {
    await sub.click();
    await page.waitForTimeout(3500);
    log("CTA-1 (Latch subscription) DEST:", page.url());
    await shot("post-08-upgrade-cta-destination");
  } else {
    log("DEFECT: no 'Latch subscription' menuitem");
  }
  if (!page.url().includes("/pricing")) {
    await page.goto(`${BASE}/pricing`, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1000);
  await shot("post-09-pricing");
  log("PRICING TEXT:", JSON.stringify((await bodyText()).slice(0, 900)));

  // CTA 2: settings -> manage billing（先回工作区，CTA-1 之后当前页是 /pricing）
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.locator('[data-testid="task-settings-button"]').click();
  await page.waitForTimeout(2500);
  await page.getByText("Latch Account", { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await shot("post-10-settings-latch-section");
  const manage = page.locator('[data-testid="settings-latch-manage-billing"]');
  log("MANAGE-BILLING COUNT:", await manage.count());
  if (await manage.count()) {
    await manage.click();
    await page.waitForTimeout(3500);
    log("CTA-2 (Manage billing) DEST:", page.url());
    await shot("post-10-manage-billing-destination");
  }

  // subscribe to Latch Monthly from the pricing surface
  await page.goto(`${BASE}/pricing`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  const monthlyCard = page.locator("div", { has: page.getByRole("heading", { name: /latch monthly/i }) }).last();
  const subscribeBtns = monthlyCard.getByRole("button");
  log("MONTHLY CARD BUTTONS:", JSON.stringify(await subscribeBtns.allInnerTexts().catch(() => [])));
  await subscribeBtns.last().click();
  let stripeUrl = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    if (page.url().includes("checkout.stripe.com")) { stripeUrl = page.url(); break; }
  }
  log("STRIPE CHECKOUT URL:", stripeUrl ? stripeUrl.split("?")[0] : "TIMEOUT at " + page.url());
  await page.waitForTimeout(4000);
  await shot("post-11-stripe-checkout");
  if (!stripeUrl) {
    log("PRICING-TEXT-AT-TIMEOUT:", JSON.stringify((await bodyText()).slice(0, 600)));
    await browser.close(); process.exit(2);
  }

  // hosted checkout: 先试页面直填（checkout.stripe.com 原生表单），失败再找元素 iframe。
  const payFrame = page;
  const tryFill = async (sel) => (await payFrame.locator(sel).count()) > 0;
  const emailEmpty = await payFrame.locator("#email").count() > 0 && (await payFrame.locator("#email").inputValue().catch(() => "")) === "";
  if (emailEmpty) await payFrame.fill("#email", state.email);
  if (await tryFill("#cardNumber")) {
    await payFrame.fill("#cardNumber", "4242 4242 4242 4242");
    await payFrame.fill("#cardExpiry", "12 / 34");
    await payFrame.fill("#cardCvc", "123");
    if (await tryFill("#billingName")) await payFrame.fill("#billingName", "Latch QA");
    log("CARD FILLED: on-page form");
  } else {
    const numFrame = page.frameLocator('iframe[title*="card number" i], iframe[name*="__privateStripeFrame"]').first();
    await numFrame.locator('input[name="cardnumber"], input[autocomplete="cc-number"]').first().fill("4242 4242 4242 4242");
    const expFrame = page.frameLocator('iframe[title*="expiration" i]').first();
    await expFrame.locator('input[name="exp-date"], input[autocomplete="cc-exp"]').first().fill("12 / 34");
    const cvcFrame = page.frameLocator('iframe[title*="CVC" i], iframe[title*="security" i]').first();
    await cvcFrame.locator('input[name="cvc"], input[autocomplete="cc-csc"]').first().fill("123");
    log("CARD FILLED: element iframes");
  }
  await page.waitForTimeout(1500);
  await shot("post-11-stripe-checkout-filled");
  const payTime = Date.now();
  const payBtn = page.getByRole("button", { name: /subscribe|pay|start trial/i }).first();
  log("PAY BUTTON:", JSON.stringify(await payBtn.innerText().catch(() => null)));
  await payBtn.click();
  let back = false;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    if (page.url().startsWith(`${BASE}/pricing`)) { back = true; break; }
  }
  log("BACK-FROM-STRIPE:", back ? page.url() : "TIMEOUT at " + page.url());
  await page.waitForTimeout(3000);
  await shot("post-12-checkout-return");
  log("RETURN TEXT:", JSON.stringify((await bodyText()).slice(0, 700)));

  // poll /me up to 120s for credit grant + plan
  let granted = null;
  for (let i = 0; i < 24; i++) {
    const me = await fetchMe(token);
    const bal = me.body?.balanceMicros ?? 0;
    if (me.status === 200 && bal > (meBefore?.body?.balanceMicros ?? 0)) {
      granted = { afterMs: Date.now() - payTime, me };
      break;
    }
    if (i === 0) log("ME-AFTER-PAYMENT-FIRST-POLL:", JSON.stringify(me));
    await page.waitForTimeout(5000);
  }
  log("GRANT:", granted ? `landed ${granted.afterMs}ms after pay` : "NOT LANDED within 120s");
  if (granted) log("ME-AFTER:", JSON.stringify(granted.me));
  await shot("post-13-account-status-after-grant");

  // account section in settings (account balance/plan surface)
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.locator('[data-testid="task-settings-button"]').click();
  await page.waitForTimeout(2500);
  await page.getByText("Latch Account", { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await shot("post-14-latch-account-section");
  log("SETTINGS-LATCH-TEXT:", JSON.stringify((await bodyText()).slice(0, 1200)));

  // test 2b: gateway gate with the minted key (in-memory only)
  if (secretCapture.key) {
    const gw = await page.evaluate(async (k) => {
      const r = await fetch("https://gateway.xlaunch.work/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }),
      });
      let body = null;
      try { body = await r.json(); } catch { /* ignore */ }
      return {
        status: r.status,
        error: body?.error?.message ?? null,
        model: body?.model ?? null,
        usage: body?.usage ?? null,
      };
    }, secretCapture.key);
    log("GATEWAY-CHAT-STATUS:", gw.status, "MODEL:", gw.model, "USAGE:", JSON.stringify(gw.usage), "ERROR:", gw.error);
    const meAfter2b = await fetchMe(token);
    log("ME-AFTER-2B:", JSON.stringify(meAfter2b));
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, gatewayStatus: gw.status, grantAfterMs: granted?.afterMs ?? null }, null, 2));
  } else {
    log("DEFECT: no sk-cp- key captured at login (mint step missing or failed)");
  }
  log("=== API ==="); apiLog.forEach((l) => log(l));
  log("=== CONSOLE ERRORS (" + consoleErrors.length + ") ===");
  consoleErrors.forEach((l) => log(l));
}

// ------------------------------------------------------------------- stage: zai
if (STAGE === "zai") {
  const PASSWORD = qaPassword(state.email);

  await gotoSignin();
  await fillCreds(state.email, PASSWORD);
  log("LOGIN:", await submitAndWait(/^sign in$/i));
  await page.waitForTimeout(3000);
  log("WORKSPACE URL:", page.url());

  // 发一条消息，确保会话有内容可分享（余额不足也会留下 user 消息行，不影响分享）。
  phase = "send-message";
  const composer = page.locator("textarea, [contenteditable=true]").first();
  if (await composer.count()) {
    await composer.click();
    await page.keyboard.type("hi", { delay: 20 });
    await page.keyboard.press("Enter");
    log("MESSAGE SENT, waiting…");
    await page.waitForTimeout(25000);
    await shot("post-15-message-sent");
  } else {
    log("NO COMPOSER FOUND");
    await shot("post-15-no-composer");
  }

  // share flow: trigger -> dock -> 标题 + private 权限 -> confirm
  phase = "share-flow";
  const shareTrigger = page.locator('[data-testid="conversation-share-trigger"]');
  log("SHARE TRIGGER COUNT:", await shareTrigger.count());
  if (await shareTrigger.count()) {
    await shareTrigger.first().click();
    await page.waitForTimeout(2500);
    await shot("post-15-share-dock");
    const titleInput = page.locator("input").first();
    const titleVal = await titleInput.inputValue().catch(() => "");
    if (!titleVal) { await titleInput.fill("Latch QA share").catch(() => {}); }
    const priv = page.locator('[data-conversation-share-permission="private"]');
    if (await priv.count()) { await priv.first().click(); await page.waitForTimeout(800); }
    const confirmBtn = page.locator('[data-testid="conversation-share-confirm"]');
    log("CONFIRM BUTTON COUNT:", await confirmBtn.count(), "TEXT:", JSON.stringify(await confirmBtn.innerText().catch(() => null)));
    await shot("post-15-share-confirm-ready");
    if (await confirmBtn.count()) {
      await confirmBtn.click();
      await page.waitForTimeout(20000);
      await shot("post-15-share-published");
      log("POST-PUBLISH TEXT:", JSON.stringify((await bodyText()).slice(0, 900)));
    }
  } else {
    log("DEFECT: conversation-share-trigger not found");
  }
  log("=== SHARES API ==="); apiLog.filter((l) => l.includes("/shares/")).forEach((l) => log(l));

  // share link：优先 confirm 接口响应，其次 DOM 文本。
  phase = "share-link";
  const linkText = stateShareUrl || await page.evaluate(() => {
    const m = document.body.innerText.match(/https:\/\/latch\.xlaunch\.work\/share\/[\w-]+/);
    return m ? m[0] : null;
  });
  log("SHARE LINK:", linkText ?? "NOT FOUND IN DOM TEXT");
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, shareLink: linkText }, null, 2));

  if (linkText) {
    const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await anon.newPage();
    const errs2 = [];
    p2.on("console", (m) => { if (m.type() === "error") errs2.push(m.text().slice(0, 200)); });
    await p2.goto(linkText, { waitUntil: "networkidle", timeout: 60000 });
    await p2.waitForTimeout(3000);
    log("ANON SHARE URL:", p2.url());
    log("ANON SHARE TEXT:", JSON.stringify((await p2.evaluate(() => document.body.innerText)).slice(0, 500)));
    await p2.screenshot({ path: `${OUT}/post-16-zai-control.png` });
    const zaiBtn = p2.locator('[data-share-login-provider="zai"]');
    log("ZAI BUTTON COUNT:", await zaiBtn.count());
    if (await zaiBtn.count()) {
      await zaiBtn.click();
      for (let i = 0; i < 25; i++) {
        await p2.waitForTimeout(1000);
        if (!p2.url().includes("latch.xlaunch.work")) break;
      }
      log("ZAI AUTHORIZE URL:", p2.url());
      await p2.screenshot({ path: `${OUT}/post-17-zai-authorize.png` });
      // 不完成 vendor 登录：到此为止。
    } else {
      log("DEFECT: z.ai login control not rendered");
    }
    log("ANON CONSOLE ERRORS (" + errs2.length + ")"); errs2.forEach((l) => log(l));
    await anon.close();
  }
  log("=== CONSOLE ERRORS (" + consoleErrors.length + ") ===");
  consoleErrors.forEach((l) => log(l));
}

await browser.close();
