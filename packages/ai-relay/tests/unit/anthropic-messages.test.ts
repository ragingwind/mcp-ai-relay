// Unit tests for `lib/anthropic/messages.ts` — the framework-agnostic
// Anthropic Messages registrar. Tests target `makeAnthropicMessagesHandler`
// (the factory `registerAnthropicMessages` calls internally) with MSW
// intercepting the upstream HTTP boundary. Each test creates its own
// handler so there is no module-level shared state to reset.

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type AnthropicMessagesConfig,
  type AnthropicMessagesHandlerBundle,
  type AnthropicMessagesResult,
  makeAnthropicMessagesHandler,
} from "../../src/anthropic/messages.js";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ENDPOINT = "https://api.anthropic.com/v1/messages";

const TEST_API_KEY = "test-anthropic-api-key";

const VALID_MODEL = "claude-sonnet-4-5";
const VALID_MESSAGES = [{ role: "user" as const, content: "say hi" }];

function makeHandler(
  overrides: Partial<AnthropicMessagesConfig> = {},
): AnthropicMessagesHandlerBundle {
  return makeAnthropicMessagesHandler({
    apiKey: TEST_API_KEY,
    model: VALID_MODEL,
    ...overrides,
  });
}

function sseStream(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < events.length) {
        const e = events[i];
        if (e) {
          controller.enqueue(
            encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`),
          );
        }
        i++;
      } else {
        controller.close();
      }
    },
  });
}

function sseResponse(events: Array<{ event: string; data: unknown }>) {
  return new HttpResponse(sseStream(events), {
    headers: { "content-type": "text/event-stream" },
  });
}

function defaultOkStream(text = "ok"): Array<{ event: string; data: unknown }> {
  return [
    {
      event: "message_start",
      data: { type: "message_start", message: { usage: { input_tokens: 5 } } },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function assertNoSecretLeak(result: AnthropicMessagesResult | unknown): void {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(TEST_API_KEY);
}

// =========================================================================
// A: Input Validation
// =========================================================================

describe("anthropic messages — input validation", () => {
  it("P1: accepts a minimal { messages } input", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse(defaultOkStream())));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
  });

  it("D1: rejects unknown extra keys (strict schema)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: VALID_MESSAGES, unknown: "x" })).rejects.toThrow();
  });

  it("D2: rejects role enum value outside {system,user,assistant}", async () => {
    const { handler } = makeHandler();
    await expect(
      handler({ messages: [{ role: "tool", content: "x" }] as unknown }),
    ).rejects.toThrow();
  });

  it("D3: rejects empty messages array (min 1)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: [] })).rejects.toThrow();
  });
});

// =========================================================================
// B: System extraction
// =========================================================================

describe("anthropic messages — system extraction from leading messages", () => {
  it("P1: leading single system message → top-level system", async () => {
    let body: { system?: string; messages?: unknown[] } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
    expect(body?.system).toBe("be terse");
    expect(body?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("P2: multiple leading system messages joined with \\n\\n", async () => {
    let body: { system?: string } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    });
    expect(body?.system).toBe("A\n\nB");
  });

  it("P3: no system messages → request body omits system", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    expect(body).toBeDefined();
    expect("system" in (body ?? {})).toBe(false);
  });

  it("D1: non-leading system message → isError with code bad_request", async () => {
    const { handler } = makeHandler();
    const result = await handler({
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "interleaved" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("bad_request");
    expect(result.content[0]?.text).toMatch(/interleaved/i);
  });
});

// =========================================================================
// C: max_tokens default
// =========================================================================

describe("anthropic messages — max_tokens default", () => {
  it("P1: config.max_tokens unset → 1024 applied on upstream call", async () => {
    let body: { max_tokens?: number } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    expect(body?.max_tokens).toBe(1024);
  });

  it("P2: config.max_tokens explicit → upstream sees the explicit value", async () => {
    let body: { max_tokens?: number } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler({ max_tokens: 2048 });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.max_tokens).toBe(2048);
  });
});

// =========================================================================
// D: Stop translation
// =========================================================================

describe("anthropic messages — stop → stop_sequences translation", () => {
  it("P1: config.stop string → stop_sequences: [string]", async () => {
    let body: { stop_sequences?: unknown } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler({ stop: "END" });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.stop_sequences).toEqual(["END"]);
  });

  it("P2: config.stop array → stop_sequences mirrors the array", async () => {
    let body: { stop_sequences?: unknown } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler({ stop: ["A", "B"] });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.stop_sequences).toEqual(["A", "B"]);
  });

  it("N1: config.stop undefined → stop_sequences omitted", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    expect("stop_sequences" in (body ?? {})).toBe(false);
  });
});

// =========================================================================
// E: Stream accumulation
// =========================================================================

describe("anthropic messages — stream accumulation", () => {
  it("P1: multi-chunk text_delta concatenated into accumulated text", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          {
            event: "message_start",
            data: { type: "message_start", message: { usage: { input_tokens: 4 } } },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Hello" },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: " " },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "world" },
            },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 2 },
            },
          },
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Hello world");
    expect(result.structuredContent.model).toBe(VALID_MODEL);
    assertNoSecretLeak(result);
  });

  it("N1: thinking_delta events are ignored in accumulated text", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          {
            event: "message_start",
            data: { type: "message_start", message: { usage: { input_tokens: 1 } } },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "scratchpad" },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "visible" },
            },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            },
          },
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.content[0]?.text).toBe("visible");
  });

  it("N2: input_json_delta events are ignored in accumulated text", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          {
            event: "message_start",
            data: { type: "message_start", message: { usage: { input_tokens: 1 } } },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"x":1}' },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "ok" },
            },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            },
          },
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.content[0]?.text).toBe("ok");
  });
});

// =========================================================================
// F: Usage capture
// =========================================================================

describe("anthropic messages — usage capture", () => {
  it("P1: combines input_tokens (message_start) + output_tokens (message_delta)", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          {
            event: "message_start",
            data: { type: "message_start", message: { usage: { input_tokens: 7 } } },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "x" },
            },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 5 },
            },
          },
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
    });
  });

  it("P2: total_tokens = prompt + completion when both present", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          {
            event: "message_start",
            data: { type: "message_start", message: { usage: { input_tokens: 10 } } },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "x" },
            },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 20 },
            },
          },
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.usage?.total_tokens).toBe(30);
  });
});

// =========================================================================
// G: finish_reason mapping
// =========================================================================

describe("anthropic messages — stop_reason → finish_reason mapping", () => {
  function streamWithStopReason(reason: string): Array<{ event: string; data: unknown }> {
    return [
      {
        event: "message_start",
        data: { type: "message_start", message: { usage: { input_tokens: 1 } } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: reason },
          usage: { output_tokens: 1 },
        },
      },
    ];
  }

  it("P1: end_turn → stop", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse(streamWithStopReason("end_turn"))));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.finish_reason).toBe("stop");
  });

  it("P2: max_tokens → length", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse(streamWithStopReason("max_tokens"))));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.finish_reason).toBe("length");
  });

  it("P3: stop_sequence → stop", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse(streamWithStopReason("stop_sequence"))));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.finish_reason).toBe("stop");
  });

  it("P4: tool_use → tool_calls", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse(streamWithStopReason("tool_use"))));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.finish_reason).toBe("tool_calls");
  });

  it("P5: refusal handled as isError content_policy", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse(streamWithStopReason("refusal"))));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("content_policy");
    expect(result.structuredContent.finish_reason).toBe("content_filter");
  });
});

// =========================================================================
// H: Error Mapping
// =========================================================================

describe("anthropic messages — error mapping", () => {
  it("D1: 401 → code 'auth'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: { message: "bad key" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("auth");
    assertNoSecretLeak(result);
  });

  it("D2: 429 with retry-after header → 'rate_limited' + retryAfter", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: {} }), {
            status: 429,
            headers: { "retry-after": "12", "content-type": "application/json" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.code).toBe("rate_limited");
    expect(result.structuredContent.retryAfter).toBe(12);
  });

  it("D3: 400 invalid_request_error with 'context' in message → context_length", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "context too long for model" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.code).toBe("context_length");
  });

  it("D4: 500 → upstream_error", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: {} }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.code).toBe("upstream_error");
  });

  it("D5: 529 overloaded_error → upstream_error", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), {
            status: 529,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.code).toBe("upstream_error");
  });

  it("D6: network error → upstream_error", async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.error()));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
  });
});

// =========================================================================
// I: Cancellation
// =========================================================================

describe("anthropic messages — cancellation", () => {
  it("D1: abort mid-stream → isError upstream_error, no thrown error", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(
                  enc.encode(
                    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`,
                  ),
                );
                controller.enqueue(
                  enc.encode(
                    `event: content_block_delta\ndata: ${JSON.stringify({
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "text_delta", text: "partial" },
                    })}\n\n`,
                  ),
                );
                // intentionally never closes
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const { handler } = makeHandler();
    const ac = new AbortController();
    const promise = handler({ messages: VALID_MESSAGES }, { signal: ac.signal });
    await Promise.resolve();
    ac.abort();
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
  });
});

