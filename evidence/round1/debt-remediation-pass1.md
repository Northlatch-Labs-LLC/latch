# Debt remediation pass 1 — 2026-09-27

Baseline (post critical-fix): 180 findings — 21 low / 101 moderate / 58 high across 31 modules.
Applied 33 root pnpm.overrides targeting every advisory module with a fix (within-major bumps
plus three majors: nanoid 5, linkify-it 5, uuid 11). extract-zip has no fix (<0.0.0) and is
deliberately not overridden. packages/desktop postinstall (electron-rebuild) fails locally —
desktop is excluded from build:bootstrap and the gate ladder; tracked separately.

Gates after overrides: brand-lint ok; product tests 6/6; build:bootstrap green (23.6s);
typecheck green; lint 0 errors (70 pre-existing style warnings).
