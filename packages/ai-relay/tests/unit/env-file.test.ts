import { describe, expect, it } from "vitest";
import { parseEnvFile } from "../../src/bin/env-file.js";

describe("parseEnvFile — happy path", () => {
  it("P1: KEY=value parses to a flat map", () => {
    expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("P2: double-quoted value strips quotes", () => {
    expect(parseEnvFile('FOO="bar baz"')).toEqual({ FOO: "bar baz" });
  });

  it("P3: single-quoted value strips quotes", () => {
    expect(parseEnvFile("FOO='bar baz'")).toEqual({ FOO: "bar baz" });
  });

  it("P4: KEY= empty value", () => {
    expect(parseEnvFile("FOO=")).toEqual({ FOO: "" });
  });

  it("P5: blank lines and # comments are ignored", () => {
    const text = ["# top comment", "", "FOO=bar", "  # indented comment", "BAZ=qux", ""].join("\n");
    expect(parseEnvFile(text)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("P6: surrounding whitespace on key is trimmed", () => {
    expect(parseEnvFile("  FOO  =bar")).toEqual({ FOO: "bar" });
  });
});

describe("parseEnvFile — error paths", () => {
  it("D1: 'export ' prefix is rejected with line number", () => {
    expect(() => parseEnvFile("FOO=ok\nexport BAR=value\n")).toThrow(/line 2/);
  });

  it("D2: missing '=' rejected", () => {
    expect(() => parseEnvFile("JUST_A_TOKEN")).toThrow(/missing '='/);
  });

  it("D3: invalid key character rejected", () => {
    expect(() => parseEnvFile("1FOO=bar")).toThrow(/invalid key/);
  });

  it("D4: error message does NOT include the value (no leak)", () => {
    const sentinel = "leak-marker-1234567890";
    let err: Error | undefined;
    try {
      parseEnvFile(`export FOO=${sentinel}\n`);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).not.toContain(sentinel);
  });
});
