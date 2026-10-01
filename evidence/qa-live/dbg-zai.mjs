import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
// 拦截 share preview：模拟 private 分享的 401（login_required）状态，检验登录区与 z.ai 控件渲染。
await page.route("**/api/v1/shares/*/preview", (route) =>
  route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { message: "authentication required" } }) }));
await page.goto("https://latch.xlaunch.work/share/qa-live-probe", { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);
console.log("URL:", page.url());
console.log("TEXT:", JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 500)));
await page.screenshot({ path: "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live/post-16-zai-control.png" });
const zai = page.locator('[data-share-login-provider="zai"]');
const latch = page.locator('[data-share-login-provider="latch-account"]');
console.log("ZAI BTN:", await zai.count(), "LATCH BTN:", await latch.count());
if (await zai.count()) {
  await zai.click();
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    if (!page.url().includes("latch.xlaunch.work")) break;
  }
  console.log("AUTHORIZE URL:", page.url());
  await page.screenshot({ path: "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live/post-17-zai-authorize.png" });
}
await browser.close();
