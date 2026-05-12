// Pre-startup unit tests for `ai-relay <provider>` — covers argv parsing,
// registry lookup, --help / --version, and config-error short circuits
// before the stdio transport is ever constructed. The transport itself
// is exercised by tests/integration/bin-tarball.test.ts.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { type AiRelayIO, main, VERSION } from "../../src/bin/ai-relay.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

interface CapturedIO {
  stdout: { value: string };
  stderr: { value: string };
  io: AiRelayIO;
}

function makeIO(env: Record<string, string | undefined> = {}): CapturedIO {
  const stdout = { value: "" };
  const stderr = { value: "" };
  return {
    stdout,
    stderr,
    io: {
      stdout: {
        write(s) {
          stdout.value += s;
        },
      },
      stderr: {
        write(s) {
          stderr.value += s;
        },
      },
      env,
    },
  };
}

describe("ai-relay — argv short-circuits", () => {
  it("P1: --help prints usage on stdout, exit 0", async () => {
    const cap = makeIO();
    const code = await main(["--help"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value).toContain("Usage: ai-relay <provider>");
    expect(cap.stdout.value).toContain("openai");
  });

  it("P2: -h prints usage on stdout, exit 0", async () => {
    const cap = makeIO();
    const code = await main(["-h"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value).toContain("Usage: ai-relay <provider>");
  });

  it("P3: --version prints SDK version on stdout, exit 0", async () => {
    const cap = makeIO();
    const code = await main(["--version"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value).toBe(`${VERSION}\n`);
  });

  it("P4: -V prints SDK version on stdout, exit 0", async () => {
    const cap = makeIO();
    const code = await main(["-V"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value).toBe(`${VERSION}\n`);
  });

  it("P5: VERSION equals package.json version and is a valid semver", () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  });
});

describe("ai-relay — usage / registry errors", () => {
  it("D1: bare invocation (no provider) → exit 2 + usage on stderr", async () => {
    const cap = makeIO();
    const code = await main([], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("<provider>");
    expect(cap.stderr.value).toContain("usage: ai-relay <provider>");
    expect(cap.stdout.value).toBe("");
  });

  it("D2: unknown provider → exit 2 + 'unknown provider' on stderr", async () => {
    const cap = makeIO({ AI_RELAY_API_KEY: "k" });
    const code = await main(["anthropic"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("unknown provider: anthropic");
    expect(cap.stderr.value).toContain("openai");
  });

  it("D3: unknown long flag → exit 2 with stderr message", async () => {
    const cap = makeIO();
    const code = await main(["--bogus"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("unknown flag");
  });

  it("D4: unknown short flag → exit 2", async () => {
    const cap = makeIO();
    const code = await main(["-x"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("unknown flag: -x");
  });

  it("D5: more than one positional rejected", async () => {
    const cap = makeIO();
    const code = await main(["openai", "extra"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("usage: ai-relay <provider>");
  });

  it("D6: --max-tokens with non-integer rejected (before registry lookup)", async () => {
    const cap = makeIO({ AI_RELAY_API_KEY: "k" });
    const code = await main(["openai", "--max-tokens", "abc"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("--max-tokens must be a positive integer");
  });
});

describe("ai-relay — config / env-file errors", () => {
  it("D1: missing AI_RELAY_API_KEY → exit 2 before stdio transport starts", async () => {
    const cap = makeIO({});
    const code = await main(["openai"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value.toLowerCase()).toContain("apikey");
  });

  it("D2: missing --env file → exit 2 with file-read message", async () => {
    const cap = makeIO({ AI_RELAY_API_KEY: "k" });
    const code = await main(["openai", "--env", "/no/such/file.env"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("cannot read --env file");
  });
});
