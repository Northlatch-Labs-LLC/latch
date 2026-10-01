import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const { email } = JSON.parse(readFileSync(`${OUT}/post-qa-state.json`, "utf8"));
const password = "LatchQa-" + createHash("sha256").update(email).digest("hex").slice(0, 16) + "!9x";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const api = [];
page.on("response", (r) => { if (r.status() >= 400 || r.url().includes("/chat/completions") || r.url().includes("messages")) api.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`); });
await page.goto("https://latch.xlaunch.work/signin", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
for (const [sel, val] of [["#latch-signin-email", email], ["#latch-signin-password", password]]) {
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.type(val, { delay: 5 });
}
await page.getByRole("button", { name: /^sign in$/i }).click();
for (let i = 0; i < 60; i++) { await page.waitForTimeout(1000); if (!page.url().includes("/signin")) break; }
await page.waitForTimeout(3000);
for (let i = 0; i < 30 && !(await page.locator("textarea, [contenteditable=true]").first().isVisible().catch(() => false)); i++) await page.waitForTimeout(1000);
console.log("COMPOSER URL:", page.url());
console.log("BODY:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 300)));
await page.locator("textarea, [contenteditable=true]").first().click();
await page.keyboard.type("hi", { delay: 20 });
await page.keyboard.press("Enter");
await page.waitForTimeout(15000);
const show = page.getByRole("button", { name: /show details/i });
console.log("SHOW DETAILS COUNT:", await show.count());
if (await show.count()) {
  await show.click();
  await page.waitForTimeout(2000);
  console.log("DETAILS:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 1200)));
}
console.log("API:"); api.slice(0, 20).forEach((l) => console.log(l));
await page.screenshot({ path: "/tmp/dbg-send.png" });
await browser.close();
