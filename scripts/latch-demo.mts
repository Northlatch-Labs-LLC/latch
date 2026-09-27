#!/usr/bin/env tsx
// Latch G1 end-to-end demo — run with `pnpm exec tsx scripts/latch-demo.mts`.
//
// Boots the mock Northlatch Gateway on an ephemeral port, runs `latch doctor`
// against it (all six checks green), then drives metered chat completions
// through the real @latch/provider-gateway client and prints live per-call
// costs plus an exact reconciliation to the cent. No network beyond
// 127.0.0.1, no published packages — the product runs from this checkout.
import { spawn } from 'node:child_process';

import { readBrand } from './lib/brand.mjs';
import {
  chatCompletion,
  listModels,
  readConfig,
  type MeteringEvent,
  type MeteringSink,
} from '../packages/product/provider-gateway/src/index.js';
import { startMockServer, chatCompletionBody, type MockHandler } from '../packages/product/provider-gateway/test/mock-gateway.js';

const brand = readBrand();
const GATED_MODEL = 'latch-large';
const OPEN_MODEL = 'latch-small';
const KEY = 'latch-key-pro';
/** Mirrors product/identity/price-table.yaml (USD per 1k tokens). */
const RATES = {
  [GATED_MODEL]: { prompt: 0.003, completion: 0.015 },
  [OPEN_MODEL]: { prompt: 0.0005, completion: 0.0015 },
};

/** Deterministic schedule — same arithmetic as the G1 integration suite. */
const CALLS = 12;
const seeds = Array.from({ length: CALLS }, (_, i) => ({
  model: i % 3 === 0 ? OPEN_MODEL : GATED_MODEL,
  promptTokens: 120 + ((i * 37) % 480),
  completionTokens: 40 + ((i * 53) % 260),
}));

/** The mock gateway: bearer auth, catalog, seeded usage per completion. */
function gateway(seeds): MockHandler {
  let calls = 0;
  return (request, respond) => {
    if (request.headers.authorization !== `Bearer ${KEY}`) {
      respond(401, { error: { message: 'invalid api key' } });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      respond(200, {
        object: 'list',
        data: [
          { id: OPEN_MODEL, object: 'model', owned_by: 'latch' },
          { id: GATED_MODEL, object: 'model', owned_by: 'latch', plan_required: 'pro' },
        ],
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const seed = seeds[calls];
      const index = calls;
      calls += 1;
      respond(200, chatCompletionBody({
        id: `chatcmpl-demo-${index}`,
        model: seed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `demo reply ${index}` }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: seed.promptTokens,
          completion_tokens: seed.completionTokens,
          total_tokens: seed.promptTokens + seed.completionTokens,
        },
      }));
      return;
    }
    respond(404, { error: { message: `no route ${request.method} ${request.url}` } });
  };
}

const mock = await startMockServer(gateway(seeds));
const config = readConfig({ LATCH_GATEWAY_URL: mock.url, LATCH_API_KEY: KEY });
const cents = (usd) => Math.round(usd * 100);

console.log(`=== ${brand.productName} G1 end-to-end demo (mock gateway on ${mock.url}) ===\n`);

// 1. Doctor — every check green against the live mock. Async spawn (not
//    spawnSync): this process owns the mock server, and a sync spawn would
//    freeze the event loop the server needs to answer doctor's request.
const doctorEnv = { ...process.env, LATCH_GATEWAY_URL: mock.url, LATCH_API_KEY: KEY };
const doctor = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
  const child = spawn('node', [`${brand.repoRoot}/scripts/latch-doctor.mjs`], { env: doctorEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.on('close', (status) => resolve({ status, stdout }));
});
console.log(doctor.stdout.trim());
if (doctor.status !== 0) {
  console.error('\ndoctor failed — demo aborts');
  await mock.close();
  process.exit(1);
}

// 2. Catalog through the real client.
const catalog = await listModels(config);
console.log(`\ncatalog: ${catalog.data.map((m) => m.id).join(', ')}`);

// 3. Metered completions with a live cost line per call.
const events: MeteringEvent[] = [];
const sink: MeteringSink = { emit: (event) => events.push(event) };
console.log('\nlive metering:');
let runningUsd = 0;
for (const [index, seed] of seeds.entries()) {
  const result = await chatCompletion(
    config,
    { model: seed.model, messages: [{ role: 'user', content: `demo call ${index}` }] },
    { sink },
  );
  runningUsd += result.metering.costUsd;
  console.log(
    `  call ${String(index + 1).padStart(2)}  ${result.metering.model.padEnd(12)} ` +
    `prompt ${String(result.metering.promptTokens).padStart(4)}  completion ${String(result.metering.completionTokens).padStart(4)}  ` +
    `cost $${result.metering.costUsd.toFixed(6)}  running $${runningUsd.toFixed(6)}`,
  );
}

// 4. Reconciliation — client-accumulated cost vs independent arithmetic.
//    Round once at the end: per-call costs are far below a cent.
const expectedUsd = seeds.reduce(
  (sum, s) => sum + (s.promptTokens * RATES[s.model].prompt + s.completionTokens * RATES[s.model].completion) / 1000,
  0,
);
const expectedCents = cents(expectedUsd);
const accumulatedCents = cents(events.reduce((sum, e) => sum + e.costUsd, 0));
const reconciled = accumulatedCents === expectedCents;
console.log(
  `\nreconciliation: metered ${accumulatedCents}¢ vs arithmetic ${expectedCents}¢ → ${reconciled ? 'EXACT' : 'MISMATCH'}`,
);
await mock.close();
process.exit(reconciled ? 0 : 1);
