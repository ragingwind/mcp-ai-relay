// Integration test for the CLI bin's published-tarball install path.
//
// Catches the regression class: "the package builds and unit-tests
// pass, but the actual `npm install <tgz>` (or `npx`) flow breaks
// because a runtime dep isn't pulled in." That's exactly what
// happened on first attempt: `peerDependenciesMeta.openai.optional`
// was true, so `npx` skipped openai and the bin crashed at
// import-resolution time.
//
// Test flow:
//   1. `npm pack` from packages/sdk/ → ragingwind-mcp-ai-relay-<v>.tgz
//   2. Install the tarball + declared peer deps in a temp dir.
//   3. Run the installed bin's `node_modules/.bin/mcp-ai-relay`:
//        --version, --help, tools/list, missing-flag, missing-env
//      and assert exit codes + outputs.
//
// Why integration, not unit:
//   - Needs network for peer-dep resolution from the npm registry.
//   - Spawns a real child process; takes ~10-30 s end to end.
//   - Catches packaging regressions that unit tests can't see.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..", "..");

let scratchDir: string | null = null;
let binPath: string;

beforeAll(async () => {
  // Pack the SDK into a tarball. `npm pack` uses the SDK's package.json
  // `files` field, so the tarball matches what npm publish would ship.
  // Clean stale tarballs first so the glob below resolves to one file.
  for (const name of readdirSync(SDK_DIR)) {
    if (name.endsWith(".tgz")) rmSync(join(SDK_DIR, name));
  }
  execFileSync("npm", ["pack"], { cwd: SDK_DIR, stdio: "pipe" });
  const tarballs = readdirSync(SDK_DIR).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected 1 tarball after npm pack, got ${tarballs.length}: ${tarballs.join(", ")}`,
    );
  }
  const tarball = join(SDK_DIR, tarballs[0]!);

  scratchDir = mkdtempSync(join(tmpdir(), "mcp-ai-relay-bin-"));
  // A bare ESM package so `npm install` resolves transitive ESM deps cleanly.
  writeFileSync(
    join(scratchDir, "package.json"),
    JSON.stringify({ name: "bin-tarball-test", private: true, type: "module" }),
  );
  // `npm install <tgz>` pulls the tarball; non-optional peer deps
  // (`@modelcontextprotocol/sdk`, `openai`) are auto-installed by npm 7+.
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: scratchDir,
    stdio: "pipe",
  });
  binPath = join(scratchDir, "node_modules", ".bin", "mcp-ai-relay");
  if (!existsSync(binPath)) {
    throw new Error(`bin not present at ${binPath} after install`);
  }
  // Clean the tarball so it doesn't end up in `git status`.
  rmSync(tarball);
}, 180_000);

afterAll(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("cli bin — installed tarball", () => {
  it("P1: --version prints the SDK version", () => {
    const r = spawnSync(binPath, ["--version"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0.1.0");
  });

  it("P2: --help prints usage text", () => {
    const r = spawnSync(binPath, ["--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: mcp-ai-relay");
    expect(r.stdout).toContain("--openai-completion");
  });

  it("P3: --openai-completion answers a tools/list JSON-RPC request", () => {
    const r = spawnSync(binPath, ["--openai-completion"], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
      env: { ...process.env, OPENAI_API_KEY: "test-key" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const responseLine = r.stdout.split("\n").find((l) => l.trim().startsWith("{"));
    expect(responseLine).toBeDefined();
    const response = JSON.parse(responseLine as string);
    expect(response.result.tools).toHaveLength(1);
    expect(response.result.tools[0].name).toBe("completion_chat");
  });

  it("P4: --name and --description override the registered tool descriptor", () => {
    const r = spawnSync(
      binPath,
      ["--openai-completion", "--name", "azure_chat", "--description", "Azure deployment"],
      {
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
        env: { ...process.env, OPENAI_API_KEY: "test-key" },
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(0);
    const responseLine = r.stdout.split("\n").find((l) => l.trim().startsWith("{"));
    const response = JSON.parse(responseLine as string);
    expect(response.result.tools[0].name).toBe("azure_chat");
    expect(response.result.tools[0].description).toBe("Azure deployment");
  });

  it("D1: missing provider flag exits with code 2 and prints usage to stderr", () => {
    const r = spawnSync(binPath, [], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("provider flag");
    expect(r.stderr).toContain("Usage: mcp-ai-relay");
  });

  it("D2: unknown argument exits with code 2", () => {
    const r = spawnSync(binPath, ["--bogus-flag"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown argument");
  });

  it("D3: missing OPENAI_API_KEY exits with code 1", () => {
    const r = spawnSync(binPath, ["--openai-completion"], {
      env: { ...process.env, OPENAI_API_KEY: "" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("OPENAI_API_KEY");
  });
});
