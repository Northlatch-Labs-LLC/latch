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

async function setField(sel, val) {
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.type(val, { delay: 2 });
}
const fieldState = () =>
  page.evaluate(() => ({
    email: document.querySelector("#latch-signin-email")?.value,
    pwLen: document.querySelector("#latch-signin-password")?.value?.length,
  }));
const waitForEnd = async () => {
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    if (!page.url().includes("/signin")) return "navigated:" + page.url();
    if ((await page.locator('[role="alert"]').count()) > 0)
      return "alert:" + (await page.locator('[role="alert"]').first().innerText()).replace(/\n/g, " | ").slice(0, 250);
  }
  return "timeout";
};

await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(1500);

// STEP1: wrong password -> expect 401 "Incorrect email or password"
await setField("#latch-signin-password", WRONG);
await setField("#latch-signin-email", email);
log("STEP1 fields:", JSON.stringify(await fieldState()));
await page.getByRole("button", { name: /^sign in$/i }).click();
log("STEP1 WRONG-PASSWORD:", await waitForEnd());
await page.screenshot({ path: `${OUT}/qa-09-wrong-password.png` });

// STEP2: dup signup -> expect 409 + switch-back hint
await page.getByRole("button", { name: /no account yet\? create one/i }).click();
await page.waitForTimeout(300);
await setField("#latch-signin-password", password);
await setField("#latch-signin-email", email);
log("STEP2 fields:", JSON.stringify(await fieldState()));
await page.getByRole("button", { name: /create account/i }).click();
log("STEP2 DUP-SIGNUP:", await waitForEnd());
await page.screenshot({ path: `${OUT}/qa-10-already-exists.png` });

// STEP3: back to signin, correct creds
await page.getByRole("button", { name: /already have an account\? sign in/i }).click();
await page.waitForTimeout(300);
await setField("#latch-signin-password", password);
await setField("#latch-signin-email", email);
log("STEP3 fields:", JSON.stringify(await fieldState()));
await page.getByRole("button", { name: /^sign in$/i }).click();
log("STEP3 SIGN-IN:", await waitForEnd());
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/qa-11-signin-success.png` });
log("STEP3 URL:", page.url());

// STEP4: reload mid-session -> persistence
await page.reload({ waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(3000);
log("STEP4 AFTER RELOAD URL:", page.url());
log("STEP4 TEXT:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 300)));
await page.screenshot({ path: `${OUT}/qa-12-after-reload.png` });

// STEP5: /signin card + sign out
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2500);
log("STEP5 CARD:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 400)));
const so = page.getByRole("button", { name: /sign out/i });
if (await so.count()) {
  await so.click();
  await page.waitForTimeout(3000);
  log("STEP5 AFTER SIGN-OUT:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 250)));
  await page.screenshot({ path: `${OUT}/qa-13-after-signout.png` });
} else {
  log("STEP5: no sign-out button on /signin card");
}

console.log("API:", apiCalls);
await browser.close();
