#!/usr/bin/env node
// Latch security check — Node, no dependencies.
//
// Three invariants from the P1 security closure (docs/MARKET-READINESS-PLAN.md):
//   (a) no secret-like literals in tracked files (explicit fixtures allowlist below)
//   (b) banned upstream vendor identifiers stay absent from shipped code
//   (c) product/*.keystore stays untracked and .gitignore keeps covering it
//
// Exit code: 0 clean, 1 with a readable report.
//
// Deliberately NOT checked here yet: CJK/English comment policy — added later,
// after the P3 comment sweep.
//
// Scope notes:
//   (a) scans every git-tracked file (node_modules/dist are untracked by
//       design; build outputs under tracked paths are still skipped).
//   (b) "shipped code" is tracked source under packages/, apps/, config/ and
//       deploy/ — the surfaces that ship to users. Docs (including this
//       closure plan itself, which names the banned terms to define them) and
//       vendored third-party notice files are out of scope.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: scriptDir,
  encoding: 'utf8',
}).trim();

const MAX_SECRET_SCAN_BYTES = 2_000_000; // skip giant vendored blobs

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function readText(relPath) {
  const buf = readFileSync(path.join(repoRoot, relPath));
  if (buf.includes(0)) return null; // binary
  return buf.toString('utf8');
}

function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// Check A — secret-like literals
// ---------------------------------------------------------------------------
// Pattern notes:
//  - The lookbehind guard stops identifier false positives such as
//    "task-list-session-membership" (contains "sk-list-...") from matching.
//  - Entropy bar 4.5: camelCase/snake identifier strings in this repo top out
//    around 4.3 bits/char; random 32+ char key material measures >= 4.8.
const SECRET_PATTERNS = [
  {
    id: 'api-key-prefix',
    describe: 'sk-/gy- style API key literal',
    re: /(?<![A-Za-z0-9_=-])(?:sk|gy)-(?:proj|ant|serv|admin|none)-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9_=-])(?:sk|gy)-[A-Za-z0-9]{20,}/g,
  },
  {
    id: 'private-key-block',
    describe: 'PEM PRIVATE KEY block',
    re: /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'high-entropy-assignment',
    describe: 'long high-entropy secret-like assignment (>= 32 chars, >= 4.5 bits/char)',
    re: /(?:key|token|secret|password|passwd|api[_-]?key|credential)\s*[:=]\s*["']([A-Za-z0-9+/=_-]{32,256})["']/gi,
    minEntropy: 4.5,
  },
];

// Explicit fixtures allowlist — a hit is waived ONLY when both file and
// pattern id match an entry below. Every entry must carry a reason.
const SECRET_FIXTURE_ALLOWLIST = [
  {
    file: '.agents/skills/ai-elements/scripts/environment-variables.tsx',
    patternId: 'api-key-prefix',
    reason: 'vendored upstream skill example placeholder ("sk-1234567890abcdef"), not a real key',
  },
];

