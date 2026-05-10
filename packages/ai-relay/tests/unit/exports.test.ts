import { describe, expect, it } from "vitest";

describe("ai-relay public surface", () => {
  it("P1: root package re-exports verifyBearer + loadConfig", async () => {
    const mod = await import("ai-relay");
    expect(typeof mod.verifyBearer).toBe("function");
    expect(typeof mod.loadConfig).toBe("function");
  });

  it("P2: ai-relay/openai exports registerOpenAIChat + makeOpenAIChatHandler + openAIChatTool", async () => {
    const mod = await import("ai-relay/openai");
    expect(typeof mod.registerOpenAIChat).toBe("function");
    expect(typeof mod.makeOpenAIChatHandler).toBe("function");
    expect(typeof mod.openAIChatTool).toBe("object");
    expect(mod.openAIChatTool.provider).toBe("openai");
    expect(mod.openAIChatTool.name).toBe("chat");
  });

  it("P3: loadConfig from root produces a usable RelayConfig", async () => {
    const { loadConfig } = await import("ai-relay");
    const cfg = loadConfig({ env: { AI_RELAY_API_KEY: "k" } });
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]?.id).toBe("openai_chat");
  });
});