// =========================================================================
// J: Multi-registration
// =========================================================================

describe("anthropic messages — multi-registration closure isolation", () => {
  it("P1: two handlers with different names + apiKeys route to distinct upstreams", async () => {
    let authA: string | null = null;
    let authB: string | null = null;
    server.use(
      http.post("https://a.example.com/v1/messages", ({ request }) => {
        authA = request.headers.get("x-api-key");
        return sseResponse(defaultOkStream("from-a"));
      }),
      http.post("https://b.example.com/v1/messages", ({ request }) => {
        authB = request.headers.get("x-api-key");
        return sseResponse(defaultOkStream("from-b"));
      }),
    );
    const a = makeAnthropicMessagesHandler({
      name: "messages-a",
      apiKey: "key-a",
      baseURL: "https://a.example.com",
      model: VALID_MODEL,
    });
    const b = makeAnthropicMessagesHandler({
      name: "messages-b",
      apiKey: "key-b",
      baseURL: "https://b.example.com",
      model: VALID_MODEL,
    });
    const ra = await a.handler({ messages: VALID_MESSAGES });
    const rb = await b.handler({ messages: VALID_MESSAGES });
    expect(ra.content[0]?.text).toBe("from-a");
    expect(rb.content[0]?.text).toBe("from-b");
    expect(authA).toBe("key-a");
    expect(authB).toBe("key-b");
  });
});

// =========================================================================
// K: Bundle surface
// =========================================================================

describe("anthropic messages — handler bundle surface", () => {
  it("P1: bundle exposes name, description, schema, handler", () => {
    const bundle = makeHandler();
    expect(bundle.name).toBe("messages");
    expect(typeof bundle.description).toBe("string");
    expect(bundle.description).toContain("model: ");
    expect(bundle.description).toContain("max_tokens: 1024");
    expect(typeof bundle.handler).toBe("function");
  });

  it("P2: explicit name overrides default", () => {
    const bundle = makeHandler({ name: "claude_messages" });
    expect(bundle.name).toBe("claude_messages");
  });

  it("D1: throws when config.model is missing", () => {
    // @ts-expect-error intentional missing required field
    expect(() => makeAnthropicMessagesHandler({ apiKey: TEST_API_KEY })).toThrow(/model/i);
  });
});
