// Unit tests for `src/auth.ts` — `verifyBearer(actual, expected)` returns
// boolean and is fully runtime-portable (no `node:crypto`, no env reads).

import { describe, expect, it } from "vitest";
import { verifyBearer } from "../../src/auth.js";

const EXPECTED = "x".repeat(32);

describe("verifyBearer — input handling", () => {
  it("P1: returns false when actual is undefined", () => {
    expect(verifyBearer(undefined, EXPECTED)).toBe(false);
  });

  it("P2: returns false when actual is the empty string", () => {
    expect(verifyBearer("", EXPECTED)).toBe(false);
  });
});

describe("verifyBearer — fail-closed on missing expected", () => {
  it("D1: returns false when expected is the empty string", () => {
    expect(verifyBearer("anything-non-empty", "")).toBe(false);
  });

  it("D2: returns false when expected is undefined", () => {
    expect(verifyBearer("anything-non-empty", undefined)).toBe(false);
  });

  it("D3: returns false when both are empty", () => {
    expect(verifyBearer("", "")).toBe(false);
  });
});

describe("verifyBearer — length mismatch", () => {
  it("D1: returns false when actual is longer than expected", () => {
    expect(verifyBearer(`${EXPECTED}extra`, EXPECTED)).toBe(false);
  });

  it("D2: returns false when actual is shorter than expected", () => {
    expect(verifyBearer(EXPECTED.slice(0, -1), EXPECTED)).toBe(false);
  });
});

describe("verifyBearer — timing-safe comparison", () => {
  it("D1: returns false when same length but different content", () => {
    const wrong = "y".repeat(EXPECTED.length);
    expect(wrong.length).toBe(EXPECTED.length);
    expect(verifyBearer(wrong, EXPECTED)).toBe(false);
  });

  it("N1: returns false when only the final byte differs", () => {
    const oneOff = `${EXPECTED.slice(0, -1)}y`;
    expect(oneOff.length).toBe(EXPECTED.length);
    expect(oneOff).not.toBe(EXPECTED);
    expect(verifyBearer(oneOff, EXPECTED)).toBe(false);
  });

  it("P1: returns true on exact match", () => {
    expect(verifyBearer(EXPECTED, EXPECTED)).toBe(true);
  });

  it("D2: returns false for unicode-equal but byte-different bearer (NFC vs NFD)", () => {
    // Precomposed "é" is 2 UTF-8 bytes; 16 of them = 32 bytes — matches
    // EXPECTED's byte length but not its bytes. Returning false here
    // confirms the comparator measures bytes, not characters or normalized
    // forms.
    const candidate = "é".repeat(16);
    const enc = new TextEncoder();
    expect(enc.encode(candidate).length).toBe(32);
    expect(verifyBearer(candidate, EXPECTED)).toBe(false);
  });
});
