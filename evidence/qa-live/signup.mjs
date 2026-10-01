import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const EMAIL = process.env.QA_EMAIL || `latch-qa-${Date.now()}@northlatch.dev`;
// 口令只从环境变量读取，绝不硬编码进仓库文件（本目录会随修复入库）。
const PASSWORD = process.env.LATCH_QA_PASSWORD;
if (!PASSWORD) {
  console.error("env var LATCH_QA_PASSWORD is required");
  process.exit(1);
}
const consoleLines = [];
const failedRequests = [];
const badResponses = [];
const popups = [];
const apiCalls = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

page.on("console", (m) => consoleLines.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (r.url().includes("latch-account") || r.status() >= 400)
    apiCalls.push(`${r.status()} ${r.request().method()} ${r.url()}`);
});
page.on("popup", (p) => popups.push(p.url()));

const log = (...a) => console.log(...a);

// --- Step 1: /signin, switch to signup mode
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.getByRole("button", { name: /create one/i }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/qa-04-signup-mode.png` });
const btnText = await page.locator("main button").first().innerText().catch(() => "?");
log("Toggled to signup; primary button now reads:", JSON.stringify(btnText));

// --- Step 2: client-side validation errors
await page.fill("#latch-signin-email", "not-an-email");
await page.fill("#latch-signin-password", "short");
await page.getByRole("button", { name: /create account|sign up/i }).click();
await page.waitForTimeout(400);
const validationError = await page.locator('[role="alert"]').innerText().catch(() => "(none)");
log("CLIENT VALIDATION ERROR SHOWN:", JSON.stringify(validationError));
await page.screenshot({ path: `${OUT}/qa-05-signup-validation.png` });

// --- Step 3: real signup
await page.fill("#latch-signin-email", EMAIL);
await page.fill("#latch-signin-password", PASSWORD);
log("Submitting signup for", EMAIL);
const t0 = Date.now();
await page.getByRole("button", { name: /create account|sign up/i }).click();

// watch for up to 45s for either error alert or navigation away from /signin
let outcome = "timeout";
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(1000);
  if (!page.url().includes("/signin")) { outcome = "navigated-to:" + page.url(); break; }
  const alert = await page.locator('[role="alert"]').count();
  if (alert > 0) { outcome = "alert:" + (await page.locator('[role="alert"]').first().innerText()).slice(0, 300); break; }
  const signedInHeading = await page.getByText(/mint|provision|key/i).count();
  if (signedInHeading > 0) log(`  t+${i}s: stage text visible`);
}
log(`SIGNUP OUTCOME after ${Date.now() - t0}ms:`, outcome);
await page.screenshot({ path: `${OUT}/qa-06-after-signup.png`, fullPage: false });
log("URL now:", page.url());

// dump signed-in card / workspace state
const state = await page.evaluate(() => document.body.innerText.slice(0, 1500));
log("PAGE TEXT:", JSON.stringify(state));

writeFileSync(`${OUT}/signup-state.json`, JSON.stringify({ email: EMAIL, password: PASSWORD, outcome, url: page.url() }, null, 2));

console.log("\n=== LATCH-ACCOUNT / >=400 API CALLS ==="); apiCalls.forEach((l) => console.log(l));
console.log("\n=== FAILED REQUESTS ==="); failedRequests.forEach((l) => console.log(l));
console.log("\n=== POPUPS ==="); popups.forEach((l) => console.log(l));
console.log("\n=== CONSOLE (errors/warnings only) ===");
consoleLines.filter((l) => !l.startsWith("[console.log]")).forEach((l) => console.log(l.slice(0, 400)));

await browser.close();
