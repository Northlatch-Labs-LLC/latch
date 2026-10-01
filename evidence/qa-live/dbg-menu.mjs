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
await page.waitForTimeout(3000);
await page.click('[data-testid="login-trigger"]');
await page.waitForTimeout(1200);
const items = await page.evaluate(() =>
  [...document.querySelectorAll('[role="menuitem"], [role="menu"] button')].map((el) => ({ tid: el.getAttribute("data-testid"), text: el.innerText.trim().slice(0, 50) })).filter((x) => x.text),
);
console.log("MENU:", JSON.stringify(items, null, 1));
await page.screenshot({ path: "/tmp/dbg-menu.png" });
await browser.close();
