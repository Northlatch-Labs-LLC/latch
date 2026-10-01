// Xlaunch Gateway 配额错误分类（订阅门）单测：
// 402 account_balance_exhausted / 429 client_profile_cap_reached / 401 Invalid API key
// 三条旅程的判定与互斥性，见 src/lib/latchGatewayQuotaError.ts 顶部注释的到达路径。
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLatchGatewayQuotaError,
  formatLatchGatewayRetryWait,
} from "../src/lib/latchGatewayQuotaError.js";
// formatLatchBalanceUsd 从纯 lib 导入：组件文件带 @/ 别名的 runtime import，
// 根目录 tsx 直跑解析不到（tsconfig paths 不生效），纯函数必须留在无依赖的 lib 里。
import { formatLatchBalanceUsd } from "../src/lib/latchBalanceFormat.js";

test("402 account_balance_exhausted classifies as out-of-credit from error.code", () => {
  assert.deepEqual(
    classifyLatchGatewayQuotaError({
      code: "account_balance_exhausted",
      message: 'Account balance exhausted for "Latch Desktop". Add credit to continue.',
      attribution: { statusCode: 402, providerErrorCode: "account_balance_exhausted" },
    }),
    { kind: "out-of-credit", statusCode: 402, retryAfterMs: null },
  );
  // attribution 丢失（strict zod 解析失败）时仍按 code 命中，状态码回退 402。
  assert.deepEqual(
    classifyLatchGatewayQuotaError({
      code: "account_balance_exhausted",
      message: "Account balance exhausted.",
    }),
    { kind: "out-of-credit", statusCode: 402, retryAfterMs: null },
  );
});

test("429 client_profile_cap_reached classifies as token-cap-reached and carries Retry-After", () => {
  assert.deepEqual(
    classifyLatchGatewayQuotaError({
      code: "client_profile_cap_reached",
      message: 'Token cap reached for "Latch Desktop": 20000 of 20000 tokens used this day.',
      attribution: { statusCode: 429, providerErrorCode: "client_profile_cap_reached" },
      retryAfterMs: 3_600_000,
    }),
    { kind: "token-cap-reached", statusCode: 429, retryAfterMs: 3_600_000 },
  );
  // 无 Retry-After 旁路时 retryAfterMs 为 null（v4 会话错误通道不携带该字段）。
  assert.deepEqual(
    classifyLatchGatewayQuotaError({
      code: "client_profile_cap_reached",
      message: "Token cap reached.",
    }),
    { kind: "token-cap-reached", statusCode: 429, retryAfterMs: null },
  );
});

test("401 with the gateway's Invalid API key body classifies as gateway-reauth", () => {
  // 401 无业务 code：code=provider_not_configured，网关原文留在 underlying/detail。
  assert.deepEqual(
    classifyLatchGatewayQuotaError({
      code: "provider_not_configured",
      message: "Provider authentication failed.",
      detail: "Invalid API key",
      attribution: { statusCode: 401 },
    }),
    { kind: "gateway-reauth", statusCode: 401, retryAfterMs: null },
  );
  assert.deepEqual(
    classifyLatchGatewayQuotaError({
      code: "provider_not_configured",
      message: "Provider authentication failed.",
      underlyingErrorMessage: "Invalid API key",
      attribution: { statusCode: 401 },
    }),
    { kind: "gateway-reauth", statusCode: 401, retryAfterMs: null },
  );
});

test("other providers' 401/429/errors do not classify as gateway quota journeys", () => {
  // 其他 provider 的 401：状态码相同但没有网关原文。
  assert.equal(
    classifyLatchGatewayQuotaError({
      code: "provider_not_configured",
      message: "Provider authentication failed.",
      attribution: { statusCode: 401 },
    }),
    null,
  );
  // 普通 429（无限额 code）不进入升级旅程。
  assert.equal(
    classifyLatchGatewayQuotaError({
      code: "model_rate_limited",
      message: "Provider rate limited the model request.",
      attribution: { statusCode: 429 },
    }),
    null,
  );
  // 网关原文但状态码不是 401（例如别的 provider 同文案）不命中。
  assert.equal(
    classifyLatchGatewayQuotaError({
      code: "unknown",
      message: "Invalid API key",
      attribution: { statusCode: 403 },
    }),
    null,
  );
  assert.equal(classifyLatchGatewayQuotaError(null), null);
});

test("retry wait formats minutes and hours for the token-cap banner", () => {
  const passthrough = (id: string, values?: Record<string, string>) =>
    values ? `${id}:${JSON.stringify(values)}` : id;
  assert.equal(formatLatchGatewayRetryWait(null, passthrough), null);
  assert.equal(formatLatchGatewayRetryWait(0, passthrough), null);
  assert.equal(
    formatLatchGatewayRetryWait(3_600_000, passthrough),
    'chat.error.latchGateway.retryWaitHours:{"count":"1"}',
  );
  assert.equal(
    formatLatchGatewayRetryWait(90_000, passthrough),
    'chat.error.latchGateway.retryWaitMinutes:{"count":"2"}',
  );
});

test("sidebar chip balance formatting keeps sub-cent balances visible", () => {
  assert.equal(formatLatchBalanceUsd(12_340_000), "$12.34");
  assert.equal(formatLatchBalanceUsd(0), "$0.00");
  assert.equal(formatLatchBalanceUsd(5_000), "<$0.01");
  assert.equal(formatLatchBalanceUsd(1), "<$0.01");
});
