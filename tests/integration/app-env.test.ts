// Integration tests for the relay app's HTTP-only env parser
// (`app/src/env.ts`).

import { describe, expect, it } from "vitest";
import { type EnvSource, parseEnv } from "../../app/src/env.js";

const minimalValid = {
  AI_RELAY_API_KEY: "test-ai-relay-api-key",
  AI_RELAY_AUTH_TOKEN: "x".repeat(32),
  AI_RELAY_MODEL: "gpt-4o-mini",
} satisfies EnvSource;

const expectThrow = (input: EnvSource): Error => {
  let thrown: unknown;
  try {
    parseEnv(input);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
};

describe("parseEnv — required keys", () => {
  it("throws when AI_RELAY_API_KEY is missing", () => {
    const err = expectThrow({
      AI_RELAY_AUTH_TOKEN: "x".repeat(32),
      AI_RELAY_MODEL: "gpt-4o-mini",
    });
    expect(err.message).toContain("AI_RELAY_API_KEY");
  });

  it("throws when AI_RELAY_AUTH_TOKEN is missing", () => {
    const err = expectThrow({ AI_RELAY_API_KEY: "k", AI_RELAY_MODEL: "gpt-4o-mini" });
    expect(err.message).toContain("AI_RELAY_AUTH_TOKEN");
  });

  it("throws when AI_RELAY_MODEL is missing", () => {
    const err = expectThrow({
      AI_RELAY_API_KEY: "k",
      AI_RELAY_AUTH_TOKEN: "x".repeat(32),
    });
    expect(err.message).toContain("AI_RELAY_MODEL");
  });

  it("rejects empty AI_RELAY_MODEL with the required-key message", () => {
    const err = expectThrow({
      AI_RELAY_API_KEY: "k",
      AI_RELAY_AUTH_TOKEN: "x".repeat(32),
      AI_RELAY_MODEL: "",
    });
    expect(err.message).toContain("AI_RELAY_MODEL");
    expect(err.message).toContain("required");
  });

  it("rejects empty AI_RELAY_API_KEY with the required-key message", () => {
    const err = expectThrow({
      AI_RELAY_API_KEY: "",
      AI_RELAY_AUTH_TOKEN: "x".repeat(32),
      AI_RELAY_MODEL: "gpt-4o-mini",
    });
    expect(err.message).toContain("AI_RELAY_API_KEY");
    expect(err.message).toContain("required");
  });

  it("rejects legacy OPENAI_API_KEY (no fallback) — migration error is loud", () => {
    const err = expectThrow({
      OPENAI_API_KEY: "legacy",
      AI_RELAY_AUTH_TOKEN: "x".repeat(32),
      AI_RELAY_MODEL: "gpt-4o-mini",
    });
    expect(err.message).toContain("AI_RELAY_API_KEY");
  });

  it("throws when AI_RELAY_AUTH_TOKEN is 31 bytes (one byte under the floor)", () => {
    const err = expectThrow({
      AI_RELAY_API_KEY: "k",
      AI_RELAY_AUTH_TOKEN: "x".repeat(31),
      AI_RELAY_MODEL: "gpt-4o-mini",
    });
    expect(err.message).toContain("AI_RELAY_AUTH_TOKEN");
    expect(err.message).toContain("at least 32 bytes");
  });

  it("accepts AI_RELAY_AUTH_TOKEN at exactly 32 bytes", () => {
    const env = parseEnv({
      AI_RELAY_API_KEY: "k",
      AI_RELAY_AUTH_TOKEN: "x".repeat(32),
      AI_RELAY_MODEL: "gpt-4o-mini",
    });
    expect(env.AI_RELAY_AUTH_TOKEN).toBe("x".repeat(32));
  });

  it("measures AI_RELAY_AUTH_TOKEN length in bytes, not characters", () => {
    const multibyte = "🦊".repeat(8);
    expect(multibyte.length).toBe(16);
    expect(Buffer.byteLength(multibyte, "utf8")).toBe(32);
    const env = parseEnv({
      AI_RELAY_API_KEY: "k",
      AI_RELAY_AUTH_TOKEN: multibyte,
      AI_RELAY_MODEL: "gpt-4o-mini",
    });
    expect(env.AI_RELAY_AUTH_TOKEN).toBe(multibyte);
  });
});

describe("parseEnv — AI_RELAY_BASE_URL", () => {
  it("defaults AI_RELAY_BASE_URL to undefined when missing", () => {
    const env = parseEnv(minimalValid);
    expect(env.AI_RELAY_BASE_URL).toBeUndefined();
  });

  it("normalises empty AI_RELAY_BASE_URL to undefined", () => {
    const env = parseEnv({ ...minimalValid, AI_RELAY_BASE_URL: "" });
    expect(env.AI_RELAY_BASE_URL).toBeUndefined();
  });

  it("accepts a valid AI_RELAY_BASE_URL", () => {
    const env = parseEnv({
      ...minimalValid,
      AI_RELAY_BASE_URL: "https://api.example.com/v1",
    });
    expect(env.AI_RELAY_BASE_URL).toBe("https://api.example.com/v1");
  });

  it("rejects a non-URL AI_RELAY_BASE_URL", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_BASE_URL: "not-a-url" });
    expect(err.message).toContain("AI_RELAY_BASE_URL");
  });

  it("does not echo AI_RELAY_BASE_URL value in error messages", () => {
    const sentinel = "garbage-url-leak-marker";
    const err = expectThrow({ ...minimalValid, AI_RELAY_BASE_URL: sentinel });
    expect(err.message).not.toContain(sentinel);
    expect(err.message).toContain("AI_RELAY_BASE_URL");
  });
});

