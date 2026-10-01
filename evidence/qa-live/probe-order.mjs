import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const EMAIL = `latch-qa-${Date.now()}@northlatch.dev`;
// 口令只从环境变量读取，绝不硬编码进仓库文件（本目录会随修复入库）。
const PASSWORD = process.env.LATCH_QA_PASSWORD;
if (!PASSWORD) {
  console.error("env var LATCH_QA_PASSWORD is required");
  process.exit(1);
}
const apiCalls = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("response", (r) => { if (r.url().includes("latch-account") || r.status() >= 400) apiCalls.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
const log = (...a) => console.log(...a);

await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.getByRole("button", { name: /create one/i }).click();
await page.waitForTimeout(400);

// ORDER: password FIRST, then email (works around the stale-closure dep bug)
await page.click("#latch-signin-password");
await page.keyboard.type(PASSWORD, { delay: 5 });
await page.click("#latch-signin-email");
await page.keyboard.type(EMAIL, { delay: 5 });
await page.waitForTimeout(300);

await page.getByRole("button", { name: /create account/i }).click();
let outcome = "timeout";
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  if (!page.url().includes("/signin")) { outcome = "navigated:" + page.url(); break; }
  const a = page.locator('[role="alert"]');
  if ((await a.count()) > 0) { outcome = "alert:" + (await a.first().innerText()).replace(/\n/g, " | ").slice(0, 300); break; }
  if (i === 2) await page.screenshot({ path: `${OUT}/qa-07-signup-progress.png` });
}
log("REVERSED-ORDER SIGNUP OUTCOME:", outcome, `(email=${EMAIL})`);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/qa-08-signup-final.png` });
log("URL:", page.url());
log("PAGE TEXT:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 800)));
writeFileSync(`${OUT}/signup-state.json`, JSON.stringify({ email: EMAIL, password: PASSWORD, outcome }, null, 2));
console.log("API:", apiCalls);
await browser.close();
