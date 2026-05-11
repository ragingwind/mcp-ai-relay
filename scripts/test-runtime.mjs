#!/usr/bin/env node
// Local runtime-matrix runner. Runs the smoke fixtures against installed
// runtimes only — cells whose runtime is missing are skipped (not failed).
//
// To run a full matrix, push to a branch and let
// `.github/workflows/runtime-matrix.yml` cover the cells this script skipped.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
})();

function has(cmd) {
  const r = spawnSync("command", ["-v", cmd], { shell: true });
  return r.status === 0;
}

function pack() {
  const sdkDir = join(REPO_ROOT, "packages", "ai-relay");
  const outDir = join(tmpdir(), `ai-relay-runtime-pack-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  // Build first so dist/ is fresh.
  execFileSync("pnpm", ["--filter", "ai-relay", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  // `npm pack` works regardless of which package manager owns the workspace.
  execFileSync("npm", ["pack", "--pack-destination", outDir], {
    cwd: sdkDir,
    stdio: "inherit",
  });
  const tgz = readdirSync(outDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("pack: no tarball produced");
  return join(outDir, tgz);
}

function installInto(fixtureDir, tarball) {
  // npm install --no-save: ensures the lockfile/package.json drift is local.
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-save", tarball], {
    cwd: fixtureDir,
    stdio: "inherit",
  });
}

function runNodeSmoke(tarball) {
  if (!has("node")) {
    console.log("SKIP: node not on PATH");
    return { ran: false };
  }
  const fix = join(REPO_ROOT, "tests", "runtime-fixtures", "smoke-node");
  installInto(fix, tarball);
  const r = spawnSync("node", ["smoke.mjs"], { cwd: fix, stdio: "inherit" });
  return { ran: true, ok: r.status === 0 };
}

function runBunSmoke(tarball) {
  if (!has("bun")) {
    console.log("SKIP: bun not on PATH");
    return { ran: false };
  }
  const fix = join(REPO_ROOT, "tests", "runtime-fixtures", "smoke-bun");
  installInto(fix, tarball);
  const r = spawnSync("bun", ["run", "smoke.mjs"], { cwd: fix, stdio: "inherit" });
  return { ran: true, ok: r.status === 0 };
}

function runCjsSmoke(tarball) {
  if (!has("node")) {
    console.log("SKIP: node not on PATH");
    return { ran: false };
  }
  const fix = join(REPO_ROOT, "tests", "runtime-fixtures", "cjs-require");
  installInto(fix, tarball);
  const r = spawnSync("node", ["smoke.cjs"], { cwd: fix, stdio: "inherit" });
  return { ran: true, ok: r.status === 0 };
}

function main() {
  const tarball = pack();
  if (!existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`);

  const results = [
    { name: "smoke-node", ...runNodeSmoke(tarball) },
    { name: "smoke-bun", ...runBunSmoke(tarball) },
    { name: "cjs-require", ...runCjsSmoke(tarball) },
  ];

  let failed = 0;
  for (const r of results) {
    if (!r.ran) {
      console.log(`[${r.name}] SKIP (runtime missing)`);
      continue;
    }
    console.log(`[${r.name}] ${r.ok ? "PASS" : "FAIL"}`);
    if (!r.ok) failed++;
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
