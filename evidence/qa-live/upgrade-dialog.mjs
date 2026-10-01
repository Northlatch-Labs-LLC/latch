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
page.on("console", (m) => consoleAll.push(`[${m.type()}] ${m.text().slice(0, 250)}`));
page.on("popup", (p) => popups.push(p.url()));
const requestFailures = [];
page.on("requestfailed", (r) => requestFailures.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));

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

// Connect menu -> Latch subscription
await page.click('[data-testid="login-trigger"]');
await page.waitForTimeout(800);
await page.getByRole("menuitem", { name: /latch subscription/i }).click();
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/qa-15-upgrade-dialog.png` });

const surface = await page.evaluate(() => {
  const s = document.querySelector('[data-testid="coding-plan-upgrade-surface"]');
  if (!s) return null;
  return {
    text: s.innerText.slice(0, 800),
    hasWebviewTag: !!s.querySelector("webview"),
    buttons: [...s.querySelectorAll("button, a")].map((b) => b.innerText.trim().slice(0, 60)),
    htmlSnippet: s.innerHTML.slice(0, 600),
  };
});
log("UPGRADE SURFACE:", JSON.stringify(surface, null, 1));

// look for and click the "open website" fallback if present
const openWeb = page.getByRole("button", { name: /open (the )?website|visit|open in browser|官网/i });
log("FALLBACK BUTTONS MATCHING:", await openWeb.count());
for (const b of await openWeb.all()) {
  const t = await b.innerText();
  popups.length = 0;
  await b.click();
  await page.waitForTimeout(2000);
  log(`CLICKED "${t.trim()}" -> popups:`, JSON.stringify(popups));
}

console.log("=== POPUPS ==="); popups.forEach((l) => console.log(l));
console.log("=== REQUEST FAILURES ==="); requestFailures.slice(0, 8).forEach((l) => console.log(l));
console.log("=== CONSOLE (dialog open period) ===");
consoleAll.slice(-15).forEach((l) => console.log(l));
await browser.close();
