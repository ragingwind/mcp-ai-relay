// Pre-startup unit tests for `ai-relay <api-type>` — covers argv parsing,
// registry lookup, --help / --version, and config-error short circuits
// before the stdio transport is ever constructed. The transport itself
// is exercised by tests/integration/bin-tarball.test.ts.

import { describe, expect, it } from "vitest";
import { type AiRelayIO, main, VERSION } from "../../src/bin/ai-relay.js";

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
    expect(cap.stdout.value).toContain("Usage: ai-relay <api-type>");
    expect(cap.stdout.value).toContain("chat-completions");
  });

  it("P2: -h prints usage on stdout, exit 0", async () => {
    const cap = makeIO();
    const code = await main(["-h"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value).toContain("Usage: ai-relay <api-type>");
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

  it("P5: VERSION matches package version (0.7.x)", () => {
    expect(VERSION).toMatch(/^0\.7\.\d+$/);
  });
});

describe("ai-relay — usage / registry errors", () => {
  it("D1: bare invocation (no api-type) → exit 2 + usage on stderr", async () => {
    const cap = makeIO();
    const code = await main([], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("<api-type>");
    expect(cap.stderr.value).toContain("usage: ai-relay <api-type>");
    expect(cap.stdout.value).toBe("");
  });

  it("D2: unknown api-type → exit 2 + 'unknown api-type' on stderr", async () => {
    const cap = makeIO({ AI_RELAY_API_KEY: "k" });
    const code = await main(["messages"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("unknown api-type: messages");
    expect(cap.stderr.value).toContain("chat-completions");
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
    const code = await main(["chat-completions", "extra"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("usage: ai-relay <api-type>");
  });

  it("D6: --max-tokens with non-integer rejected (before registry lookup)", async () => {
    const cap = makeIO({ AI_RELAY_API_KEY: "k" });
    const code = await main(["chat-completions", "--max-tokens", "abc"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("--max-tokens must be a positive integer");
  });
});

describe("ai-relay — config / env-file errors", () => {
  it("D1: missing AI_RELAY_API_KEY → exit 2 before stdio transport starts", async () => {
    const cap = makeIO({});
    const code = await main(["chat-completions"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value.toLowerCase()).toContain("apikey");
  });

  it("D2: missing --env file → exit 2 with file-read message", async () => {
    const cap = makeIO({ AI_RELAY_API_KEY: "k" });
    const code = await main(["chat-completions", "--env", "/no/such/file.env"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("cannot read --env file");
  });
});