function runSecretScan(files) {
  const violations = [];
  const allowed = (file, patternId) =>
    SECRET_FIXTURE_ALLOWLIST.some(
      (e) => e.file === file && e.patternId === patternId,
    );
  for (const file of files) {
    let text;
    try {
      text = readText(file);
    } catch {
      continue;
    }
    if (text === null) continue; // binary
    if (Buffer.byteLength(text) > MAX_SECRET_SCAN_BYTES) continue;
    for (const pattern of SECRET_PATTERNS) {
      pattern.re.lastIndex = 0;
      for (const match of text.matchAll(pattern.re)) {
        const captured = match[1] ?? match[0];
        if (
          pattern.minEntropy !== undefined &&
          shannonEntropy(captured) < pattern.minEntropy
        ) {
          continue;
        }
        if (allowed(file, pattern.id)) continue;
        violations.push({
          file,
          line: lineOfIndex(text, match.index),
          pattern: pattern.id,
          describe: pattern.describe,
          sample: String(captured).slice(0, 24),
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Check B — banned upstream vendor identifiers in shipped code
// ---------------------------------------------------------------------------
// The ARMS SDK family and the vendor CDN/telemetry/mirror egress hosts retired
// in the productization closure (commit 291c25a and the P1 pass). They must
// never return to shipped code.
const BANNED_VENDOR_TERMS = [
  '@arms/rum-electron',
  '@arms/rum-browser',
  '@arms/rum-core',
  'arms-retcode',
  'retcode.aliyun.com',
  'arms.aliyun.com',
  'cdn-zcode.z.ai',
  'npmmirror.com',
];
const SHIPPED_CODE_PREFIXES = ['packages/', 'apps/', 'config/', 'deploy/'];

function runVendorScan(files) {
  const violations = [];
  for (const file of files) {
    if (!SHIPPED_CODE_PREFIXES.some((p) => file.startsWith(p))) continue;
    if (file.endsWith('.map')) continue; // build artifacts
    let text;
    try {
      text = readText(file);
    } catch {
      continue;
    }
    if (text === null) continue;
    const lower = text.toLowerCase();
    for (const term of BANNED_VENDOR_TERMS) {
      let from = 0;
      for (;;) {
        const index = lower.indexOf(term, from);
        if (index === -1) break;
        violations.push({
          file,
          line: lineOfIndex(text, index),
          term,
        });
        from = index + term.length;
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Check C — keystore custody
// ---------------------------------------------------------------------------
function runKeystoreCheck() {
  const failures = [];
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'product/*.keystore'], {
    cwd: repoRoot,
    encoding: 'buffer',
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  if (tracked.length > 0) {
    failures.push(`tracked keystore file(s): ${tracked.join(', ')}`);
  }
  // Probe an arbitrary keystore path against the ignore rules (the path does
  // not need to exist on disk).
  const probe = 'product/security-check-probe.keystore';
  let ignoredBy = null;
  try {
    ignoredBy = execFileSync('git', ['check-ignore', '-v', '--', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    ignoredBy = null;
  }
  if (!ignoredBy) {
    failures.push(
      `.gitignore no longer covers ${probe} — restore a product/*.keystore rule`,
    );
  }
  return { failures, ignoredBy };
}

// ---------------------------------------------------------------------------
// Run + report
// ---------------------------------------------------------------------------
const files = trackedFiles();
const secretViolations = runSecretScan(files);
const vendorViolations = runVendorScan(files);
const keystore = runKeystoreCheck();

const sections = [
  {
    name: 'A. secret-like literals in tracked files',
    ok: secretViolations.length === 0,
    detail: `${files.length} tracked file(s) scanned, ${SECRET_PATTERNS.length} pattern(s), ${SECRET_FIXTURE_ALLOWLIST.length} fixture allowlist entry(ies)`,
    violations: secretViolations.map(
      (v) => `${v.file}:${v.line} [${v.pattern}] ${v.describe} — "${v.sample}…"`,
    ),
  },
  {
    name: 'B. banned vendor identifiers in shipped code',
    ok: vendorViolations.length === 0,
    detail: `scopes: ${SHIPPED_CODE_PREFIXES.join(' ')} (tracked files, sourcemaps excluded); terms: ${BANNED_VENDOR_TERMS.join(', ')}`,
    violations: vendorViolations.map((v) => `${v.file}:${v.line} — "${v.term}"`),
  },
  {
    name: 'C. product/*.keystore custody',
    ok: keystore.failures.length === 0,
    detail: `no tracked keystore; ignore rule: ${keystore.ignoredBy ?? 'MISSING'}`,
    violations: keystore.failures,
  },
];

let failed = false;
for (const section of sections) {
  const status = section.ok ? 'PASS' : 'FAIL';
  console.log(`security-check: ${status} — ${section.name}`);
  console.log(`  ${section.detail}`);
  for (const v of section.violations) console.error(`  ${v}`);
  if (!section.ok) {
    failed = true;
    console.error('  ^ remove the violation, or (fixtures only) add an explicit allowlist entry with a reason');
  }
}

if (failed) {
  console.error('security-check: FAILED — see above');
  process.exitCode = 1;
} else {
  console.log('security-check: all checks passed');
  process.exitCode = 0;
}
