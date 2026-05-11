#!/usr/bin/env node
// EN/KO README parity gate.
//
// Walks the repo for non-localized `*.md` files and asserts:
//   1. each has a matching `*.ko.md` sibling, OR
//   2. the file is on the explicit `KNOWN_EN_ONLY` allowlist below.
//
// For pairs, the script also checks that the last-commit timestamps are
// within 7 days of each other (uses `git log -1 --format=%ct` — filesystem
// mtime is unreliable after clone).
//
// Exit non-zero on violation. Wired as `pnpm check-readme-parity`.
//
// The KNOWN_EN_ONLY allowlist is intentional — it makes EN-only docs a
// reviewable contract instead of a silent default. Removing an entry from
// the allowlist requires a Korean translation to land in the same PR.

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
})();

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  "dist",
  ".claude",
  ".next",
  "coverage",
]);

const KNOWN_EN_ONLY = new Set([
  "CLAUDE.md",
  "packages/ai-relay/CHANGELOG.md",
  "packages/ai-relay/COMPATIBILITY.md",
  "packages/ai-relay/README.md",
  "examples/vercel/README.md",
  "examples/stdio/README.md",
  "examples/multi-upstream/README.md",
  "examples/cloudflare-workers/README.md",
  // Test fixtures and CI scaffolding — internal-facing, EN-only.
  "tests/fixtures/mock-openai/README.md",
  "tests/runtime-fixtures/README.md",
  "tests/runtime-fixtures/cjs-require/README.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
]);

const STALE_THRESHOLD_DAYS = 7;
const STALE_THRESHOLD_SECONDS = STALE_THRESHOLD_DAYS * 24 * 60 * 60;

function walkMd(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkMd(full, acc);
    } else if (st.isFile() && name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

function lastCommitTimestamp(path) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", path], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    if (!out) return null;
    return Number(out);
  } catch {
    return null;
  }
}

function main() {
  const all = walkMd(REPO_ROOT).map((p) => relative(REPO_ROOT, p));
  const set = new Set(all);

  const violations = [];

  for (const file of all) {
    if (file.endsWith(".ko.md")) continue;
    const koSibling = file.replace(/\.md$/, ".ko.md");
    if (set.has(koSibling)) {
      // Both exist — check mtime drift.
      const enT = lastCommitTimestamp(file);
      const koT = lastCommitTimestamp(koSibling);
      if (enT !== null && koT !== null) {
        const delta = Math.abs(enT - koT);
        if (delta > STALE_THRESHOLD_SECONDS) {
          violations.push(
            `STALE: ${file} (${new Date(enT * 1000).toISOString()}) vs ${koSibling} (${new Date(koT * 1000).toISOString()}) — last-commit delta ${(delta / 86400).toFixed(1)}d exceeds ${STALE_THRESHOLD_DAYS}d`,
          );
        }
      }
      continue;
    }
    if (KNOWN_EN_ONLY.has(file)) continue;
    violations.push(`MISSING_KO: ${file} (no ${koSibling}, and not in KNOWN_EN_ONLY allowlist)`);
  }

  if (violations.length > 0) {
    console.error("README parity check FAILED:");
    for (const v of violations) console.error(`  ${v}`);
    console.error("");
    console.error(
      `Add a translation (e.g. ${violations[0]?.split(" ")[1]?.replace(/\.md$/, ".ko.md")}) or, if the file is intentionally EN-only, add it to KNOWN_EN_ONLY in scripts/check-readme-parity.mjs.`,
    );
    process.exit(1);
  }
  console.log(`README parity OK — ${all.length} .md files checked.`);
}

main();
