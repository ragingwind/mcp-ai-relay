// Public-API smoke test for the ai-relay SDK.
//
// Confirms the symbols promoted at the package's top-level are still
// resolvable via the package name (NOT via `../../src/...`). The dropped
// subpath exports (`ai-relay/env`, `ai-relay/auth`) are not asserted at
// runtime — Node's resolver throws on unresolved imports at parse time,
// which would fail this test file before its assertions run. The
// `package.json` exports change is enforced by typecheck instead.

import { describe, expect, it } from "vitest";

describe("ai-relay public surface", () => {
  it("P1: root package re-exports verifyBearer + loadConfig", async () => {
    const mod = await import("ai-relay");
    expect(typeof mod.verifyBearer).toBe("function");
    expect(typeof mod.loadConfig).toBe("function");
  });

  it("P2: ai-relay/openai exports registerOpenAIChat + makeOpenAIChatHandler", async () => {
    const mod = await import("ai-relay/openai");
    expect(typeof mod.registerOpenAIChat).toBe("function");
    expect(typeof mod.makeOpenAIChatHandler).toBe("function");
  });

  it("P3: loadConfig from root produces a usable RelayConfig", async () => {
    const { loadConfig } = await import("ai-relay");
    const cfg = loadConfig({ env: { OPENAI_API_KEY: "k" } });
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]?.id).toBe("openai_chat");
  });
});
