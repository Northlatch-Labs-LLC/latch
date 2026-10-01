import { chromium } from 'playwright';

const BASE = 'https://latch.xlaunch.work';
const email = `latch-pay-${Date.now()}@northlatch.dev`;
const password = 'PayPath-Prove-2026!x';
const log = (...a) => console.log('[pay-qa]', ...a);

const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

// 1. Account + key
const su = await api('/api/latch-account/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
if (!su.body.token) throw new Error('signup failed: ' + JSON.stringify(su.body));
const token = su.body.token;
log('signup OK', email);
const key = await api('/api/latch-account/keys', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'Latch pay-qa' }) });
if (!key.body.key) throw new Error('key mint failed: ' + JSON.stringify(key.body));
const skKey = key.body.key;
log('gateway key minted', key.body.id);

// 2. Checkout session
const co = await api('/api/latch-billing/checkout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ planId: 'latch-monthly' }) });
if (!co.body.url) throw new Error('checkout failed: ' + JSON.stringify(co.body));
log('stripe checkout session:', co.body.url.slice(0, 60) + '…');

// 3. Pay with the test card
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(co.body.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
log('on Stripe checkout page');
const payFrame = page.frameLocator('iframe[src*="js.stripe.com"]').first();
// Stripe hosted checkout renders fields in nested iframes; use test-clock friendly fills
await page.waitForTimeout(4000);
let paid = false;
for (let attempt = 0; attempt < 3 && !paid; attempt++) {
  try {
    const numFrame = page.frameLocator('iframe[title*="card number" i], iframe[name*="__privateStripeFrame"]').first();
    await numFrame.locator('input[name="cardNumber"], input[autocomplete="cc-number"]').first().fill('4242 4242 4242 4242', { timeout: 15000 });
    await numFrame.locator('input[name="cardExpiry"], input[autocomplete="cc-exp"]').first().fill('12 / 34', { timeout: 10000 });
    await numFrame.locator('input[name="cardCvc"], input[autocomplete="cc-csc"]').first().fill('123', { timeout: 10000 });
    const btn = page.locator('button:has-text("Subscribe"), button:has-text("Pay"), button:has-text("Start trial")').first();
    await btn.click({ timeout: 15000 });
    paid = true;
    log('payment submitted');
  } catch (e) {
    log('pay attempt ' + attempt + ' failed: ' + e.message.split('\n')[0]);
    await page.waitForTimeout(3000);
  }
}
if (!paid) {
  await page.screenshot({ path: 'evidence/qa-live/pay-fail-page.png', fullPage: true });
  await browser.close();
  throw new Error('could not complete Stripe payment form');
}
// 4. Wait for the success return
let landed = false;
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  if (page.url().includes('checkout=success')) { landed = true; break; }
}
log('returned to site:', page.url());
await page.screenshot({ path: 'evidence/qa-live/pay-return.png', fullPage: true });
await browser.close();
if (!landed) throw new Error('never returned to checkout=success; last url: ' + page.url());

// 5. Credit must land via webhook
let balance = 0;
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const me = await api('/api/latch-account/me', { headers: { Authorization: `Bearer ${token}` } });
  balance = me.body.balanceMicros ?? 0;
  if (balance > 0) break;
}
log('balance micros:', balance);
if (!(balance >= 1400_000_000)) throw new Error('credit did not land; balanceMicros=' + balance);

// 6. Paid model call through the gateway
const call = await fetch('https://gateway.xlaunch.work/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${skKey}` },
  body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'Reply with the single word: paid' }], max_tokens: 10 }),
});
const cb = await call.json().catch(() => ({}));
log('model call HTTP', call.status, '| reply:', (cb.choices?.[0]?.message?.content || '').slice(0, 60));
if (call.status !== 200) throw new Error('paid model call failed: HTTP ' + call.status + ' ' + JSON.stringify(cb).slice(0, 200));

console.log('PAY-PATH: PASS — signup → subscribe ($14 test payment) → credit granted → paid model call 200');
console.log(JSON.stringify({ email, password, balance, keyId: key.body.id }));
