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
pnpm exec tsx scripts/latch-mock-gateway.mts &     # metered gateway on :8787
LATCH_GATEWAY_URL=http://127.0.0.1:8787 LATCH_API_KEY=latch-key-pro \
  pnpm run latch -p "any prompt"
```

`pnpm run latch` is the product entry point: it reads the gateway target
and unified key from the environment, fetches the live model catalog,
generates the provider config under the product config dir, and execs the
harness. The gateway meters every call; `scripts/latch-provider-config.example.json`
documents the generated shape.
