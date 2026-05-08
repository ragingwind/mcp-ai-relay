// Argv parser tests (B6 + B7).

import { describe, expect, it } from "vitest";
import { parseArgv, UsageError } from "../../src/bin/parse.js";

describe("parseArgv — basic shape", () => {
  it("P1: <provider> <tool> -m <model> <input> → ParsedInvocation", () => {
    const out = parseArgv(["openai", "chat", "-m", "gpt-4o-mini", "hi"]);
    expect(out.provider).toBe("openai");
    expect(out.tool).toBe("chat");
    expect(out.flags.model).toBe("gpt-4o-mini");
    expect(out.positional).toBe("hi");
    expect(out.help).toBe(false);
    expect(out.version).toBe(false);
  });

  it("P2: --key=value and --key value are equivalent", () => {
    const a = parseArgv(["openai", "chat", "--model=gpt-4o", "hi"]);
    const b = parseArgv(["openai", "chat", "--model", "gpt-4o", "hi"]);
    expect(a.flags.model).toBe("gpt-4o");
    expect(b.flags.model).toBe("gpt-4o");
  });

  it("P3: -m short form is equivalent to --model", () => {
    const out = parseArgv(["openai", "chat", "-m", "gpt-4o-mini", "hi"]);
    expect(out.flags.model).toBe("gpt-4o-mini");
  });

  it("P4: --system value preserved verbatim and supports multi-word", () => {
    const out = parseArgv([
      "openai",
      "chat",
      "-m",
      "gpt-4o-mini",
      "-s",
      "be terse and concise",
      "hi",
    ]);
    expect(out.flags.system).toBe("be terse and concise");
  });

  it("P5: long --system also accepted", () => {
    const out = parseArgv(["openai", "chat", "-m", "gpt-4o-mini", "--system", "be terse", "hi"]);
    expect(out.flags.system).toBe("be terse");
  });

  it("P6: numeric flags (--max-tokens, --timeout) parse to integers", () => {
    const out = parseArgv([
      "openai",
      "chat",
      "-m",
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
    const out = parseArgv(["openai", "chat", "-m", "x", "--env", "./prod.env", "hi"]);
    expect(out.flags.env).toBe("./prod.env");
  });
});

describe("parseArgv — help/version short-circuit", () => {
  it("P1: -h short-circuits without requiring -m", () => {
    expect(parseArgv(["-h"]).help).toBe(true);
    expect(parseArgv(["--help"]).help).toBe(true);
  });

  it("P2: -V short-circuits without requiring -m", () => {
    expect(parseArgv(["-V"]).version).toBe(true);
    expect(parseArgv(["--version"]).version).toBe(true);
  });
});

describe("parseArgv — error paths", () => {
  it("D1: missing -m → UsageError(--model is required)", () => {
    expect(() => parseArgv(["openai", "chat", "hi"])).toThrow(UsageError);
    expect(() => parseArgv(["openai", "chat", "hi"])).toThrow(/--model is required/);
  });

  it("D2: missing positional pair → usage error", () => {
    expect(() => parseArgv(["openai"])).toThrow(/usage: ai-relay/);
  });

  it("D3: unknown long flag → UsageError", () => {
    expect(() => parseArgv(["openai", "chat", "--bogus", "x"])).toThrow(/unknown flag: --bogus/);
  });

  it("D4: unknown short flag → UsageError", () => {
    expect(() => parseArgv(["openai", "chat", "-x"])).toThrow(/unknown flag: -x/);
  });

  it("D5: --max-tokens with non-integer value rejected", () => {
    expect(() => parseArgv(["openai", "chat", "-m", "x", "--max-tokens", "abc", "hi"])).toThrow(
      /--max-tokens must be a positive integer/,
    );
  });

  it("D6: --max-tokens with zero rejected", () => {
    expect(() => parseArgv(["openai", "chat", "-m", "x", "--max-tokens", "0", "hi"])).toThrow(
      /must be a positive integer/,
    );
  });

  it("D7: more than one positional input rejected", () => {
    expect(() => parseArgv(["openai", "chat", "-m", "x", "a", "b"])).toThrow(
      /at most one positional input/,
    );
  });

  it("D8: flag without value at end of argv rejected", () => {
    expect(() => parseArgv(["openai", "chat", "-m"])).toThrow(/-m requires a value/);
  });
});
