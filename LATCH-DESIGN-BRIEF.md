# Design Brief — Latch Harness (primary) + Synapse (secondary surfaces)
 
**For:** external UI/UX designer
**From:** Northlatch Labs
**Date:** 2026-09-27
**Working language:** English only (standing founder rule).
 
---
 
## 1. What you are designing
 
### Latch (primary — full design authority)
A free, open-source AI engineering harness: a coding agent that runs in the
terminal (TUI), on the desktop, and on the web. Every model call flows through
the Northlatch Gateway with one unified API key; every call is metered and
costed live. The design job: make it the most tuned, most intuitive harness
interface on the market — an engineer's instrument, not a chat window.
 
### Synapse (secondary — marketing surfaces only, plus a UX audit)
An AI team workspace product (conversations, teammates, governance). It ships
in English now; its Western-market face (landing, login, signup) needs a
design refresh in our language. **Do not redesign the workspace interior** —
deliver a UX audit of it instead (see §5).
 
---
 
## 2. The design language (fixed starting point)
 
Token source of record: `/Users/admin/Desktop/northlatch-harness/latch/product/identity/design-tokens.yaml` — read it first. Summary:
 
- **Palette:** bone `#F2EFE9` base, ink `#0A0A0A` type/hairlines, amber
  `#E8A33D` as THE single warm accent (reserved for live/metering state);
  signal green/red only for pass/fail.
- **Structure:** hairline technical grid (engineering-schematic framing),
  corner crop marks on hero surfaces, exactly one large visual centerpiece.
- **Type:** massive clipped display sans (may sit under the centerpiece);
  regular body sans; monospace uppercase letter-spaced micro-labels
  (`00.1`, `+18K NETWORK`).
- **Motion:** slow mechanical reveals, 200–400 ms ease-out, no bounce.
- **Iron rule:** every number a user is billed by renders as a mono
  micro-label. Cost is a first-class citizen of the interface, not a settings
  page.
 
Reference direction (direction only — build our own assets, lift none):
retro-futurist industrial-Swiss; the founder approved this register.
 
Surface expression rules:
| Surface | Expression |
| --- | --- |
| Product site, marketing, installer page | Full language (hero, grid, centerpiece) |
| Harness UI (desktop/web app) | Token subset, calm density, no brutalist hero |
| TUI (terminal) | Token translation: ANSI equivalents of the palette, mono micro-labels for metering |
| Synapse marketing + auth | Full language |
| Synapse workspace interior | OUT OF SCOPE for redesign; UX audit only |
 
---
 
## 3. What exists today (look before drawing)
 
- Latch design tokens: path above.
- Latch repo (code, do not edit): `/Users/admin/Desktop/northlatch-harness/latch`
- Synapse web app running locally: **http://localhost:3000** (English now;
  this is the surface to refresh). If it is not running, run
  `/Users/admin/Desktop/northlatch-harness/services.sh start`.
- Latch metered gateway demo page: **http://127.0.0.1:8787** — the metering
  table there is the seed of the cost HUD visual language.
- Synapse repo: `/Users/admin/Desktop/northlatch-harness/synapse`
 
## 4. Latch deliverables (in priority order)
 
1. **Cost HUD concept** — how live metering (per-call tokens/cost, session
   spend, budget caps) appears in TUI, desktop, and web without becoming
   noise. This is the differentiator; nail it first.
2. **Harness UI key screens** — session view, agent/tool activity, diff
   review, plan board (mission steps with gates/evidence). Desktop + web.
3. **TUI style guide** — ANSI palette mapping, hierarchy, metering line
   format, dense-vs-calm rules.
4. **Product site hero** — full design language, one centerpiece concept,
   headline treatment, the `curl | sh` install moment as a designed element.
5. **Onboarding (3 screens max)** — from zero to first metered mission.
 
## 5. Synapse deliverables
 
1. Landing + login + signup refresh in the design language (English).
2. **UX audit only** of the workspace interior: top 10 friction points with
   severity, annotated screenshots, recommended fixes — no redesign comps.
 
## 6. Constraints and guardrails
 
- English only. No Chinese anywhere in deliverables.
- The harness is a fork of an Apache-2.0 upstream: never use "ZCode",
  "Z.ai", or "GLM" names/marks in any comp or copy. Brand is **Latch** /
  Northlatch.
- Accessibility: contrast ratios for the bone/ink system, keyboard flows for
   every screen, reduced-motion variants.
- Do not edit code or repos. Deliver files into
  `/Users/admin/Desktop/northlatch-agent/` (F exports, PDFs, or an `index.md`
   linking everything) — that folder is the working contract between us.
- Terminal constraints are real: 80-column minimum, no images, 16-color
  degrade path for the TUI.
 
## 7. What "done" looks like
 
A reviewer can open your folder, see the cost HUD concept applied
consistently across TUI/desktop/web, the five Latch screens, the site hero,
the Synapse marketing refresh, and the workspace audit — all in one
recognizable system that a engineer trusts and a founder can ship.