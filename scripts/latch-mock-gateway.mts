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
/** U-3 (INV-5): server-side caps enforced at the key. Unset = un-capped. */
const SESSION_CAP_USD = Number(process.env.LATCH_MOCK_SESSION_CAP_USD ?? '') || null;
const PER_CALL_CEILING_USD = Number(process.env.LATCH_MOCK_PER_CALL_CEILING_USD ?? '') || null;
/** Mirrors product/identity/price-table.yaml (USD per 1k tokens). */
const RATES: Record<string, { prompt: number; completion: number }> = {
  'latch-small': { prompt: 0.0005, completion: 0.0015 },
  'latch-large': { prompt: 0.003, completion: 0.015 },
};

let served = 0;
let spentUsd = 0;
/** Last metered calls, newest last — the `/` status page renders these. */
const calls: { n: number; time: string; model: string; promptTokens: number; completionTokens: number; costUsd: number }[] = [];

/** Human status page at `/` — the gateway is an API, so the root explains
 *  itself instead of 401-ing a browser. Auth stays mandatory on /v1/*. */
function statusPage(): string {
  const rows = [...calls]
    .reverse()
    .map(
      (c) =>
        `<tr><td>${c.n}</td><td>${c.time}</td><td>${c.model}</td><td>${c.promptTokens}</td><td>${c.completionTokens}</td><td>$${c.costUsd.toFixed(6)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Latch mock gateway</title>
<style>body{font-family:ui-sans-serif,system-ui;margin:2rem;color:#1a1a1a}table{border-collapse:collapse;margin-top:1rem}th,td{border:1px solid #ddd;padding:.35rem .7rem;text-align:left;font-variant-numeric:tabular-nums}th{background:#f5f5f5}h1{font-size:1.2rem}code{background:#f1f1f1;padding:.1rem .3rem;border-radius:3px}</style>
</head><body>
<h1>Latch mock gateway — metering live</h1>
<p><strong>${served}</strong> completions metered, <strong>$${spentUsd.toFixed(6)}</strong> accumulated this process.</p>
<p>Caps: ${SESSION_CAP_USD === null ? 'session cap unset' : `session cap <strong>$${SESSION_CAP_USD.toFixed(2)}</strong> (remaining <strong>$${Math.max(SESSION_CAP_USD - spentUsd, 0).toFixed(6)}</strong>)`} · ${PER_CALL_CEILING_USD === null ? 'per-call ceiling unset' : `per-call ceiling <strong>$${PER_CALL_CEILING_USD.toFixed(2)}</strong>`} — breaches refuse with HTTP 402 before generating.</p>
<p>API surface: <code>GET /v1/models</code>, <code>POST /v1/chat/completions</code> — every <code>/v1/*</code> request must carry <code>Authorization: Bearer latch-key-pro</code>; anything else is refused with 401.</p>
<table><tr><th>#</th><th>time</th><th>model</th><th>prompt</th><th>completion</th><th>cost</th></tr>
${rows || '<tr><td colspan="6">no calls yet — run the harness one-shot to see metering rows appear</td></tr>'}</table>
</body></html>`;
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const auth = req.headers.authorization;
    const send = (status: number, body: unknown, extraHeaders: Record<string, string> = {}) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        ...extraHeaders,
      };
      if (SESSION_CAP_USD !== null) {
        headers['x-latch-session-spend-usd'] = spentUsd.toFixed(6);
        headers['x-latch-session-remaining-usd'] = Math.max(SESSION_CAP_USD - spentUsd, 0).toFixed(6);
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    if (auth !== `Bearer ${KEY}`) {
      // Unauthenticated: /v1/* is refused (the one-key contract); the root
      // serves the human status page so a browser sees metering, not a 401.
      if (!(req.url ?? '').startsWith('/v1/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(statusPage());
        return;
      }
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
      // U-3 / INV-5: the gateway refuses BEFORE generating when a cap would
      // be breached — a projected call over the per-call ceiling, or one that
      // would push the session past its cap. Refusals meter nothing.
      if (PER_CALL_CEILING_USD !== null && costUsd > PER_CALL_CEILING_USD) {
        send(402, {
          error: {
            message: `projected cost $${costUsd.toFixed(6)} exceeds the per-call ceiling $${PER_CALL_CEILING_USD.toFixed(6)}`,
            type: 'insufficient_quota',
            code: 'per_call_ceiling_exceeded',
            projected_cost_usd: costUsd,
            per_call_ceiling_usd: PER_CALL_CEILING_USD,
          },
        });
        return;
      }
      if (SESSION_CAP_USD !== null && spentUsd + costUsd > SESSION_CAP_USD) {
        send(402, {
          error: {
            message: `projected session spend $${(spentUsd + costUsd).toFixed(6)} exceeds the session cap $${SESSION_CAP_USD.toFixed(6)}`,
            type: 'insufficient_quota',
            code: 'session_cap_exceeded',
            session_spend_usd: spentUsd,
            session_cap_usd: SESSION_CAP_USD,
          },
        });
        return;
      }
      served += 1;
      spentUsd += costUsd;
      calls.push({
        n: served,
        time: new Date().toISOString().slice(11, 19),
        model,
        promptTokens,
        completionTokens,
        costUsd,
      });
      if (calls.length > 50) calls.shift();
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
