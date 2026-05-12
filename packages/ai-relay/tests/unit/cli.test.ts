// Argv parser tests for `ai-relay-cli <tool> <model> [flags] [input]`.

import { describe, expect, it } from "vitest";
import { parseArgv, UsageError } from "../../src/bin/parse.js";

describe("parseArgv — basic shape", () => {
  it("P1: <tool> <model> <input> → ParsedInvocation", () => {
    const out = parseArgv(["chat-completions", "gpt-4o-mini", "hi"]);
    expect(out.tool).toBe("chat-completions");
    expect(out.model).toBe("gpt-4o-mini");
    expect(out.positional).toBe("hi");
    expect(out.help).toBe(false);
    expect(out.version).toBe(false);
  });

  it("P2: <tool> <model> with no input is valid (stdin will be read by runner)", () => {
    const out = parseArgv(["chat-completions", "gpt-4o-mini"]);
    expect(out.tool).toBe("chat-completions");
    expect(out.model).toBe("gpt-4o-mini");
    expect(out.positional).toBeUndefined();
  });

  it("P3: --system value preserved verbatim and supports multi-word", () => {
    const out = parseArgv(["chat-completions", "gpt-4o-mini", "-s", "be terse and concise", "hi"]);
    expect(out.flags.system).toBe("be terse and concise");
  });

  it("P4: long --system also accepted", () => {
    const out = parseArgv(["chat-completions", "gpt-4o-mini", "--system", "be terse", "hi"]);
    expect(out.flags.system).toBe("be terse");
  });

  it("P5: --key=value and --key value are equivalent", () => {
    const a = parseArgv(["chat-completions", "gpt-4o-mini", "--system=be terse", "hi"]);
    const b = parseArgv(["chat-completions", "gpt-4o-mini", "--system", "be terse", "hi"]);
    expect(a.flags.system).toBe("be terse");
    expect(b.flags.system).toBe("be terse");
  });

  it("P6: numeric flags (--max-tokens, --timeout) parse to integers", () => {
    const out = parseArgv([
      "chat-completions",
      "gpt-4o-mini",
      "--max-tokens",
      "1024",
      "--timeout",
      "30000",
      "hi",
    ]);
    expect(out.flags["max-tokens"]).toBe(1024);
    expect(out.flags.timeout).toBe(30000);
  });

  it("P7: --env path captured", () => {
    const out = parseArgv(["chat-completions", "gpt-4o-mini", "--env", "./prod.env", "hi"]);
    expect(out.flags.env).toBe("./prod.env");
  });

  it("P8: --api-key and --base-url captured", () => {
    const out = parseArgv([
      "chat-completions",
      "gpt-4o-mini",
      "--api-key",
      "sk-secret",
      "--base-url",
      "https://example.test/v1",
      "hi",
    ]);
    expect(out.flags["api-key"]).toBe("sk-secret");
    expect(out.flags["base-url"]).toBe("https://example.test/v1");
  });
});

describe("parseArgv — help/version short-circuit", () => {
  it("P1: -h short-circuits without requiring positionals", () => {
    expect(parseArgv(["-h"]).help).toBe(true);
    expect(parseArgv(["--help"]).help).toBe(true);
  });

  it("P2: -V short-circuits without requiring positionals", () => {
    expect(parseArgv(["-V"]).version).toBe(true);
    expect(parseArgv(["--version"]).version).toBe(true);
  });
});

describe("parseArgv — error paths", () => {
  it("D1: missing model positional → usage error", () => {
    expect(() => parseArgv(["chat-completions"])).toThrow(UsageError);
    expect(() => parseArgv(["chat-completions"])).toThrow(/usage: ai-relay-cli/);
  });

  it("D2: -m flag is no longer accepted (replaced by positional model)", () => {
    expect(() => parseArgv(["chat-completions", "-m", "gpt-4o-mini", "hi"])).toThrow(
      /unknown flag: -m/,
    );
  });

  it("D3: --model flag is no longer accepted", () => {
    expect(() => parseArgv(["chat-completions", "--model", "gpt-4o-mini", "hi"])).toThrow(
      /unknown flag: --model/,
    );
  });

  it("D4: unknown long flag → UsageError", () => {
    expect(() => parseArgv(["chat-completions", "gpt-4o-mini", "--bogus", "x"])).toThrow(
      /unknown flag: --bogus/,
    );
  });

  it("D5: unknown short flag → UsageError", () => {
    expect(() => parseArgv(["chat-completions", "gpt-4o-mini", "-x"])).toThrow(/unknown flag: -x/);
  });

  it("D6: --max-tokens with non-integer value rejected", () => {
    expect(() =>
      parseArgv(["chat-completions", "gpt-4o-mini", "--max-tokens", "abc", "hi"]),
    ).toThrow(/--max-tokens must be a positive integer/);
  });

  it("D7: --max-tokens with zero rejected", () => {
    expect(() => parseArgv(["chat-completions", "gpt-4o-mini", "--max-tokens", "0", "hi"])).toThrow(
      /must be a positive integer/,
    );
  });

  it("D8: more than one positional input rejected", () => {
    expect(() => parseArgv(["chat-completions", "gpt-4o-mini", "a", "b"])).toThrow(
      /at most one positional input/,
    );
  });

  it("D9: flag without value at end of argv rejected", () => {
    expect(() => parseArgv(["chat-completions", "gpt-4o-mini", "--api-key"])).toThrow(
      /--api-key requires a value/,
    );
  });
});
