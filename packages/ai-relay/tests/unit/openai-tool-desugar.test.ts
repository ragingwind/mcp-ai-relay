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

  it("P3: model option lifts to a top-level field", () => {
    expect(openAIChatTool.desugar?.("hi", { model: "gpt-x" })).toEqual({
      model: "gpt-x",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("P4: result merged with -m model passes the schema", () => {
    const desugared = openAIChatTool.desugar?.("hi", {});
    expect(desugared).toBeDefined();
    const merged = { ...desugared, model: "gpt-4o-mini" };
    const schema = makeOpenAIChatSchema(4096);
    const parsed = schema.parse(merged);
    expect(parsed.model).toBe("gpt-4o-mini");
    expect(parsed.messages).toHaveLength(1);
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
