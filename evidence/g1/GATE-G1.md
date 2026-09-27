# GATE G1 — verdict GREEN

Date: 2026-09-27. All commands run from this checkout, no published packages
(INV-11: no gate depends on npm publication).

## Gate commands and exit codes

| gate | command | exit |
| --- | --- | --- |
| product tests (incl. G1 integration suite) | `pnpm run test:product` | 0 |
| lint | `pnpm run lint` | 0 |
| brand lint | `node scripts/brand-lint.mjs` | 0 (strict scope clean) |
| typecheck | `pnpm run typecheck` | 0 |

## What G1 delivered

- **T-A4 metering** (commit 4508a2a): `@latch/provider-gateway` prices every
  chat completion from `product/identity/price-table.yaml` and emits a
  `MeteringEvent` (model, tokens, costUsd, requestId) to a sink before the
  result resolves; responses without usage still emit a zero-cost event.
- **Integration suite** (`packages/product/provider-gateway/test/integration.g1.test.ts`):
  three tests against a real-socket mock gateway — catalog + server-side plan
  gating (free key 403s on the gated model, entitled key passes); auth header
  contract (every `/v1/*` request bears `Bearer <LATCH_API_KEY>`, unknown key
  401s as `GatewayAuthError`); and the metering reconciliation: 100 seeded
  calls accumulate a cost equal to independently computed arithmetic, exact in
  integer cents and in integer nano-USD.
- **`latch doctor`** (`scripts/latch-doctor.mjs`, `pnpm run doctor`): six
  checks — config URL, key presence (value never printed), reachability with a
  5s budget, credential acceptance, catalog parse, provider importability —
  each PASS/FAIL, `--json` for CI, exit 0 only when all pass. Against a dead
  gateway it fails in under a second with the socket reason.
- **End-to-end demo** (`scripts/latch-demo.mts`): boots the mock gateway,
  runs doctor green against it, drives 12 metered completions with live
  per-call costs, reconciles the total exactly to the cent.
  Captured output: `evidence/g1/demo-output.txt` (demo-exit=0).

## Evidence files

- `evidence/g1/demo-output.txt` — doctor 6/6 PASS + live metering + EXACT
  reconciliation, exit 0.
- `evidence/g1/doctor-fail-fast.json` — dead-gateway run: `"ok":false`,
  `unreachable (ECONNREFUSED)`, exit 1, sub-second.
- `evidence/round1/brand-lint.json` — regenerated this gate run, strict scope
  clean.

## Residual (tracked, not blocking)

- Live-gateway verification deferred until a production gateway key exists;
  the mock-gateway contract is pinned by the integration suite so wiring the
  real endpoint is a URL + key change, not a code change.
- `planGate()` remains a stub by design until the entitlement-header contract
  lands (pinned by the integration test's stub assertions).
