import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const { email } = JSON.parse(readFileSync(`${OUT}/post-qa-state.json`, "utf8"));
const password = "LatchQa-" + createHash("sha256").update(email).digest("hex").slice(0, 16) + "!9x";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto("https://latch.xlaunch.work/signin", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
// 可能残留已登录视图：直接清 localStorage 再来
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
for (const [sel, val] of [["#latch-signin-email", email], ["#latch-signin-password", password]]) {
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.type(val, { delay: 5 });
}
await page.getByRole("button", { name: /^sign in$/i }).click();
for (let i = 0; i < 60; i++) { await page.waitForTimeout(1000); if (!page.url().includes("/signin")) break; }
console.log("URL:", page.url());
await page.locator('[data-testid="task-settings-button"]').click();
await page.waitForTimeout(2500);
await page.getByText("Latch Account", { exact: true }).first().click();
await page.waitForTimeout(2500);
console.log("BODY:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 1500)));
const so = await page.locator('[data-testid="settings-latch-sign-out"]').count();
console.log("SIGNOUT COUNT:", so);
if (so) {
  await page.locator('[data-testid="settings-latch-sign-out"]').click();
  await page.waitForTimeout(2500);
  console.log("AFTER SIGNOUT TOKENS:", JSON.stringify(await page.evaluate(() => Object.keys(localStorage).filter(k => k.includes("latch")))));
}
await page.screenshot({ path: "/tmp/dbg-signout.png" });
await browser.close();
