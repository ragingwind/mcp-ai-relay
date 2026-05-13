import { describe, expect, it } from "vitest";
import {
  createVerboseLogger,
  dumpMessages,
  isVerboseEnv,
  redactArgv,
  redactSecret,
  snapshotRelayEnv,
  summariseMessages,
} from "../../src/bin/logger.js";

function makeStream() {
  const buf = { value: "" };
  const stream = {
    write(chunk: string) {
      buf.value += chunk;
    },
  };
  return { buf, stream };
}

describe("isVerboseEnv", () => {
  it("P1: '1' / 'true' / 'yes' / 'on' all enable verbose", () => {
    for (const v of ["1", "true", "TRUE", "Yes", "on", "ON"]) {
      expect(isVerboseEnv({ AI_RELAY_VERBOSE: v })).toBe(true);
    }
  });

  it("P2: empty / '0' / 'false' / undefined disable verbose", () => {
    expect(isVerboseEnv({})).toBe(false);
    expect(isVerboseEnv({ AI_RELAY_VERBOSE: "" })).toBe(false);
    expect(isVerboseEnv({ AI_RELAY_VERBOSE: "0" })).toBe(false);
    expect(isVerboseEnv({ AI_RELAY_VERBOSE: "false" })).toBe(false);
    expect(isVerboseEnv({ AI_RELAY_VERBOSE: "no" })).toBe(false);
  });
});

describe("redactSecret", () => {
  it("P1: returns length-only marker for non-empty input", () => {
    expect(redactSecret("sk-secret-1234567890")).toBe("***redacted(20chars)***");
  });

  it("P2: returns (unset) for undefined or empty", () => {
    expect(redactSecret(undefined)).toBe("(unset)");
    expect(redactSecret("")).toBe("(unset)");
  });

  it("D1: never echoes the secret content", () => {
    const sentinel = "leak-canary-9999";
    const out = redactSecret(sentinel);
    expect(out).not.toContain(sentinel);
  });
});

describe("createVerboseLogger — disabled", () => {
  it("P1: enabled=false produces no output and no-op log()", () => {
    const { buf, stream } = makeStream();
    const logger = createVerboseLogger({ enabled: false, stream });
    expect(logger.enabled).toBe(false);
    logger.log("argv", ["chat-completions"]);
    logger.log("env-snapshot", { AI_RELAY_API_KEY: "***" });
    expect(buf.value).toBe("");
  });
});

describe("createVerboseLogger — enabled", () => {
  it("P1: format is `[ai-relay] <stage>: <data>` with trailing newline", () => {
    const { buf, stream } = makeStream();
    const logger = createVerboseLogger({ enabled: true, stream });
    logger.log("argv", ["chat-completions", "-m", "gpt-4o-mini", "ping"]);
    expect(buf.value).toMatch(/^\[ai-relay\] argv: \[\n/);
    expect(buf.value.endsWith("\n")).toBe(true);
  });

  it("P2: format does not include an ISO timestamp", () => {
    const { buf, stream } = makeStream();
    const logger = createVerboseLogger({ enabled: true, stream });
    logger.log("ping", "pong");
    expect(buf.value).toBe("[ai-relay] ping: pong\n");
    expect(buf.value).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("P3: multi-line data writes continuation prefix on subsequent lines", () => {
    const { buf, stream } = makeStream();
    const logger = createVerboseLogger({ enabled: true, stream });
    logger.log("data", { a: 1, b: 2 });
    const lines = buf.value.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^\[ai-relay\] data: \{/);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toMatch(/^\[ai-relay\] {3}/);
    }
  });
});

describe("snapshotRelayEnv", () => {
  it("P1: includes only AI_RELAY_* keys, secrets redacted", () => {
    const snap = snapshotRelayEnv({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      AI_RELAY_API_KEY: "sk-secret-12345",
      AI_RELAY_AUTH_TOKEN: "auth-secret-678",
      AI_RELAY_BASE_URL: "https://example.test/v1",
      AI_RELAY_MAX_TOKENS: "4096",
    });
    expect(snap).toEqual({
      AI_RELAY_API_KEY: "***redacted(15chars)***",
      AI_RELAY_AUTH_TOKEN: "***redacted(15chars)***",
      AI_RELAY_BASE_URL: "https://example.test/v1",
      AI_RELAY_MAX_TOKENS: "4096",
    });
    expect("PATH" in snap).toBe(false);
  });

  it("D1: never echoes a plaintext API key", () => {
    const sentinel = "plaintext-leak-marker-9999";
    const snap = snapshotRelayEnv({ AI_RELAY_API_KEY: sentinel });
    expect(JSON.stringify(snap)).not.toContain(sentinel);
  });
});

describe("redactArgv", () => {
  it("P1: --api-key value is redacted (separate-token form)", () => {
    const out = redactArgv(["chat-completions", "-v", "--api-key", "sk-leak-9999", "hi"]);
    expect(out).toEqual(["chat-completions", "-v", "--api-key", "***redacted(12chars)***", "hi"]);
  });

  it("P2: --api-key=value inline form is redacted", () => {
    const out = redactArgv(["chat-completions", "--api-key=sk-secret-7", "hi"]);
    expect(out).toEqual(["chat-completions", "--api-key=***redacted(11chars)***", "hi"]);
  });

  it("D1: non-secret flags pass through untouched", () => {
    const out = redactArgv(["chat-completions", "-m", "gpt-4o-mini", "--base-url", "https://x/v1"]);
    expect(out).toEqual(["chat-completions", "-m", "gpt-4o-mini", "--base-url", "https://x/v1"]);
  });
});

describe("summariseMessages", () => {
  it("P1: replaces content with role + char count + short preview", () => {
    const out = summariseMessages([
      { role: "user", content: "ping" },
      { role: "assistant", content: "x".repeat(200) },
    ]);
    expect(Array.isArray(out)).toBe(true);
    if (!Array.isArray(out)) throw new Error("unreachable");
    expect(out[0]).toEqual({ role: "user", chars: 4, preview: "ping" });
    expect(out[1]?.role).toBe("assistant");
    expect(out[1]?.chars).toBe(200);
    expect(out[1]?.preview).toMatch(/…$/);
  });

  it("D1: returns error marker for non-array", () => {
    expect(summariseMessages("not-an-array")).toEqual({ error: "not-an-array (string)" });
  });
});

describe("dumpMessages", () => {
  it("P1: returns the array verbatim when input is an array", () => {
    const messages = [
      { role: "user", content: "ping" },
      { role: "assistant", content: "x".repeat(500) },
    ];
    const out = dumpMessages(messages);
    expect(out).toBe(messages);
    expect(out).toEqual(messages);
  });

  it("P2: empty array passes through unchanged", () => {
    const messages: unknown[] = [];
    expect(dumpMessages(messages)).toBe(messages);
  });

  it("D1: non-array input returns error object (string)", () => {
    expect(dumpMessages("not-an-array")).toEqual({ error: "not-an-array (string)" });
  });

  it("D2: non-array input returns error object (undefined)", () => {
    expect(dumpMessages(undefined)).toEqual({ error: "not-an-array (undefined)" });
  });

  it("D3: object input returns error object (object)", () => {
    expect(dumpMessages({ messages: [] })).toEqual({ error: "not-an-array (object)" });
  });
});
