# Critical remediation — 2026-09-27 (post Round 1)

First live CI execution (run 36342306034) surfaced what the npm-based Round-1 audit could
not see: the pnpm production graph carried `shell-quote` <=1.8.3 (critical, command
injection via unescaped newlines in quote() object .op values). Root cause of the blind
spot: the Round-1 audit ran against an npm-resolved tree (package-lock.json), while the
repo's authoritative install plan is pnpm-lock.yaml.

Fix: root pnpm override `"shell-quote": ">=1.8.4"` (package.json pnpm.overrides) +
lockfile refresh. Post-fix `pnpm audit --prod`: 0 criticals (21 low / 101 moderate /
58 high remain — tracked debt, gate blocks criticals only, same policy as the dev-tooling
highs). Product tests 6/6 green; brand lint strict-scope clean.

The npm package-lock.json was removed from tracking: two lockfiles for one repo is the
audit blind spot itself. CI now runs the entire ladder under the pinned pnpm.
