// Integration wrapper around app/scripts/docker-smoke.sh.
//
// Self-skips when Docker is unavailable (so this stays cheap on dev
// machines without Docker). The script itself prints PASS/FAIL per
// assertion; we only assert on its exit code.

import { execSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "app", "scripts", "docker-smoke.sh");

function hasDocker(): boolean {
  try {
    execSync("docker --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasDocker())("docker smoke", () => {
  it(
    "app/scripts/docker-smoke.sh exits 0",
    async () => {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn("bash", [SCRIPT], {
          cwd: REPO_ROOT,
          stdio: "inherit",
          env: process.env,
        });
        child.on("error", rejectPromise);
        child.on("exit", (code) => {
          expect(code).toBe(0);
          resolvePromise();
        });
      });
    },
    5 * 60 * 1000,
  );
});