describe("parseEnv — defaults", () => {
  it("leaves AI_RELAY_MAX_TOKENS undefined when unset", () => {
    const env = parseEnv(minimalValid);
    expect(env.AI_RELAY_MAX_TOKENS).toBeUndefined();
  });

  it("leaves AI_RELAY_TEMPERATURE undefined when unset", () => {
    const env = parseEnv(minimalValid);
    expect(env.AI_RELAY_TEMPERATURE).toBeUndefined();
  });

  it("leaves AI_RELAY_TOP_P undefined when unset", () => {
    const env = parseEnv(minimalValid);
    expect(env.AI_RELAY_TOP_P).toBeUndefined();
  });

  it("leaves AI_RELAY_STOP undefined when unset", () => {
    const env = parseEnv(minimalValid);
    expect(env.AI_RELAY_STOP).toBeUndefined();
  });

  it("defaults AI_RELAY_REQUEST_TIMEOUT_MS to 60000 when undefined", () => {
    const env = parseEnv(minimalValid);
    expect(env.AI_RELAY_REQUEST_TIMEOUT_MS).toBe(60_000);
  });
});

describe("parseEnv — AI_RELAY_PORT", () => {
  it("defaults AI_RELAY_PORT to 8787 when undefined", () => {
    const env = parseEnv(minimalValid);
    expect(env.AI_RELAY_PORT).toBe(8787);
  });

  it("coerces and accepts a numeric string AI_RELAY_PORT override", () => {
    const env = parseEnv({ ...minimalValid, AI_RELAY_PORT: "9000" });
    expect(env.AI_RELAY_PORT).toBe(9000);
    expect(typeof env.AI_RELAY_PORT).toBe("number");
  });

  it("rejects AI_RELAY_PORT = 0 (out of range)", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_PORT: "0" });
    expect(err.message).toContain("AI_RELAY_PORT");
  });

  it("rejects AI_RELAY_PORT = 70000 (out of range)", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_PORT: "70000" });
    expect(err.message).toContain("AI_RELAY_PORT");
  });
});

