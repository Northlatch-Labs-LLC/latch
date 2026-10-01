import { chromium } from "playwright";

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
const consoleLines = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("response", (r) => { if (r.url().includes("latch-account")) apiCalls.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
const log = (...a) => console.log(...a);

await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.getByRole("button", { name: /create one/i }).click();
await page.waitForTimeout(400);

// REAL keyboard typing, char by char
await page.click("#latch-signin-email");
await page.keyboard.type(EMAIL, { delay: 5 });
await page.click("#latch-signin-password");
await page.keyboard.type(PASSWORD, { delay: 5 });
await page.waitForTimeout(400);
log("Typed inputs; DOM value len:", await page.evaluate(() => document.querySelector("#latch-signin-password").value.length));

await page.getByRole("button", { name: /create account/i }).click();
let outcome = "timeout";
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  if (!page.url().includes("/signin")) { outcome = "navigated:" + page.url(); break; }
  const a = page.locator('[role="alert"]');
  if ((await a.count()) > 0) { outcome = "alert:" + (await a.first().innerText()).replace(/\n/g, " | ").slice(0, 300); break; }
}
log("TYPED-SIGNUP OUTCOME:", outcome);
await page.screenshot({ path: `${OUT}/qa-06-after-signup-typed.png` });
console.log("API:", apiCalls);
console.log("CONSOLE ERR:", consoleLines.filter((l) => l.startsWith("[error") || l.startsWith("[warning")).slice(0, 10));
await browser.close();
