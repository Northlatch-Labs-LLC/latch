# Latch product decisions

Written product decisions of the Northlatch Labs lead, effective **2026-09-29**.
Each section records what was decided and why, so no product decision lives
only in a code comment or a conversation. `scripts/brand-lint.mjs` treats this
file like `brand.yaml`: it is overlay truth, allowed to name the vendor terms
it governs.

## (a) Custom-provider policy

**Decision.** Z.ai and BigModel remain user-configured custom providers.
Their provider templates stay enabled in the provider catalog (grouped under
"Custom", behind the mandatory Xlaunch Gateway group), and vendor console
links (pricing, registration, API key, team and payment pages) are allowed
inside that configuration flow. Vendor account plans (subscription and
purchase surfaces) stay disabled as a first-party offer; the first-party plan
is the metered gateway subscription at gateway.xlaunch.work/usage.

**Rationale.** Extends INV-S1 capability preservation (see
`evidence/fp0/edit-pass-1.md`): the vendors are the user's own accounts, not
Latch partners, so templates and console links preserve real capability.
Disabling plan purchase keeps Latch's business model single-rail — every
first-party model call is metered by the gateway.

## (b) Web sign-in

**Decision.** The Latch gateway key is the first-party web sign-in path.
Vendor web OAuth fails safe: it counts as unconfigured unless both the OAuth
client id and the authorize origin are explicitly provided via build-time env
(`VITE_ZAI_OAUTH_CLIENT_ID` / `VITE_ZAI_OAUTH_ORIGIN`), and the retired
vendor client id (`client_P8X5CMWmlaRO9gyO-KSqtg`) must never return as a
baked-in default.

**Rationale.** A missing or partial OAuth configuration must degrade to "no
vendor sign-in", never to a vendor endpoint Latch does not control
(`packages/web/src/auth/webZaiOAuthConfig.ts` implements the empty-default
gate). The gateway key keeps identity, metering, and billing in one
first-party rail.

## (c) READMEs replaced

**Decision.** `README.md` and `README.en.md` are Latch product readmes
(what Latch is, install, `~/.latch` data home, gateway usage, fork
provenance). The upstream product readme, its quick-start, and its community
links are gone. Attribution for the upstream fork lives in `NOTICE`,
`NOTICE.md`, `LICENSE`, and `THIRD-PARTY-NOTICES.md` — not in marketing copy.

**Rationale.** The README is the product's front door; provenance is a legal
fact, not a pitch. Keeping attribution in the notice files preserves
Apache-2.0 obligations without re-importing upstream positioning.

## (d) Upstream sync: manual only

**Decision.** The weekly auto-merge upstream-sync workflow is disabled;
`.github/workflows/upstream-sync.yml` keeps `workflow_dispatch` only. Syncs
are explicit, human-initiated runs.

**Rationale.** Divergence from upstream is deliberate: every sync would
resurrect swept branding (vendor copy, telemetry defaults, installer
identity) and re-open settled decisions. A scheduled merge automates exactly
the wrong thing; a manual run forces the cost of re-sweeping to be paid
consciously.

## (e) Brand-lint terms extended

**Decision.** `scripts/brand-lint.mjs` scans for `ZCode`, `Z.ai`, `GLM`,
`bigmodel`, `zhipu`, and the retired OAuth client id
`client_P8X5CMWmlaRO9gyO-KSqtg`. Strict scope stays `product/` (excluding
this file and `brand.yaml`, which are overlay truth).

**Rationale.** The two vendor names and the retired client id are the same
class of trace as the product name: strings that must never re-enter the
overlay through routine edits. Linting them closes the gap the forensic audit
found.

## (f) Compatibility contracts kept deliberately

**Decision.** The following stay, on purpose: the `zcode://` deep-link
scheme, the `zhipu-account` auth types, the `X-Bigmodel-Authorization`
header, plugin stable ids, and internal `zcode-protocol` identifiers. They
are functional contracts serving the custom-provider capability and the
installed base — not egress, not branding.

**Rationale.** Renaming wire-level and storage-level identifiers breaks every
existing custom-provider configuration, deep link, and plugin for zero
user-visible gain. Contracts are swept when their meaning changes, not when
their spelling embarrasses us.

## (g) ARMS telemetry SDK removed

**Decision.** The ARMS telemetry SDK is removed from the codebase. Telemetry
was already off at source since FP-0 (`ZCODE_TELEMETRY_ENABLED` defaults to
false, `packages/shared/src/env.ts`), so removal changes no metering, cost,
or product behavior.

**Rationale.** A disabled vendor telemetry dependency is still a vendor
dependency: it ships vendor code in every artifact and re-appears in every
audit. Deleting it turns an opt-out into an absence.

## (h) FP-4 identifier/package rename: separate gated program

**Decision.** The internal identifier/package rename (FP-4, roughly 24k
occurrences of `zcode`-family internal names) is scoped as its own future
gated program. It is not user-visible, not egress, and not part of the
current sweep; it is revisited at the G3 distribution milestone.

**Rationale.** A mechanical rename of that scale permanently widens upstream
divergence, making every future manual sync (decision (d)) and every
cherry-pick more expensive, while improving nothing a user can see. The cost
is real; the benefit is cosmetic — so it waits behind a gate that can weigh
them.
