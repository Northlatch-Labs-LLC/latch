import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const EMAIL = `latch-qa-${Date.now()}@northlatch.dev`;
// 口令只从环境变量读取，绝不硬编码进仓库文件（本目录会随修复入库）。
const PASSWORD = process.env.LATCH_QA_PASSWORD;
if (!PASSWORD) {
  console.error("env var LATCH_QA_PASSWORD is required");
  process.exit(1);
}
const consoleLines = [];
const apiCalls = [];
const popups = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => consoleLines.push(`[console.${m.type()}] ${m.text()}`));
page.on("response", (r) => { if (r.url().includes("latch-account") || r.status() >= 400) apiCalls.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
page.on("popup", (p) => popups.push(p.url()));
const log = (...a) => console.log(...a);

await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.getByRole("button", { name: /create one/i }).click();
await page.waitForTimeout(500);

await page.fill("#latch-signin-email", EMAIL);
await page.waitForTimeout(200);
await page.fill("#latch-signin-password", PASSWORD);
await page.waitForTimeout(500);
const vals = await page.evaluate(() => ({
  email: document.querySelector("#latch-signin-email")?.value,
  pwLen: document.querySelector("#latch-signin-password")?.value?.length,
}));
log("INPUT VALUES BEFORE CLICK:", JSON.stringify(vals));

await page.getByRole("button", { name: /create account/i }).click();
let outcome = "timeout";
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  if (!page.url().includes("/signin")) { outcome = "navigated:" + page.url(); break; }
  const alertEl = page.locator('[role="alert"]');
  if ((await alertEl.count()) > 0) { outcome = "alert:" + (await alertEl.first().innerText()).replace(/\n/g, " | ").slice(0, 300); break; }
}
log("SIGNUP OUTCOME:", outcome, `(email=${EMAIL})`);
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/qa-06-after-signup.png` });
log("URL:", page.url());
log("PAGE TEXT:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 1200)));

writeFileSync(`${OUT}/signup-state.json`, JSON.stringify({ email: EMAIL, password: PASSWORD, outcome }, null, 2));
console.log("\n=== API CALLS ==="); apiCalls.forEach((l) => console.log(l));
console.log("=== POPUPS ==="); popups.forEach((l) => console.log(l));
console.log("=== CONSOLE ERR ==="); consoleLines.filter((l) => l.includes("error")).forEach((l) => console.log(l.slice(0, 300)));
await browser.close();
