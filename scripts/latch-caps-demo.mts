#!/usr/bin/env tsx
// Caps demo — the HUD P0 loop end to end against the mock gateway:
//   1. a metered call under the caps passes and feeds the rail (U-1),
//   2. a call over the per-call ceiling is REFUSED by the gateway with 402
//      per_call_ceiling_exceeded before generation (U-3, INV-5 server-side),
//   3. the same call is stopped CLIENT-side by the advisory pre-flight
//      projection without touching the network (U-3 client seam),
//   4. a projection that first crosses 80% of the session cap fires the
//      one-shot runaway-guard warning (U-2; D-d policy stays open).
//   pnpm exec tsx scripts/latch-caps-demo.mts
import { spawn } from 'node:child_process';

import {
  chatCompletion,
  createSessionCapLedger,
  estimateCallCostUsd,
  GatewayCapError,
  loadPriceTable,
  PerCallCeilingExceededError,
} from '../packages/product/provider-gateway/src/index.js';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_CAP_USD = 0.025; // threshold 0.8 → $0.02; the U-2 projection ($0.021) crosses it
const PER_CALL_CEILING_USD = 0.002;

const mock = spawn(
  process.execPath,
  ['--import', 'tsx', 'scripts/latch-mock-gateway.mts'],
  {
    env: {
      ...process.env,
      LATCH_MOCK_PORT: String(PORT),
      LATCH_MOCK_SESSION_CAP_USD: String(SESSION_CAP_USD),
      LATCH_MOCK_PER_CALL_CEILING_USD: String(PER_CALL_CEILING_USD),
    },
    stdio: 'ignore',
  },
);
const waitForPort = async () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`${BASE}/v1/models`, { headers: { authorization: 'Bearer latch-key-pro' } });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('mock gateway did not come up');
};

try {
  await waitForPort();
  const priceTable = loadPriceTable();
  const ledger = createSessionCapLedger({ capUsd: SESSION_CAP_USD, perCallCeilingUsd: PER_CALL_CEILING_USD });
  const config = { baseUrl: BASE, apiKey: 'latch-key-pro' };

  // 1. Under-cap call: passes, meters, feeds the rail.
  const ok = await chatCompletion(config, {
    model: 'latch-small',
    messages: [{ role: 'user', content: 'Say exactly: CAPS DEMO OK' }],
  });
  ledger.record(ok.metering);
  console.log(`1. passed  : "${ok.content}" cost=$${ok.metering.costUsd}`);

  // 2. Over-ceiling call: the gateway refuses with 402 before generating.
  // 2200 chars ≈ 555 prompt tokens; latch-large ≈ 555*0.003 + 24*0.015 = $0.002025 > ceiling.
  const bigPrompt = 'x'.repeat(2200);
  let serverCode = '';
  try {
    await chatCompletion(config, {
      model: 'latch-large',
      messages: [{ role: 'user', content: bigPrompt }],
    });
    console.log('2. UNEXPECTED: over-ceiling call was served');
    process.exit(1);
  } catch (error) {
    if (error instanceof GatewayCapError) {
      serverCode = error.code;
      console.log(`2. refused : gateway 402 code=${error.code} retryable=${error.retryable}`);
    } else {
      throw error;
    }
  }

  // 3. Advisory pre-flight: the same call never reaches the network.
  //    555 prompt tokens matches step 2's shape: 555*0.003 + 24*0.015 = $0.002025.
  const projected = estimateCallCostUsd(
    { model: 'latch-large', promptTokens: 555, maxCompletionTokens: 24 },
    priceTable,
  );
  try {
    if (projected > PER_CALL_CEILING_USD) {
      throw new PerCallCeilingExceededError(projected, PER_CALL_CEILING_USD);
    }
    console.log('3. UNEXPECTED: pre-flight did not stop the call');
    process.exit(1);
  } catch (error) {
    if (error instanceof PerCallCeilingExceededError) {
      console.log(`3. preflight: stopped client-side (projected $${error.projectedCostUsd} > ceiling $${error.ceilingUsd})`);
    } else {
      throw error;
    }
  }

  // 4. Runaway-guard signal: first projection crossing 80% of the cap warns once.
  const crossing = ledger.projectCall({
    model: 'latch-large',
    promptTokens: 2000,
    maxCompletionTokens: 1000,
    priceTable,
  });
  console.log(`4. u2 signal: ${crossing.warning ?? '(no warning)'}`);
  const again = ledger.projectCall({
    model: 'latch-large',
    promptTokens: 2000,
    maxCompletionTokens: 1000,
    priceTable,
  });
  console.log(`   one-shot : second projection warns=${again.warning === null ? 'never' : 'AGAIN'} fired=${ledger.warningFired()}`);

  const rail = ledger.railReading();
  console.log(`5. rail    : spend=$${rail.spendUsd} cap=$${rail.capUsd} remaining=$${rail.remainingUsd} events=${rail.events}`);

  const pass = serverCode === 'per_call_ceiling_exceeded' && crossing.warning !== null && again.warning === null;
  console.log(`CAPS-DEMO-${pass ? 'OK' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
} finally {
  mock.kill('SIGTERM');
}
