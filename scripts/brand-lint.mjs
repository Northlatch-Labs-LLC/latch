#!/usr/bin/env node
// Latch brand lint — Node, no dependencies.
//
// Strict scope: git-tracked files under product/, EXCEPT
// product/identity/brand.yaml (the single overlay file allowed to carry
// upstream names). Any occurrence of ZCode / Z.ai / GLM (case-insensitive) in
// the strict scope is a violation and exits 1.
//
// Informational scope: every other git-tracked file, including the root
// README.md. Upstream names in upstream files are expected at this stage;
// they are counted into evidence/round1/brand-lint.json and never fail the
// lint.
//
// The evidence JSON is written on every run, pass or fail.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: scriptDir,
  encoding: 'utf8',
}).trim();

const TERMS = ['ZCode', 'Z.ai', 'GLM'];
const PATTERNS = TERMS.map((term) => ({
  term,
  re: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
}));

const BRAND_FILE = 'product/identity/brand.yaml';
const STRICT_PREFIX = 'product/';
const EVIDENCE_PATH = path.join(
  repoRoot,
  'evidence',
  'round1',
  'brand-lint.json',
);

function trackedFiles(pathspec) {
  const args = ['ls-files', '-z'];
  if (pathspec) args.push('--', pathspec);
  const out = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function scan(relPath) {
  let buf;
  try {
    buf = readFileSync(path.join(repoRoot, relPath));
  } catch {
    return { file: relPath, status: 'unreadable', counts: {}, total: 0 };
  }
  if (buf.includes(0)) {
    return { file: relPath, status: 'binary-skipped', counts: {}, total: 0 };
  }
  const text = buf.toString('utf8');
  const counts = {};
  let total = 0;
  for (const { term, re } of PATTERNS) {
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      counts[term] = matches.length;
      total += matches.length;
    }
  }
  return { file: relPath, status: 'scanned', counts, total };
}

// --- gather scopes ----------------------------------------------------------
const productTracked = trackedFiles(STRICT_PREFIX);
const productUntracked = [];
try {
  const out = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z', '--', STRICT_PREFIX],
    { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  productUntracked.push(
    ...out.toString('utf8').split('\0').filter(Boolean),
  );
} catch {
  // informational only; ignore
}
const allTracked = trackedFiles(null);
const strictFiles = productTracked.filter((f) => f !== BRAND_FILE);
const strictSet = new Set(productTracked);
const informationalFiles = allTracked.filter(
  (f) => !strictSet.has(f) && f !== BRAND_FILE,
);

// --- scan -------------------------------------------------------------------
const strictResults = strictFiles.map(scan);
const strictViolations = strictResults.filter((r) => r.total > 0);
const brandResult = strictSet.has(BRAND_FILE)
  ? scan(BRAND_FILE)
  : { file: BRAND_FILE, status: 'not-tracked', counts: {}, total: 0 };

const informationalResults = informationalFiles.map(scan);
const informationalHits = informationalResults
  .filter((r) => r.total > 0)
  .map(({ file, counts, total }) => ({ file, counts, total }));
const binarySkipped = informationalResults
  .filter((r) => r.status === 'binary-skipped')
  .map((r) => r.file);
const unreadable = informationalResults
  .filter((r) => r.status === 'unreadable')
  .map((r) => r.file);
const rootReadme =
  informationalHits.find((h) => h.file === 'README.md') ?? null;

const byTerm = {};
for (const term of TERMS) byTerm[term] = 0;
for (const hit of informationalHits) {
  for (const term of TERMS) byTerm[term] += hit.counts[term] ?? 0;
}

// --- evidence ---------------------------------------------------------------
const report = {
  tool: 'scripts/brand-lint.mjs',
  generatedAt: new Date().toISOString(),
  terms: TERMS,
  strict: {
    scope: 'git-tracked files under product/ excluding product/identity/brand.yaml',
    filesScanned: strictResults.length,
    violations: strictViolations,
    clean: strictViolations.length === 0,
  },
  brandFile: {
    file: BRAND_FILE,
    note: 'allowed to carry upstream names; exempt from the strict scope',
    ...brandResult,
  },
  informational: {
    note: 'upstream names in upstream files are expected at this stage; counted only, never fails the lint',
    filesScanned: informationalResults.length,
    filesWithOccurrences: informationalHits.length,
    totalOccurrences: informationalHits.reduce((n, h) => n + h.total, 0),
    byTerm,
    rootReadme,
    occurrences: informationalHits,
    binarySkipped,
    unreadable,
  },
  untrackedUnderProduct: {
    note: 'untracked files under product/ are outside the git-tracked strict scope; listed here so they cannot hide',
    files: productUntracked,
  },
  exitCode: strictViolations.length === 0 ? 0 : 1,
};

mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
writeFileSync(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`);

// --- report -----------------------------------------------------------------
if (strictViolations.length === 0) {
  console.log(
    `brand-lint: strict scope clean (${strictResults.length} tracked file(s) under ${STRICT_PREFIX}, excluding ${BRAND_FILE})`,
  );
} else {
  console.error(
    `brand-lint: ${strictViolations.length} file(s) in the strict scope carry upstream brand strings:`,
  );
  for (const v of strictViolations) {
    console.error(`  ${v.file}: ${JSON.stringify(v.counts)}`);
  }
  console.error(
    `brand-lint: remove these occurrences or move the facts into ${BRAND_FILE}`,
  );
}

console.log(
  `brand-lint: informational — ${report.informational.totalOccurrences} occurrence(s) in ${informationalHits.length} non-overlay file(s), including root README.md: ${rootReadme ? JSON.stringify(rootReadme.counts) : 'none'} (expected at this stage, not failing)`,
);
if (productUntracked.length > 0) {
  console.warn(
    `brand-lint: warning — ${productUntracked.length} untracked file(s) under ${STRICT_PREFIX} are outside the git-tracked strict scope: ${productUntracked.join(', ')}`,
  );
}
console.log(`brand-lint: evidence written to ${EVIDENCE_PATH}`);

process.exitCode = report.exitCode;
