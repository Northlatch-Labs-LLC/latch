#!/usr/bin/env node
// Latch doctor — install diagnostics, Node built-ins only.
//
// Six checks, each PASS/FAIL with detail; exit 0 only when every check passes.
// Against an unreachable gateway it fails loudly and fast (5s timeout), never
// hangs. `--json` emits one machine-readable object for CI.
//
// Brand rule (product/identity/brand.yaml is the only place identity lives):
// the product name and the default gateway URL are read from the manifest,
// never hardcoded here. The credential is never printed — not whole, not in
// part.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { readBrand } from './lib/brand.mjs';

const scriptDir = new URL('.', import.meta.url).pathname;
const repoRoot = path.resolve(scriptDir, '..');

/** One check result. `detail` must never contain the credential. */
function check(id, pass, detail) {
  return { id, status: pass ? 'pass' : 'fail', detail };
}

/** Walk the cause chain for a stable reason (ECONNREFUSED, timeout, …). */
function describeNetworkError(error) {
  let node = error;
  let deepestMessage = '';
  for (let depth = 0; node && depth < 5; depth += 1) {
    if (node.code) return node.code;
    if (node.name === 'TimeoutError' || node.name === 'AbortError') return 'timeout after 5s';
    if (node.message && !deepestMessage) deepestMessage = String(node.message);
    else if (node.message) deepestMessage = String(node.message);
    node = node.cause;
  }
  // The deepest cause carries the real story ("bad port", "connect ECONNREFUSED …").
  return deepestMessage || String(error);
}

const json = process.argv.includes('--json');
const brand = readBrand();
const checks = [];

// 1. Config — effective gateway URL is a parseable URL; the default from the
//    brand manifest is kept when LATCH_GATEWAY_URL is unset.
const envUrl = process.env.LATCH_GATEWAY_URL?.trim();
let baseUrl = envUrl || brand.gatewayBaseUrl;
try {
  const parsed = new URL(baseUrl);
  baseUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '');
  checks.push(
    check('config', true, `gateway URL ${baseUrl}${envUrl ? ' (from LATCH_GATEWAY_URL)' : ' (manifest default)'}`),
  );
} catch {
  checks.push(check('config', false, `LATCH_GATEWAY_URL is not a valid URL: ${baseUrl}`));
}

// 2. Key present — value never printed, not even a prefix.
const hasKey = Boolean(process.env.LATCH_API_KEY?.trim());
checks.push(
  check(
    'key',
    hasKey,
    hasKey ? 'LATCH_API_KEY is set (value hidden)' : 'LATCH_API_KEY is unset — requests go out anonymous and the gateway will answer 401',
  ),
);

// 3-5. Gateway round trip — one GET /v1/models, 5s budget, then classify.
let gatewayDescribed = false;
if (checks[0].status === 'pass') {
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      headers: hasKey ? { authorization: `Bearer ${process.env.LATCH_API_KEY.trim()}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    checks.push(check('reachability', true, `answered HTTP ${response.status} within 5s`));
    gatewayDescribed = true;
  } catch (error) {
    checks.push(check('reachability', false, `unreachable (${describeNetworkError(error)})`));
  }

  if (gatewayDescribed) {
    const status = response.status;
    checks.push(
      check(
        'auth',
        status === 200,
        status === 200
          ? 'credential accepted'
          : status === 401 || status === 403
            ? `gateway reachable but rejected the credential (HTTP ${status})`
            : `unexpected status ${status}`,
      ),
    );

    if (status === 200) {
      try {
        const catalog = await response.json();
        const models = Array.isArray(catalog?.data) ? catalog.data : [];
        const ids = models.map((m) => m?.id).filter(Boolean);
        checks.push(
          check('catalog', ids.length >= 1, ids.length >= 1 ? `${ids.length} models: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}` : 'catalog parsed but lists no models'),
        );
      } catch {
        checks.push(check('catalog', false, 'response body is not JSON'));
      }
    } else {
      checks.push(check('catalog', false, `skipped — no 200 catalog to parse (HTTP ${status})`));
    }
  } else {
    checks.push(check('auth', false, 'skipped — gateway unreachable'));
    checks.push(check('catalog', false, 'skipped — gateway unreachable'));
  }
} else {
  checks.push(check('reachability', false, 'skipped — no valid gateway URL'));
  checks.push(check('auth', false, 'skipped — no valid gateway URL'));
  checks.push(check('catalog', false, 'skipped — no valid gateway URL'));
}

// 6. Provider package importable — the shipped entry is TypeScript, so drive
//    it through the repo's tsx exactly as the test suite does. A source
//    checkout is required for this probe; the installed product (SEA harness
//    binary) bundles the provider, so the check degrades to a skip there.
const providerEntry = path.join(repoRoot, 'packages', 'product', 'provider-gateway', 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
if (existsSync(tsxBin)) {
  const importProbe = spawnSync(
    tsxBin,
    ['-e', `import(${JSON.stringify(providerEntry)}).then(m => { console.log(Object.keys(m).length); process.exit(0) }).catch(e => { console.error(e.message); process.exit(1) })`],
    { encoding: 'utf8', timeout: 30000 },
  );
  checks.push(
    check(
      'provider',
      importProbe.status === 0,
      importProbe.status === 0
        ? `@latch/provider-gateway entry imports cleanly (${importProbe.stdout.trim()} exports)`
        : `provider import failed: ${(importProbe.stderr || importProbe.error?.message || 'unknown error').trim().slice(0, 200)}`,
    ),
  );
} else {
  checks.push(
    check(
      'provider',
      true,
      'skipped — no source checkout here; the installed harness bundles the provider (SEA binary)',
    ),
  );
}

const ok = checks.every((c) => c.status === 'pass');

if (json) {
  console.log(JSON.stringify({ ok, checks }));
} else {
  console.log(`${brand.productName} doctor`);
  for (const c of checks) console.log(`  ${c.status === 'pass' ? 'PASS' : 'FAIL'}  ${c.id.padEnd(13)} ${c.detail}`);
  console.log(ok ? 'all checks passed' : 'one or more checks failed');
}
process.exit(ok ? 0 : 1);
