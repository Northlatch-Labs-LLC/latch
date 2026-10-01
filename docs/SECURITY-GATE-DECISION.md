# Security gate: status and lead decision

Written by the Northlatch Labs lead, 2026-09-30, under operator directive.
Records why `main` has no dedicated security-check step in CI, that the
removal was founder-ordered (not a covert self-delete), and what replaces the
gate in the interim. No product decision lives only in a conversation.

## Facts (each verified against the repo on 2026-09-30)

- A `scripts/security-check.mjs` step existed as part of the audit-closure
  "Security P1" work (commit `3bcb5aa`). That commit is **not** on `main`;
  it survives only in the local reflog (`git log -g | grep 3bcb5aa`).
- Founder order after the 2026-10-01 key-exposure incident ("delete
  everything you have done") produced commit `6f8ad07` — "Remove
  session-added security tooling and dependency bumps — keep team delivery
  only" — which deleted `scripts/security-check.mjs` (275 lines) from
  `main`. `main` is `5ddfe50`, clean, origin-synced.
- CI at HEAD (`.github/workflows/ci.yml`) therefore runs: brand-lint,
  dependency audit (`pnpm audit --prod --audit-level=critical`), product
  tests, server/account/billing tests, build, typecheck, lint — and **no**
  dedicated security scan.
- History carries no key material: `git log --all -S'xlaunch-981b'` and the
  regex pickaxe `xlaunch-[a-z0-9_-]{12,}` both return zero commits
  (re-run 2026-09-30). The exposed unified key lived in a dead VM's runtime
  config, never in the repo.

## Decision

The removal **stands as founder-ordered** and is recorded here so the gap is
explicit, not silent. The dependency audit (critical, production) remains
the standing automated security control on `main`.

Replacement plan, in order, gated on founder instruction because all Latch
work is currently stopped and nothing redeploys without an explicit order:

1. A trimmed, non-deploying `scripts/security-check.mjs` (static scan:
   secret literals in tracked files, egress-URL allowlist, dependency
   advisories) restored as a CI step, so the audit-closure intent survives
   without re-introducing any of the removed session tooling.
2. Before any redeploy of the web app: the multi-tenant provider-config
   isolation + apiKey redaction called for by the incident post-mortem —
   the shared single provider_config.json rendered to signed-in browsers was
   the actual exposure vector, and no static scan replaces that fix.
3. Key rotation remains the founder's open closure action for the exposed
   unified key; the repo cannot do it from here.
