# Latch — Product Overview

Latch is a coding-agent workspace that packages the forked agent runtime into
a single branded product: a `latch` binary that keeps its configuration in
`~/.latch/`, talks to the Latch model gateway for inference and to the Latch
billing service for plans and usage, and ships its product identity and
provider wiring as the overlay under `product/` on top of the upstream
codebase. Latch is operated by Northlatch Labs LLC and inherits the
Apache-2.0 licensing of its upstream; the product identity itself — names,
endpoints, directories, and overlay layout — is owned by this repository, not
by the code it is built from.

## Source of brand truth

All brand facts (product name, binary name, config directory, gateway and
billing URLs, upstream remote, overlay paths) live in
[`product/identity/brand.yaml`](../product/identity/brand.yaml). That file is
the single source of brand truth: code, docs, and tooling must read from it
rather than repeating these values, and `scripts/brand-lint.mjs` enforces that
no upstream brand strings appear under `product/` outside it.
