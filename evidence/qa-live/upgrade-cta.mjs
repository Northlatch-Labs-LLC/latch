import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const { email, password } = JSON.parse(readFileSync(`${OUT}/signup-state.json`, "utf8"));
const apiCalls = [];
const consoleAll = [];
const popups = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("response", (r) => { if (r.status() >= 400 || r.url().includes("latch-account")) apiCalls.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleAll.push(m.text().slice(0, 250)); });
page.on("popup", (p) => popups.push(p.url()));

// sign in (password first)
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.click("#latch-signin-password", { clickCount: 3 });
await page.keyboard.type(password, { delay: 2 });
await page.click("#latch-signin-email", { clickCount: 3 });
await page.keyboard.type(email, { delay: 2 });
await page.getByRole("button", { name: /^sign in$/i }).click();
for (let i = 0; i < 40; i++) { await page.waitForTimeout(1000); if (!page.url().includes("/signin")) break; }
log("SIGNED IN:", page.url());
await page.waitForTimeout(2500);

// ---- AFFORDANCE 1: Connect menu -> "Latch subscription"
await page.click('[data-testid="login-trigger"]');
await page.waitForTimeout(800);
const upgradeItem = page.locator('[data-testid$="coding-plan-upgrade"], [role="menuitem"]', { hasText: /latch subscription/i }).first();
const itemText = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => []);
log("MENU ITEMS:", JSON.stringify(itemText));
await page.screenshot({ path: `${OUT}/qa-14-connect-menu.png` });
const sub = page.getByRole("menuitem", { name: /latch subscription/i });
if (await sub.count()) {
  await sub.click();
  await page.waitForTimeout(3000);
  log("AFTER CLICK 'Latch subscription': URL =", page.url(), "| popups:", JSON.stringify(popups));
  await page.screenshot({ path: `${OUT}/qa-15-upgrade-click-result.png` });
  const dialogText = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="coding-plan-upgrade-surface"], [role="dialog"], [data-state="open"]');
    return dlg ? dlg.innerText.slice(0, 500) : null;
  });
  log("DIALOG/SURFACE TEXT:", JSON.stringify(dialogText));
  // press Escape to close any dialog
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
} else {
  log("NO 'Latch subscription' menuitem found");
  await page.keyboard.press("Escape");
}

// ---- AFFORDANCE 2: Settings -> Latch account section -> Manage billing
const settingsBtn = page.locator('[data-testid="task-settings-button"]');
await settingsBtn.click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/qa-16-settings.png` });
const settingsText = await page.evaluate(() => document.body.innerText.slice(0, 2500));
log("SETTINGS TEXT (first 2500):", JSON.stringify(settingsText));
const manage = page.locator('[data-testid$="latch-manage-billing"], button', { hasText: /manage billing/i }).first();
if (await manage.count().catch(() => 0)) {
  popups.length = 0;
  await manage.click();
  await page.waitForTimeout(2500);
  log("AFTER CLICK 'Manage billing': popups:", JSON.stringify(popups), "| URL:", page.url());
  await page.screenshot({ path: `${OUT}/qa-17-manage-billing-click.png` });
} else {
  log("NO 'Manage billing' button visible");
}

// ---- AFFORDANCE 3: any visible 'Upgrade' buttons anywhere
const upgradeButtons = await page.evaluate(() =>
  [...document.querySelectorAll("button, a")].filter((el) => el.offsetWidth && /upgrade|get pro|add credit|subscription/i.test(el.innerText)).map((el) => ({ text: el.innerText.trim().slice(0, 60), tid: el.getAttribute("data-testid") })),
);
log("VISIBLE UPGRADE-LIKE CONTROLS:", JSON.stringify(upgradeButtons));

console.log("=== >=400 API ==="); apiCalls.filter((l) => !l.startsWith("4")).concat(apiCalls.filter((l) => l.startsWith("4"))).slice(0, 10).forEach((l) => console.log(l));
console.log("=== POPUPS ==="); popups.forEach((l) => console.log(l));
console.log("=== CONSOLE ERR/WARN ==="); [...new Set(consoleAll)].slice(0, 10).forEach((l) => console.log(l));
await browser.close();
