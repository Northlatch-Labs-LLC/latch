import { chromium } from "playwright";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const consoleLines = [];
const failedRequests = [];
const badResponses = [];
const popups = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

page.on("console", (m) => consoleLines.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
page.on("popup", (p) => popups.push(p.url()));

// Land on workspace, open the Connect (login-trigger) dropdown to find sign-in entry
await page.goto(BASE, { waitUntil: "networkidle", timeout: 45000 });
await page.click('[data-testid="login-trigger"]');
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/qa-02-connect-dropdown.png` });
const menuItems = await page.evaluate(() =>
  [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [data-radix-popper-content-wrapper] *')]
    .filter((el) => el.offsetWidth)
    .map((el) => ({ tag: el.tagName, text: (el.innerText || "").trim().slice(0, 80) })),
);
console.log("CONNECT MENU:", JSON.stringify(menuItems, null, 1));

// Also go to /signin directly
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1500);
console.log("SIGNIN URL:", page.url());
console.log("SIGNIN TITLE:", await page.title());
await page.screenshot({ path: `${OUT}/qa-03-signin-page.png` });
const els = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("button, a, input, [role=button]")) {
    out.push({
      tag: el.tagName,
      text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 100),
      type: el.getAttribute("type") || undefined,
      tid: el.getAttribute("data-testid") || undefined,
      id: el.id || undefined,
      disabled: el.disabled ?? undefined,
      visible: !!(el.offsetWidth || el.offsetHeight),
    });
  }
  return out;
});
console.log("SIGNIN ELEMENTS:", JSON.stringify(els, null, 1));

console.log("\n=== CONSOLE ==="); consoleLines.forEach((l) => console.log(l));
console.log("\n=== FAILED REQUESTS ==="); failedRequests.forEach((l) => console.log(l));
console.log("\n=== >=400 RESPONSES ==="); badResponses.forEach((l) => console.log(l));
console.log("\n=== POPUPS ==="); popups.forEach((l) => console.log(l));

await browser.close();
