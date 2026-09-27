# @latch/provider-gateway

Provider layer of the Latch overlay: HTTP client for the Latch gateway and
the plan gate. Brand truth (gateway base URL) comes from
`product/identity/brand.yaml` (`gateway_base_url`).

## Environment contract

| Variable            | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `LATCH_GATEWAY_URL` | Gateway base URL. Default: `https://gateway.xlaunch.work`.     |
| `LATCH_API_KEY`     | Bearer credential sent as `Authorization: Bearer <key>`.       |

`readConfig(env = process.env)` returns `{ baseUrl, apiKey }`. An unset/empty
`LATCH_GATEWAY_URL` falls back to the default and trailing slashes are
stripped; an unset/empty `LATCH_API_KEY` yields `undefined`.

## API

- `readConfig(env?)` — read the configuration above.
- `listModels(config)` — `GET {base}/v1/models`, returns `{ object, data }`.
- `chatCompletion(config, request, options?)` — `POST {base}/v1/chat/completions`,
  OpenAI-compatible JSON body; returns `{ content, usage, metering }` (see
  "Usage metering" below).
- `parseUsage(raw)` — parse an OpenAI-compatible usage object
  (`prompt_tokens`, `completion_tokens`, `total_tokens`) into
  `{ promptTokens, completionTokens, totalTokens }`; invalid/absent input
  returns `undefined`.
- `planGate(model)` — **stub**; see below.

Errors: any non-2xx response throws `GatewayHttpError` (with `status` and the
raw body); HTTP 401/403 throw its subclass `GatewayAuthError`. A missing API
key means no Authorization header is sent, so the gateway's 401 surfaces as
`GatewayAuthError`.

## Usage metering

Every 2xx `chatCompletion` is metered. The result carries the parsed
`usage`, the first choice's `content`, and a `metering` event:

```ts
interface MeteringEvent {
  model: string;          // gateway echo of the model, else the requested one
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;        // exact; $0 when the model is unpriced or usage absent
  requestId: string;      // gateway response id ("" when the gateway sent none)
  timestamp: string;      // ISO-8601
}
```

The event is emitted synchronously to `options.sink` before the call resolves;
without one it goes to the shared `defaultMeteringLog()` — an in-memory ring
buffer of the last 100 events (`recent()`, oldest → newest) with a
`subscribe(listener)` API the cost HUD can attach to. A throwing listener
never breaks the emit.

Costs are priced by `options.priceTable`, defaulting to the optional
`product/identity/price-table.yaml` (USD per 1k tokens, per model; a model
absent from the table costs $0; a missing file is an empty table). Rates are
parsed into integer micro-USD and priced as integer nano-USD, so `costUsd`
equals its decimal literal exactly — e.g. 1500 prompt tokens at `$0.003`/1k
plus 500 completion tokens at `$0.015`/1k is exactly `0.012`. A response
without a valid usage object still emits, with zero tokens and `$0`.

## Header contract

Request headers this client sends on every `{base}/v1/*` call (owned by
`authHeaders` in `src/client.ts`):

- `Authorization: Bearer <LATCH_API_KEY>` — the credential the gateway uses
  to resolve the caller (identity, plan entitlements, billing).
- `Content-Type: application/json` — on `POST /v1/chat/completions` only.

Plan gate: `planGate(model)` is a stub returning `{ allowed: true, plan:
"unknown" }`. The gateway is expected to enforce plan access server-side,
keyed on the Authorization header above. The response headers that will carry
plan entitlements are **not defined yet**, so this stub invents no header
names; when the gateway contract lands, `planGate` will map it.

## Tests

`node:test` against a local `node:http` mock gateway (ephemeral 127.0.0.1
port). Run from the repo root:

```sh
npm run test:product   # or: pnpm --filter @latch/provider-gateway test
```