describe("parseEnv — numeric coercion", () => {
  it("coerces a numeric string AI_RELAY_MAX_TOKENS to a number", () => {
    const env = parseEnv({ ...minimalValid, AI_RELAY_MAX_TOKENS: "8192" });
    expect(env.AI_RELAY_MAX_TOKENS).toBe(8192);
    expect(typeof env.AI_RELAY_MAX_TOKENS).toBe("number");
  });

  it("rejects AI_RELAY_MAX_TOKENS = 0", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_MAX_TOKENS: "0" });
    expect(err.message).toContain("AI_RELAY_MAX_TOKENS");
  });

  it("rejects negative AI_RELAY_MAX_TOKENS", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_MAX_TOKENS: "-1" });
    expect(err.message).toContain("AI_RELAY_MAX_TOKENS");
  });

  it("rejects non-integer AI_RELAY_MAX_TOKENS", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_MAX_TOKENS: "1.5" });
    expect(err.message).toContain("AI_RELAY_MAX_TOKENS");
  });

  it("rejects non-numeric AI_RELAY_MAX_TOKENS", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_MAX_TOKENS: "abc" });
    expect(err.message).toContain("AI_RELAY_MAX_TOKENS");
  });

  it("coerces and accepts a numeric string AI_RELAY_REQUEST_TIMEOUT_MS", () => {
    const env = parseEnv({ ...minimalValid, AI_RELAY_REQUEST_TIMEOUT_MS: "30000" });
    expect(env.AI_RELAY_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});

describe("parseEnv — sampling parameters", () => {
  it("coerces AI_RELAY_TEMPERATURE to a number", () => {
    const env = parseEnv({ ...minimalValid, AI_RELAY_TEMPERATURE: "0.7" });
    expect(env.AI_RELAY_TEMPERATURE).toBe(0.7);
  });

  it("rejects AI_RELAY_TEMPERATURE below 0", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_TEMPERATURE: "-0.1" });
    expect(err.message).toContain("AI_RELAY_TEMPERATURE");
  });

  it("rejects AI_RELAY_TEMPERATURE above 2", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_TEMPERATURE: "2.5" });
    expect(err.message).toContain("AI_RELAY_TEMPERATURE");
  });

  it("coerces AI_RELAY_TOP_P to a number", () => {
    const env = parseEnv({ ...minimalValid, AI_RELAY_TOP_P: "0.9" });
    expect(env.AI_RELAY_TOP_P).toBe(0.9);
  });

  it("rejects AI_RELAY_TOP_P above 1", () => {
    const err = expectThrow({ ...minimalValid, AI_RELAY_TOP_P: "1.5" });
    expect(err.message).toContain("AI_RELAY_TOP_P");
  });

  it("parses a single-value AI_RELAY_STOP as a string", () => {
    const env = parseEnv({ ...minimalValid, AI_RELAY_STOP: "END" });
    expect(env.AI_RELAY_STOP).toBe("END");
  });

  it("parses a comma-separated AI_RELAY_STOP as an array", () => {
    const env = parseEnv({ ...minimalValid, AI_RELAY_STOP: "END,STOP, \\n" });
    expect(env.AI_RELAY_STOP).toEqual(["END", "STOP", "\\n"]);
  });

  it("treats empty AI_RELAY_STOP as undefined", () => {
    const env = parseEnv({ ...minimalValid, AI_RELAY_STOP: "" });
    expect(env.AI_RELAY_STOP).toBeUndefined();
  });
});

describe("parseEnv — secret redaction", () => {
  it("does not echo input values in error messages (sentinel not leaked)", () => {
    const sentinel = "secret-leak-marker-xyz-1234567890";
    const err = expectThrow({
      AI_RELAY_API_KEY: sentinel,
    });
    expect(err.message).not.toContain(sentinel);
    expect(err.message).not.toContain("secret-leak-marker");
    expect(err.message).not.toContain("1234567890");
  });

  it("includes the failing key path in the error message", () => {
    const sentinel = "another-secret-zzz";
    const err = expectThrow({
      AI_RELAY_API_KEY: sentinel,
    });
    expect(err.message).toContain("AI_RELAY_AUTH_TOKEN");
    expect(err.message).toContain("Invalid environment");
  });

  it("does not echo AI_RELAY_AUTH_TOKEN value when it fails its own length check", () => {
    const sentinel = "short-secret-leak-marker-abcdef"; // 31 bytes
    expect(Buffer.byteLength(sentinel, "utf8")).toBe(31);
    const err = expectThrow({
      AI_RELAY_API_KEY: "k",
      AI_RELAY_AUTH_TOKEN: sentinel,
      AI_RELAY_MODEL: "gpt-4o-mini",
    });
    expect(err.message).not.toContain(sentinel);
    expect(err.message).not.toContain("short-secret-leak-marker");
    expect(err.message).toContain("AI_RELAY_AUTH_TOKEN");
    expect(err.message).toContain("at least 32 bytes");
  });
});
