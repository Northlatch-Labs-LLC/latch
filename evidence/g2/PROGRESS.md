# G2 execution ledger — live

Working agreement: one front (Latch), sequenced slices, no drift, gates on
every slice, commit + push per slice. This file updates as slices land.

| # | slice | state | evidence |
| --- | --- | --- | --- |
| 0 | design language codified (approved direction) | 🟢 done+gated | product/identity/design-tokens.yaml |
| 1 | gateway-first launcher: one-key env → auto provider config → harness | 🟢 done+gated | evidence/g2/slice1-launcher.txt (`pnpm run latch`) |
| 2 | binary rebrand end to end | 🟢 done+gated | evidence/g2/slice2-rebrand.txt (SEA binaries `latch-*`, identity swap, mirror-enforced brand-lint) |
| 3 | installer — local-machine increment (signed CDN installers stay G3) | 🟢 done+gated | evidence/g2/slice3-install.txt (install.sh, founder machine installed, doctor 6/6) |

Battle-test readiness (2026-09-28): `latch` installed on the founder's PATH
(`~/.local/bin/latch` → launcher → SEA harness binary). Production gateway
verified live (`evidence/g2/l3-gateway-reality.txt`); real-model runs need the
founder's unified key — env-only switch.

Parallel team front: Synapse English localization filed as
Northlatch-Labs-LLC/synapse#3 (fork Issues enabled first; an initial
misfile to the upstream repo was closed + scrubbed to neutral text within
two minutes — delete needs write access we lack there).

State key: ⚪ queued · 🔵 in progress · 🟢 done+gated · 🔴 blocked.

## Design acceptance (2026-09-27, founder-confirmed)

The external designer's Revision-1 delivery was audited against its seven
binary acceptance checks and ACCEPTED by the founder: embedded OFL type
system (Archivo / Inter / JetBrains Mono + Space Grotesk alt), 12 drawn HUD
states, 8×6 component-state matrix (42 literal + 6 declared substitutions),
3 flows with failure paths, a clickable keyboard-operable prototype with the
runaway guard firing, 14-glyph icon grammar, two hero directions, grid math,
TUI style board. One residual waived-or-pending: full-length ANSI session
captures (current ones are 14-line openings). Source of record for the type
system is now this repo's product/identity/design-tokens.yaml; assets and
boards live in ~/Desktop/northlatch-agent/ (fonts are OFL — repo-embeddable).
The HUD implementation slice (P0: U-1 predictive rail, U-2 runaway guard,
U-3 per-call ceiling with the gateway) implements against this system.
