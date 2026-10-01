import { chromium } from "playwright";

const BASE = "https://latch.xlaunch.work";
const OUT = "/Users/admin/Desktop/northlatch-harness/latch/evidence/qa-live";
const consoleLines = [];
const failedRequests = [];
const badResponses = [];
const popups = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

page.on("console", (m) => consoleLines.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
ctx.on("page", (p) => popups.push(p.url()));
page.on("popup", (p) => popups.push(p.url()));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(2000);
console.log("URL:", page.url());
console.log("TITLE:", await page.title());
await page.screenshot({ path: `${OUT}/qa-01-landing.png`, fullPage: false });

// Dump interactive elements
const els = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("button, a, [role=button], input")) {
    out.push({
      tag: el.tagName,
      text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 80),
      href: el.tagName === "A" ? el.getAttribute("href") : undefined,
      tid: el.getAttribute("data-testid") || undefined,
      id: el.id || undefined,
      visible: !!(el.offsetWidth || el.offsetHeight),
    });
  }
  return out;
});
console.log("ELEMENTS:", JSON.stringify(els, null, 1).slice(0, 6000));

console.log("\n=== CONSOLE ==="); consoleLines.forEach((l) => console.log(l));
console.log("\n=== FAILED REQUESTS ==="); failedRequests.forEach((l) => console.log(l));
console.log("\n=== >=400 RESPONSES ==="); badResponses.forEach((l) => console.log(l));
console.log("\n=== POPUPS ==="); popups.forEach((l) => console.log(l));

await browser.close();
