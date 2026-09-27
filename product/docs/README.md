# product/docs

Product-facing documentation for the Latch overlay.

- Start with `../../docs/PRODUCT.md` for the one-page product description.
- Brand facts (names, URLs, paths) come from `../identity/brand.yaml`.
- Keep this tree free of upstream brand strings; `../../scripts/brand-lint.mjs`
  enforces that for everything under `product/`.

## Diagnostics and demo

- `pnpm run doctor` (or `node scripts/latch-doctor.mjs`, `--json` for CI) checks
  an install in six steps — config URL, key presence (value never printed),
  gateway reachability with a 5s budget, credential acceptance, catalog parse,
  and provider package importability — and exits non-zero unless every check
  passes. Against a dead gateway it fails loudly in under a second.
- `pnpm exec tsx scripts/latch-demo.mts` boots the mock gateway on an ephemeral
  localhost port, runs the doctor against it, then drives metered chat
  completions through the real provider client, printing per-call costs and an
  exact-to-the-cent reconciliation. It is the fastest way to see the product
  run end to end from this checkout.

### Boot the harness against the local gateway

```sh
pnpm exec tsx scripts/latch-mock-gateway.mts &        # metered gateway on :8787
cp scripts/latch-provider-config.example.json /tmp/latch-provider-config.json
ZCODE_DATA_BASE_DIR=/tmp/latch-home \
ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=/tmp/latch-provider-config.json \
  node dist/runtime/zcode/bin/zcode.mjs -p "any prompt"
```

The config template points the harness at the mock gateway
(`openai-chat-completions`, bearer key `latch-key-pro`, default model
`latch-small`); the gateway logs every call's metered cost.
