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
- `chatCompletion(config, request)` — `POST {base}/v1/chat/completions`,
  OpenAI-compatible JSON body.
- `planGate(model)` — **stub**; see below.

Errors: any non-2xx response throws `GatewayHttpError` (with `status` and the
raw body); HTTP 401/403 throw its subclass `GatewayAuthError`. A missing API
key means no Authorization header is sent, so the gateway's 401 surfaces as
`GatewayAuthError`.

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
