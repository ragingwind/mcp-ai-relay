import { describe, expect, it } from "vitest";
import { makeOpenAIChatSchema, openAIChatTool } from "../../src/openai/index.js";

describe("openAIChatTool.desugar — plain-text → input JSON", () => {
  it("P1: bare string with no opts builds a single user message", () => {
    expect(openAIChatTool.desugar?.("hi", {})).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("P2: system option is prepended", () => {
    expect(openAIChatTool.desugar?.("hi", { system: "be terse" })).toEqual({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
  });

  it("P3: desugar result passes the messages-only schema", () => {
    const desugared = openAIChatTool.desugar?.("hi", {});
    expect(desugared).toBeDefined();
    const schema = makeOpenAIChatSchema();
    const parsed = schema.parse(desugared);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("D1: schema rejects a model field on caller input", () => {
    const schema = makeOpenAIChatSchema();
    expect(() =>
      schema.parse({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ).toThrow();
  });
});

describe("openAIChatTool — descriptor metadata", () => {
  it("P1: descriptor has provider 'openai' and name 'chat-completions'", () => {
    expect(openAIChatTool.provider).toBe("openai");
    expect(openAIChatTool.name).toBe("chat-completions");
  });

  it("P2: makeHandler is a function", () => {
    expect(typeof openAIChatTool.makeHandler).toBe("function");
  });
});
