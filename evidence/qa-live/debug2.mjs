import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const { email, password } = JSON.parse(readFileSync(`${OUT}/signup-state.json`, "utf8"));
const WRONG = "WrongPass-9999";
const apiCalls = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("response", (r) => { if (r.url().includes("latch-account") || r.status() >= 400) apiCalls.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

const dump = (label) =>
  page.evaluate((l) => {
    const e = document.querySelector("#latch-signin-email");
    const p = document.querySelector("#latch-signin-password");
    const btns = [...document.querySelectorAll("main button")].map((b) => b.innerText.trim());
    return `${l} | emailDOM=${JSON.stringify(e?.value)} pwDOM.len=${p?.value.length} btns=${JSON.stringify(btns)} alert=${JSON.stringify(document.querySelector('[role="alert"]')?.innerText ?? null)}`;
  }, label);

const waitForEnd = async () => {
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    if (!page.url().includes("/signin")) return "navigated:" + page.url();
    if ((await page.locator('[role="alert"]').count()) > 0)
      return "alert:" + (await page.locator('[role="alert"]').first().innerText()).replace(/\n/g, " | ").slice(0, 200);
  }
  return "timeout";
};

await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1500);
log(await dump("STEP1 start(signin-mode)"));

// STEP1: wrong password, password-first
await page.click("#latch-signin-password");
await page.keyboard.type(WRONG, { delay: 3 });
await page.click("#latch-signin-email");
await page.keyboard.type(email, { delay: 3 });
log(await dump("STEP1 filled"));
await page.getByRole("button", { name: /^sign in$/i }).click();
log("STEP1 OUTCOME:", await waitForEnd());

// STEP2: toggle to signup, existing email
await page.getByRole("button", { name: /no account yet\? create one/i }).click();
await page.waitForTimeout(400);
log(await dump("STEP2 toggled-to-signup"));
await page.click("#latch-signin-password");
await page.keyboard.type(password, { delay: 3 });
await page.click("#latch-signin-email");
await page.keyboard.type(email, { delay: 3 });
await page.waitForTimeout(400);
log(await dump("STEP2 filled"));
await page.getByRole("button", { name: /create account/i }).click();
log("STEP2 OUTCOME:", await waitForEnd());

// STEP3: toggle back to signin, correct creds
const toggle = page.getByRole("button", { name: /already have an account\? sign in/i });
if (await toggle.count()) { await toggle.click(); await page.waitForTimeout(400); }
log(await dump("STEP3 toggled-to-signin"));
await page.click("#latch-signin-password");
await page.keyboard.type(password, { delay: 3 });
await page.click("#latch-signin-email");
await page.keyboard.type(email, { delay: 3 });
await page.waitForTimeout(400);
log(await dump("STEP3 filled"));
await page.getByRole("button", { name: /^sign in$/i }).click();
const r3 = await waitForEnd();
log("STEP3 OUTCOME:", r3);
await page.waitForTimeout(3000);
log(await dump("STEP3 final"));
await page.screenshot({ path: `${OUT}/qa-11-signin-success.png` });

console.log("API:", apiCalls);
await browser.close();
