import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const { email, password } = JSON.parse(readFileSync(`${OUT}/signup-state.json`, "utf8"));
const WRONG = "WrongPass-9999";
const apiCalls = [];
const consoleErrs = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("response", (r) => { if (r.url().includes("latch-account") || r.status() >= 400) apiCalls.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErrs.push(m.text().slice(0, 200)); });

async function waitForEnd() {
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(1000);
    if (!page.url().includes("/signin")) return "navigated:" + page.url();
    const a = page.locator('[role="alert"]');
    if ((await a.count()) > 0) return "alert:" + (await a.first().innerText()).replace(/\n/g, " | ").slice(0, 300);
  }
  return "timeout";
}

// 0. Session persisted from previous run? (fresh context, so check localStorage-driven /signin card)
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2000);
log("STEP0 fresh-context /signin shows:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 200)));

// --- STEP 1: wrong password (password-first to bypass stale-closure bug)
// ensure signin mode (only toggle if currently in signup mode)
const mode1 = await page.getByRole("button", { name: /^sign in$/i }).count();
if (!mode1) {
  await page.getByRole("button", { name: /already have an account\? sign in/i }).click();
  await page.waitForTimeout(300);
}
log("STEP1 primary button:", JSON.stringify(await page.getByRole("button", { name: /^sign in$/i }).count()));
await page.click("#latch-signin-password");
await page.keyboard.type(WRONG, { delay: 3 });
await page.click("#latch-signin-email");
await page.keyboard.type(email, { delay: 3 });
await page.getByRole("button", { name: /^sign in$/i }).click();
const wrongPw = await waitForEnd();
log("STEP1 WRONG-PASSWORD OUTCOME:", wrongPw);
await page.screenshot({ path: `${OUT}/qa-09-wrong-password.png` });

// --- STEP 2: 409 already-exists (signup mode, existing email)
await page.getByRole("button", { name: /no account yet\? create one/i }).click();
await page.waitForTimeout(300);
await page.click("#latch-signin-password");
await page.keyboard.type(password, { delay: 3 });
await page.click("#latch-signin-email");
await page.keyboard.type(email, { delay: 3 });
await page.getByRole("button", { name: /create account/i }).click();
const dup = await waitForEnd();
log("STEP2 DUP-SIGNUP (409) OUTCOME:", dup);
await page.screenshot({ path: `${OUT}/qa-10-already-exists.png` });

// --- STEP 3: correct sign-in
await page.getByRole("button", { name: /already have an account\? sign in/i }).click();
await page.waitForTimeout(300);
await page.click("#latch-signin-password");
await page.keyboard.type(password, { delay: 3 });
await page.click("#latch-signin-email");
await page.keyboard.type(email, { delay: 3 });
await page.getByRole("button", { name: /^sign in$/i }).click();
const login = await waitForEnd();
log("STEP3 SIGN-IN OUTCOME:", login);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/qa-11-signin-success.png` });
log("STEP3 URL:", page.url());

// --- STEP 4: reload mid-session, check persistence
await page.reload({ waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(3000);
const afterReload = await page.evaluate(() => document.body.innerText.slice(0, 400));
log("STEP4 AFTER RELOAD URL:", page.url());
log("STEP4 PAGE TEXT:", JSON.stringify(afterReload));
await page.screenshot({ path: `${OUT}/qa-12-after-reload.png` });

// --- STEP 5: sign out via /signin card
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2000);
const cardText = await page.evaluate(() => document.body.innerText.slice(0, 400));
log("STEP5 /signin card:", JSON.stringify(cardText));
const signOutBtn = page.getByRole("button", { name: /sign out/i });
if (await signOutBtn.count()) {
  await signOutBtn.click();
  await page.waitForTimeout(3000);
  log("STEP5 after sign-out:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 300)));
  await page.screenshot({ path: `${OUT}/qa-13-after-signout.png` });
} else {
  log("STEP5: NO SIGN-OUT BUTTON FOUND on /signin");
}

console.log("=== API CALLS ==="); apiCalls.forEach((l) => console.log(l));
console.log("=== CONSOLE ERR/WARN ==="); [...new Set(consoleErrs)].slice(0, 15).forEach((l) => console.log(l));
await browser.close();
