# FP-0 edit pass 1 — 2026-09-29 (founder-approved: all High+Medium + small fixes)

Source: FP-0 inventory workflow dwfrun-3c4ee016 (69 endpoints, 52 verified).
Desktop copy of the report: ~/Desktop/FP-0-productization-inventory.md

## Applied (all High + Medium findings + small fixes)

1. MASTER SWITCH packages/shared/src/zcodeEndpoint.ts: all four upstream origins
   (zcode.z.ai, bigmodel.cn, chat.z.ai, api.z.ai) -> https://latch.gridframes.app
   (fail-safe 404s from OUR origin; gateway auth arrives with FP-1); upstream OAuth
   client id client_P8X5CMWmlaRO9gyO-KSqtg retired (empty).
2. TELEMETRY OFF AT SOURCE: shared/src/env.ts ZCODE_TELEMETRY_ENABLED true->false
   (ARMS RUM + warehouse heartbeats now default-disabled; env sinks were already empty-default).
3. AUTO-UPDATE / REMOTE CDN: desktop remoteCdn.ts upstream default removed — no
   configured CDN => zero download sources attempted (was cdn-zcode.z.ai);
   update-manifest origin follows the master switch.
4. PLUGIN MARKETPLACE FEED: shared/plugin-marketplaces.ts official feed ->
   latch.gridframes.app/plugins/marketplace.json (local seed shards unaffected — INV-S1);
   "Official ZCode plugins marketplace" -> "Official Latch plugins marketplace".
5. BRAND LEAK ON EVERY FETCH: WebFetch UA -> "Latch-WebFetch/1.0 (+https://latch.gridframes.app…)";
   model-call headers User-Agent ZCode/<v> -> Latch/<v>, X-Title "Z Code@" -> "Latch@",
   X-ZCode-Agent: glm -> X-Latch-Agent: latch (bootstrap/model-config.ts).
6. INSTALLER IDENTITY: appId dev.zcode.app(.preview) -> com.northlatch.latch(.preview);
   productName ZCode/ZCode Preview -> Latch/Latch Preview; linux executable/package names;
   homepage -> latch.gridframes.app; maintainer -> Northlatch <ops@northlatch.com>;
   electron binary mirror npmmirror -> official github releases; node dist mirror
   cdn.npmmirror -> nodejs.org/dist.
7. LINK-OUTS config/default.json: Zhipu Feishu feedback form -> latch.gridframes.app/feedback;
   Feishu zh community + upstream Discord invite -> latch.gridframes.app/community;
   ui productDocs URL -> latch.gridframes.app.
8. WEB COPY: "Sign in with Z.AI"/"用 Z.AI 登录" -> Latch; "Connect to Z.ai" -> Latch;
   "Download ZCode" -> "Download Latch". (Third-party provider names — BigModel, OpenAI,
   etc — are legitimate vendor names and stay, per INV-S1 capability preservation.)
9. PLUGIN ASSETS/AUTHOR: cdn-zcode assets base -> "" (icon fetch fails safe to default);
   ZAI_AUTHOR Z.ai/z.ai -> Northlatch/latch.gridframes.app.
10. SMALL FIXES: provisioned API-key name "zcode-api-key" -> "latch-api-key".

## Deliberately NOT changed (logged)

- Third-party bot integrations (Telegram/Feishu/WeChat) and third-party model-provider
  registry: user-configured features, kept per INV-S1.
- OTLP env vars: already empty-default (opt-in observability), no hardcoded host.
- The ~26.8k internal TS identifier occurrences (useZCodeIntl, ZCodeTaskMeta…): low
  visibility (never user-facing), mechanical rename is its own gated pass — NOT this one.
- vite VITE_BIGMODEL_OAUTH_ORIGIN define bug: NOT fixed here (needs the web auth swap
  decision from FP-1 to be meaningful); logged for FP-1.

## Gates

- CLI workspace typecheck: 27 tasks, 0 errors (turbo)
- Web build: vite ✓
- Product tests: 37/37 pass
- brand-lint: strict scope clean, identityMirror ok
- Repo-wide oxlint: FAILS identically on the PRISTINE tree (pre-existing upstream
  issues in desktop files untouched by this pass — verified via git stash A/B)

## Incident note

A gate command accidentally ran `npm install` in the pnpm workspace root, poisoning
hoisting (npm lockfile created, module resolution broke). Repaired: lockfile removed,
`pnpm install` restored, all gates re-run green from the clean state.
