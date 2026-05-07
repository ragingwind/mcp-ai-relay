// Unit tests for the CLI's pure helpers — `parseArgs` and
// `buildOpenAIChatConfig`. The `main()` invocation itself is left
// untested at the unit layer (it touches stdin/stdout + process.exit
// which is awkward to harness); end-to-end smoke is the README's
// `--help` and `tools/list` invocations.
//
// Helpers live in `src/bin/helpers.ts` (split from `cli.ts`) so
// importing them does NOT trigger the CLI's top-level `main()`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOpenAIChatConfig, parseArgs } from "../../src/bin/helpers.js";

describe("parseArgs", () => {
  it("P1: parses --openai-completion as provider", () => {
    const out = parseArgs(["--openai-completion"]);
    expect(out.provider).toBe("openai-completion");
    expect(out.help).toBe(false);
    expect(out.version).toBe(false);
  });

  it("P2: --help short and long forms set help: true", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("P3: --version short and long forms set version: true", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-V"]).version).toBe(true);
  });

  it("P4: --name <value> captures the next token", () => {
    const out = parseArgs(["--openai-completion", "--name", "my_chat"]);
    expect(out.name).toBe("my_chat");
  });

  it("P5: --description <value> captures the next token", () => {
    const out = parseArgs(["--openai-completion", "--description", "my desc"]);
    expect(out.description).toBe("my desc");
  });

  it("D1: rejects unknown arguments", () => {
    expect(() => parseArgs(["--unknown"])).toThrow(/Unknown argument: --unknown/);
  });

  it("D2: rejects multiple provider flags (when more land in v0.x)", () => {
    // Synthetic test: simulate by running --openai-completion twice. Since
    // we ship one provider today, the same flag twice exercises the same
    // guard the future multi-flag rejection will use.
    expect(() => parseArgs(["--openai-completion", "--openai-completion"])).toThrow(
      /Multiple provider flags/,
    );
  });

  it("D3: rejects --name without a value", () => {
    expect(() => parseArgs(["--openai-completion", "--name"])).toThrow(/--name requires a value/);
  });

  it("D4: rejects --name when the next token starts with --", () => {
    expect(() => parseArgs(["--openai-completion", "--name", "--description", "x"])).toThrow(
      /--name requires a value/,
    );
  });

  it("N1: empty argv yields provider: null + help/version: false", () => {
    const out = parseArgs([]);
    expect(out.provider).toBeNull();
    expect(out.help).toBe(false);
    expect(out.version).toBe(false);
    expect(out.name).toBeUndefined();
    expect(out.description).toBeUndefined();
  });
});

describe("buildOpenAIChatConfig", () => {
  // Snapshot env keys the helper reads so we can restore exact state.
  const KEYS = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MAX_OUTPUT_TOKENS_CEILING",
    "OPENAI_REQUEST_TIMEOUT_MS",
  ] as const;
  let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it("P1: builds minimum config from OPENAI_API_KEY only", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const config = buildOpenAIChatConfig({
      provider: "openai-completion",
      help: false,
      version: false,
    });
    expect(config.apiKey).toBe("sk-test");
    expect(config.baseURL).toBeUndefined();
    expect(config.maxOutputTokensCeiling).toBeUndefined();
    expect(config.requestTimeoutMs).toBeUndefined();
    expect(config.name).toBeUndefined();
    expect(config.description).toBeUndefined();
  });

  it("P2: forwards OPENAI_BASE_URL", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://azure.example.com/v1";
    const config = buildOpenAIChatConfig({
      provider: "openai-completion",
      help: false,
      version: false,
    });
    expect(config.baseURL).toBe("https://azure.example.com/v1");
  });

  it("P3: parses OPENAI_MAX_OUTPUT_TOKENS_CEILING + OPENAI_REQUEST_TIMEOUT_MS as numbers", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_MAX_OUTPUT_TOKENS_CEILING = "8192";
    process.env.OPENAI_REQUEST_TIMEOUT_MS = "30000";
    const config = buildOpenAIChatConfig({
      provider: "openai-completion",
      help: false,
      version: false,
    });
    expect(config.maxOutputTokensCeiling).toBe(8192);
    expect(config.requestTimeoutMs).toBe(30000);
  });

  it("P4: --name and --description override flow into config", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const config = buildOpenAIChatConfig({
      provider: "openai-completion",
      name: "my_chat",
      description: "Custom",
      help: false,
      version: false,
    });
    expect(config.name).toBe("my_chat");
    expect(config.description).toBe("Custom");
  });

  it("N1: omits OPENAI_BASE_URL when env is empty string", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "";
    const config = buildOpenAIChatConfig({
      provider: "openai-completion",
      help: false,
      version: false,
    });
    expect(config.baseURL).toBeUndefined();
  });
});
