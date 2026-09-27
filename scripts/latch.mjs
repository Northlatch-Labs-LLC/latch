#!/usr/bin/env node
// latch — the product entry point. One key in (LATCH_API_KEY), harness out.
//
// What this does on every launch:
//   1. Reads the gateway target (LATCH_GATEWAY_URL, default from the brand
//      manifest) and the unified key (LATCH_API_KEY).
//   2. Fetches the live model catalog from the gateway (GET /v1/models,
//      3s budget) so the harness offers exactly what the key's plan serves;
//      falls back to the manifest defaults when unreachable.
//   3. Writes/refreshes the generated provider config under the product
//      config dir (brand.yaml `config_dir`, overridable via LATCH_HOME).
//   4. Execs the built harness with ZCODE_DATA_BASE_DIR +
//      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE pointed at product-owned state.
//
// Thin-fork rule: the harness binary is never edited; this launcher is the
// product seam. Run `pnpm run latch -- <any harness args>`; `-p "…"` works
// headless exactly like the raw CLI.
//
// If no key is set the harness still launches (it will refuse model calls
// with 401 from the gateway) and a notice points at `pnpm run doctor`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readBrand } from './lib/brand.mjs';

const brand = readBrand();

const gatewayUrl = (process.env.LATCH_GATEWAY_URL?.trim() || brand.gatewayBaseUrl || '').replace(/\/+$/, '');
const apiKey = process.env.LATCH_API_KEY?.trim() || '';
const home = process.env.LATCH_HOME?.trim() || path.join(process.env.HOME ?? '.', '.latch');
const configDir = path.join(home, 'v2');
const configFile = path.join(configDir, 'provider_config.json');

const FALLBACK_MODELS = ['latch-small', 'latch-large'];

async function fetchCatalog() {
  try {
    const response = await fetch(`${gatewayUrl}/v1/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { models: FALLBACK_MODELS, live: false };
    const catalog = await response.json();
    const ids = (Array.isArray(catalog?.data) ? catalog.data : [])
      .map((m) => m?.id)
      .filter((id) => typeof id === 'string' && id.length > 0);
    return ids.length > 0 ? { models: ids, live: true } : { models: FALLBACK_MODELS, live: false };
  } catch {
    return { models: FALLBACK_MODELS, live: false };
  }
}

function findHarnessBin() {
  const override = process.env.LATCH_BIN?.trim();
  if (override) return override;
  const candidates = [
    path.join(brand.repoRoot, 'dist/runtime/zcode/bin/zcode.mjs'),
    path.join(brand.repoRoot, 'dist/zcode/bin/zcode.mjs'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

const { models, live } = await fetchCatalog();
const config = {
  schemaVersion: 1,
  config: {
    providerOrder: ['latch-gateway'],
    providerConfigRules: {
      providerRules: [
        {
          providerId: 'latch-gateway',
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: apiKey || 'unset' },
            api: { type: 'openai-chat-completions', baseUrl: `${gatewayUrl}/v1` },
            personalModelIds: models,
            modelOrder: models,
            visibility: 'visible',
          },
        },
      ],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: 'latch-gateway', modelId: models[0] },
  },
};

mkdirSync(configDir, { recursive: true });
writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

if (!apiKey) {
  console.error(`latch: LATCH_API_KEY is not set — the harness will launch, but every model call will be refused (401) by the gateway. Run \`pnpm run doctor\` for the six-check diagnosis.`);
} else if (!live) {
  console.error(`latch: gateway catalog unreachable at ${gatewayUrl} — using manifest default models. Run \`pnpm run doctor\` for the six-check diagnosis.`);
}

const bin = findHarnessBin();
if (!bin) {
  console.error('latch: harness bundle not found — build it first: pnpm build:zcode --base-url http://127.0.0.1/zcode/deps/zcode/');
  process.exit(1);
}

const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR ?? home,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: configFile,
  },
});
child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
