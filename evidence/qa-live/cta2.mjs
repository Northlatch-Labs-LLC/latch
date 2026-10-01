import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const { email, password } = JSON.parse(readFileSync(`${OUT}/signup-state.json`, "utf8"));
const consoleAll = [];
const popups = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => consoleAll.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on("popup", (p) => popups.push(p.url()));

// sign in
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.click("#latch-signin-password", { clickCount: 3 });
await page.keyboard.type(password, { delay: 2 });
await page.click("#latch-signin-email", { clickCount: 3 });
await page.keyboard.type(email, { delay: 2 });
await page.getByRole("button", { name: /^sign in$/i }).click();
for (let i = 0; i < 40; i++) { await page.waitForTimeout(1000); if (!page.url().includes("/signin")) break; }
await page.waitForTimeout(2000);

// open upgrade dialog, inspect button aria-labels, close via X
await page.click('[data-testid="login-trigger"]');
await page.waitForTimeout(600);
await page.getByRole("menuitem", { name: /latch subscription/i }).click();
await page.waitForTimeout(2500);
const btnLabels = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="coding-plan-upgrade-surface"] button')].map((b) => ({ aria: b.getAttribute("aria-label"), text: b.innerText.trim().slice(0, 40) })),
);
log("DIALOG BUTTONS:", JSON.stringify(btnLabels));
await page.screenshot({ path: `${OUT}/qa-15-upgrade-dialog.png` });
// try the X (last icon button)
const closeBtn = page.locator('[data-testid="coding-plan-upgrade-surface"] button').last();
await closeBtn.click();
await page.waitForTimeout(1500);
const stillOpen = await page.locator('[data-testid="coding-plan-upgrade-surface"]').count();
log("DIALOG CLOSED AFTER X:", stillOpen === 0);

// Settings -> Latch account section
await page.locator('[data-testid="task-settings-button"]').click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/qa-16-settings.png` });
const settingsSections = await page.evaluate(() =>
  [...document.querySelectorAll("h1,h2,h3,[data-slot=cardTitle],button")].filter((el) => el.offsetWidth && /latch|subscription|billing|plan/i.test(el.innerText)).map((el) => el.innerText.trim().slice(0, 60)),
);
log("SETTINGS LATCH-LIKE CONTROLS:", JSON.stringify([...new Set(settingsSections)]));
const manage = page.getByRole("button", { name: /manage billing/i });
log("MANAGE BILLING BUTTON COUNT:", await manage.count());
if (await manage.count()) {
  popups.length = 0;
  await manage.click();
  await page.waitForTimeout(2500);
  log("AFTER MANAGE-BILLING CLICK popups:", JSON.stringify(popups), "url:", page.url());
  await page.screenshot({ path: `${OUT}/qa-17-manage-billing-click.png` });
}

// z.ai login on share landing page
await page.goto(`${BASE}/share`, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => log("share nav err", e.message));
await page.waitForTimeout(2500);
log("SHARE URL:", page.url());
await page.screenshot({ path: `${OUT}/qa-18-share-landing.png` });
const zaiControls = await page.evaluate(() =>
  [...document.querySelectorAll("button, a")].filter((el) => el.offsetWidth && /z\.ai|zai|bigmodel|continue with/i.test(el.innerText + " " + (el.getAttribute("aria-label") || ""))).map((el) => el.innerText.trim().slice(0, 60)),
);
log("ZAI-LIKE CONTROLS ON SHARE PAGE:", JSON.stringify(zaiControls));
log("SHARE PAGE TEXT:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 600)));

console.log("=== POPUPS ==="); popups.forEach((l) => console.log(l));
await browser.close();
