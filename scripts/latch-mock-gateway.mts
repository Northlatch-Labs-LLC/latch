#!/usr/bin/env tsx
// Local mock Northlatch Gateway — serves the gateway contract (see
// packages/product/provider-gateway README) on a fixed port so the harness
// CLI can be pointed at a metered endpoint without network or keys.
//
//   pnpm exec tsx scripts/latch-mock-gateway.mts          # port 8787
//   LATCH_MOCK_PORT=9000 pnpm exec tsx scripts/...        # custom port
//
// Deterministic by design: the reply text is fixed, and usage grows with the
// request size, so cost metering is observable and reproducible.
import { createServer } from 'node:http';

const PORT = Number(process.env.LATCH_MOCK_PORT ?? 8787);
const KEY = process.env.LATCH_MOCK_KEY ?? 'latch-key-pro';
/** Mirrors product/identity/price-table.yaml (USD per 1k tokens). */
const RATES: Record<string, { prompt: number; completion: number }> = {
  'latch-small': { prompt: 0.0005, completion: 0.0015 },
  'latch-large': { prompt: 0.003, completion: 0.015 },
};

let served = 0;
let spentUsd = 0;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const auth = req.headers.authorization;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };
    if (auth !== `Bearer ${KEY}`) {
      send(401, { error: { message: 'invalid api key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      send(200, {
        object: 'list',
        data: [
          { id: 'latch-small', object: 'model', owned_by: 'latch' },
          { id: 'latch-large', object: 'model', owned_by: 'latch', plan_required: 'pro' },
        ],
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string;
        stream?: boolean;
        messages?: { content: unknown }[];
      };
      const model = body.model && RATES[body.model] ? body.model : 'latch-small';
      const promptChars = JSON.stringify(body.messages ?? '').length;
      const promptTokens = Math.max(16, Math.ceil(promptChars / 4));
      const completionTokens = 24;
      const costUsd =
        (promptTokens * RATES[model].prompt + completionTokens * RATES[model].completion) / 1000;
      served += 1;
      spentUsd += costUsd;
      const content = `mock ${model} reply #${served}: LATCH BOOT OK`;
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      console.error(
        `[mock-gateway] call ${served}: ${model} pt=${promptTokens} ct=${completionTokens} cost=$${costUsd.toFixed(6)} session=$${spentUsd.toFixed(6)}`,
      );
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: Record<string, unknown>) =>
          `data: ${JSON.stringify({ id: `chatcmpl-mock-${served}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(chunk({ content }));
        res.write(
          `data: ${JSON.stringify({ id: `chatcmpl-mock-${served}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      send(200, {
        id: `chatcmpl-mock-${served}`,
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      });
      return;
    }
    send(404, { error: { message: `no route ${req.method} ${req.url}` } });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[mock-gateway] listening on http://127.0.0.1:${PORT} (key: ${KEY.slice(0, 5)}…)`);
});
