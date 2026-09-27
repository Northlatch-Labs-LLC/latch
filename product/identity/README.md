# product/identity

Identity layer of the Latch overlay. It defines what the product is called and
where its brand truth lives, independently of the upstream codebase this
repository was forked from.

- `brand.yaml` — the single source of brand truth: product name, binary name,
  config directory, gateway and billing URLs, upstream remote, and overlay
  paths. Everything else must derive its brand facts from this file.
- `../provider/` — provider and endpoint wiring that consumes the URLs above.
- `../../scripts/brand-lint.mjs` — the guardrail: it fails when upstream brand
  strings appear anywhere under `product/` outside `brand.yaml`.
