// Multi-registration unit test — proves `registerOpenAIChat` is callable
// any number of times on the same MCP server with independent config, and
// that each registered handler captures its own apiKey / baseURL / ceiling
// via closure (no module-level shared state, no cross-talk).
//
// This is the contract that lets one MCP server host multiple upstreams
// (OpenAI proper + Azure + local vLLM, etc.) as distinct named tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOpenAIChatHandler, registerOpenAIChat } from "../../src/openai/chat.js";

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

const VALID_MODEL = "gpt-4o-mini";
const VALID_MESSAGES = [{ role: "user" as const, content: "ping" }];

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(`data: ${chunks[i]}\n\n`));
        i++;
      } else {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

function sseResponse(text: string) {
  return new HttpResponse(
    sseStream([JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("registerOpenAIChat — multi-registration on one McpServer", () => {
  it("P1: registers three tools with distinct names without throwing", () => {
    const server = new McpServer({ name: "multi-relay-test", version: "0.0.1" });
    expect(() => {
      registerOpenAIChat(server, { name: "chat-completions-primary", apiKey: "key-openai" });
      registerOpenAIChat(server, {
        name: "azure_chat",
        apiKey: "key-azure",
        baseURL: "https://azure.example.com/v1",
      });
      registerOpenAIChat(server, {
        name: "local_llm",
        apiKey: "key-local",
        baseURL: "http://localhost:11434/v1",
      });
    }).not.toThrow();
  });

  it("D1: rejects duplicate tool names on the same server", () => {
    const server = new McpServer({ name: "multi-relay-test", version: "0.0.1" });
    registerOpenAIChat(server, { name: "completion_chat", apiKey: "key-1" });
    expect(() => {
      registerOpenAIChat(server, { name: "completion_chat", apiKey: "key-2" });
    }).toThrow();
  });
});

describe("makeOpenAIChatHandler — closure isolation across handlers", () => {
  it("P1: each handler routes to its own baseURL with its own apiKey", async () => {
    let openaiAuth: string | null = null;
    let azureAuth: string | null = null;

    mswServer.use(
      http.post("https://api.openai.com/v1/chat/completions", ({ request }) => {
        openaiAuth = request.headers.get("authorization");
        return sseResponse("from-openai");
      }),
      http.post("https://azure.example.com/v1/chat/completions", ({ request }) => {
        azureAuth = request.headers.get("authorization");
        return sseResponse("from-azure");
      }),
    );

    const a = makeOpenAIChatHandler({ name: "chat-completions-primary", apiKey: "key-openai" });
    const b = makeOpenAIChatHandler({
      name: "azure_chat",
      apiKey: "key-azure",
      baseURL: "https://azure.example.com/v1",
    });

    const ra = await a.handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    const rb = await b.handler({ model: VALID_MODEL, messages: VALID_MESSAGES });

    expect(ra.isError).toBe(false);
    expect(rb.isError).toBe(false);
    expect(ra.content[0]?.text).toBe("from-openai");
    expect(rb.content[0]?.text).toBe("from-azure");
    expect(openaiAuth).toBe("Bearer key-openai");
    expect(azureAuth).toBe("Bearer key-azure");
  });

  it("P2: each handler enforces its own max_tokens ceiling", async () => {
    let observedAtA: number | undefined;
    let observedAtB: number | undefined;

    mswServer.use(
      http.post("https://a.example.com/v1/chat/completions", async ({ request }) => {
        const body = (await request.json()) as { max_tokens?: number };
        observedAtA = body.max_tokens;
        return sseResponse("a");
      }),
      http.post("https://b.example.com/v1/chat/completions", async ({ request }) => {
        const body = (await request.json()) as { max_tokens?: number };
        observedAtB = body.max_tokens;
        return sseResponse("b");
      }),
    );

    const a = makeOpenAIChatHandler({
      apiKey: "key-a",
      baseURL: "https://a.example.com/v1",
      maxOutputTokensCeiling: 100,
    });
    const b = makeOpenAIChatHandler({
      apiKey: "key-b",
      baseURL: "https://b.example.com/v1",
      maxOutputTokensCeiling: 8000,
    });

    await a.handler({ model: VALID_MODEL, messages: VALID_MESSAGES, max_tokens: 999 });
    await b.handler({ model: VALID_MODEL, messages: VALID_MESSAGES, max_tokens: 999 });

    expect(observedAtA).toBe(100); // clamped
    expect(observedAtB).toBe(999); // under b's ceiling — passes through
  });

  it("D1: aborting one handler does not affect a concurrent call on another", async () => {
    // a: never-closing stream, will be aborted.
    // b: completes normally.
    mswServer.use(
      http.post(
        "https://a.example.com/v1/chat/completions",
        () =>
          new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(
                  enc.encode(
                    `data: ${JSON.stringify({
                      choices: [{ delta: { content: "partial-a" } }],
                    })}\n\n`,
                  ),
                );
                // intentionally never closes
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
      http.post("https://b.example.com/v1/chat/completions", () => sseResponse("done-b")),
    );

    const a = makeOpenAIChatHandler({
      apiKey: "key-a",
      baseURL: "https://a.example.com/v1",
    });
    const b = makeOpenAIChatHandler({
      apiKey: "key-b",
      baseURL: "https://b.example.com/v1",
    });

    const acA = new AbortController();
    const promiseA = a.handler(
      { model: VALID_MODEL, messages: VALID_MESSAGES },
      { signal: acA.signal },
    );
    const promiseB = b.handler({ model: VALID_MODEL, messages: VALID_MESSAGES });

    await Promise.resolve();
    acA.abort();

    const [resA, resB] = await Promise.all([promiseA, promiseB]);

    expect(resA.isError).toBe(true);
    expect(resA.structuredContent.code).toBe("upstream_error");
    expect(resB.isError).toBe(false);
    expect(resB.content[0]?.text).toBe("done-b");
  });
});
