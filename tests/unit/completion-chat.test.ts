// Unit tests for `lib/openai/chat.ts` — the framework-agnostic registrar.
//
// Tests target `makeOpenAIChatHandler(config)` directly: the same factory
// `registerOpenAIChat` calls internally. Each test creates its own handler
// so there is no module-level shared state to reset.
//
// Test infrastructure:
//   • MSW (`setupServer`) intercepts POST https://api.openai.com/v1/chat/completions
//     so the openai SDK code path is exercised end-to-end without a real
//     network request. The SDK module itself is NEVER mocked.
//   • SSE responses are emitted as `text/event-stream` ReadableStreams so the
//     SDK's async-iterator path runs exactly as it would against OpenAI proper.
//   • MSW listens BEFORE any handler is constructed (via `setupServer().listen()`
//     in `beforeAll`). The OpenAI SDK captures `globalThis.fetch` at
//     constructor time, so MSW's patch must already be installed when each
//     handler factory runs.
//
// Secret-leakage guard: `assertNoSecretLeak(result)` asserts neither the
// configured API key nor a known relay token sentinel appears in the
// returned object.

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeOpenAIChatHandler,
  type OpenAIChatConfig,
  type OpenAIChatHandlerBundle,
  type OpenAIChatResult,
} from "../../lib/openai/chat.js";

// --- shared MSW server lifecycle -----------------------------------------

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// --- helpers --------------------------------------------------------------

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

const TEST_API_KEY = "test-openai-api-key";
const TEST_RELAY_TOKEN_SENTINEL = "x".repeat(32); // not actually flowed through chat.ts; used as a leak canary

const VALID_MODEL = "gpt-4o-mini";
const VALID_MESSAGES = [{ role: "user" as const, content: "say hi" }];

function makeHandler(overrides: Partial<OpenAIChatConfig> = {}): OpenAIChatHandlerBundle {
  return makeOpenAIChatHandler({ apiKey: TEST_API_KEY, ...overrides });
}

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

function sseResponse(chunks: string[]) {
  return new HttpResponse(sseStream(chunks), {
    headers: { "content-type": "text/event-stream" },
  });
}

function assertNoSecretLeak(result: OpenAIChatResult | unknown): void {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(TEST_API_KEY);
  expect(serialized).not.toContain(TEST_RELAY_TOKEN_SENTINEL);
}

// =========================================================================
// A: Input Validation
// =========================================================================

describe("openai chat — input validation (.strict, types, ranges)", () => {
  it("D1: rejects when `model` is missing", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: VALID_MESSAGES })).rejects.toThrow();
  });

  it("D2: rejects when `messages` is missing", async () => {
    const { handler } = makeHandler();
    await expect(handler({ model: VALID_MODEL })).rejects.toThrow();
  });

  it("D3: rejects when `messages` is empty", async () => {
    const { handler } = makeHandler();
    await expect(handler({ model: VALID_MODEL, messages: [] })).rejects.toThrow();
  });

  it("D4: rejects `temperature` above 2", async () => {
    const { handler } = makeHandler();
    await expect(
      handler({ model: VALID_MODEL, messages: VALID_MESSAGES, temperature: 3 }),
    ).rejects.toThrow();
  });

  it("D5: rejects `top_p` above 1", async () => {
    const { handler } = makeHandler();
    await expect(
      handler({ model: VALID_MODEL, messages: VALID_MESSAGES, top_p: 2 }),
    ).rejects.toThrow();
  });

  it("D6: rejects unknown extra keys (strict schema)", async () => {
    const { handler } = makeHandler();
    await expect(
      handler({ model: VALID_MODEL, messages: VALID_MESSAGES, unknownKey: "x" }),
    ).rejects.toThrow();
  });
});

// =========================================================================
// B: max_tokens clamp
// =========================================================================

describe("openai chat — max_tokens clamp", () => {
  it("P1: passes max_tokens unchanged when ≤ ceiling", async () => {
    let observedMaxTokens: number | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { max_tokens?: number };
        observedMaxTokens = body.max_tokens;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler();
    await handler({ model: VALID_MODEL, messages: VALID_MESSAGES, max_tokens: 100 });
    expect(observedMaxTokens).toBe(100);
  });

  it("N1: silently clamps max_tokens to default ceiling (4096) when over", async () => {
    let observedMaxTokens: number | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { max_tokens?: number };
        observedMaxTokens = body.max_tokens;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler();
    const result = await handler({
      model: VALID_MODEL,
      messages: VALID_MESSAGES,
      max_tokens: 999_999,
    });
    expect(result.isError).toBe(false);
    expect(observedMaxTokens).toBe(4096);
  });

  it("N2: respects an injected ceiling override", async () => {
    let observedMaxTokens: number | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { max_tokens?: number };
        observedMaxTokens = body.max_tokens;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler({ maxOutputTokensCeiling: 100 });
    await handler({ model: VALID_MODEL, messages: VALID_MESSAGES, max_tokens: 999 });
    expect(observedMaxTokens).toBe(100);
  });
});

// =========================================================================
// C: Streaming
// =========================================================================

describe("openai chat — streaming accumulation, usage, finish_reason, tool_calls, maxRetries", () => {
  it("P1: accumulates delta.content across chunks and captures usage + finish_reason", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
          JSON.stringify({ choices: [{ delta: { content: " " } }] }),
          JSON.stringify({
            choices: [{ delta: { content: "world" }, finish_reason: "stop" }],
          }),
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Hello world");
    expect(result.structuredContent.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    });
    expect(result.structuredContent.finish_reason).toBe("stop");
    expect(result.structuredContent.model).toBe(VALID_MODEL);
    assertNoSecretLeak(result);
  });

  it("N1: surfaces finish_reason 'tool_calls' without serializing tool calls", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup" } }] } }],
          }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("");
    expect(result.structuredContent.finish_reason).toBe("tool_calls");
    assertNoSecretLeak(result);
  });

  it("D1: streaming call performs exactly one upstream request on 5xx (maxRetries: 0)", async () => {
    let callCount = 0;
    server.use(
      http.post(ENDPOINT, () => {
        callCount++;
        return new HttpResponse("upstream blew up", { status: 500 });
      }),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    expect(callCount).toBe(1);
    assertNoSecretLeak(result);
  });
});

// =========================================================================
// D: Abort Propagation
// =========================================================================

describe("openai chat — abort propagation", () => {
  it("D1: short-circuits when extra.signal is already aborted", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }),
        ]),
      ),
    );
    const { handler } = makeHandler();
    const ac = new AbortController();
    ac.abort();
    const result = await handler(
      { model: VALID_MODEL, messages: VALID_MESSAGES },
      { signal: ac.signal },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    assertNoSecretLeak(result);
  });

  it("D2: aborts mid-stream when extra.signal is aborted after start", async () => {
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
                    `data: ${JSON.stringify({
                      choices: [{ delta: { content: "partial" } }],
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
    const promise = handler(
      { model: VALID_MODEL, messages: VALID_MESSAGES },
      { signal: ac.signal },
    );
    await Promise.resolve();
    ac.abort();
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    assertNoSecretLeak(result);
  });
});

// =========================================================================
// E: Error Mapping + Secret Guard
// =========================================================================

describe("openai chat — error mapping (auth, rate_limited, context_length, content_policy, upstream_error, bad_request)", () => {
  it("D1: maps upstream 401 to code: 'auth'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () => new HttpResponse(JSON.stringify({ error: { message: "no key" } }), { status: 401 }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("auth");
    expect(result.content[0]?.text).toBe("Authentication failed");
    assertNoSecretLeak(result);
  });

  it("D2: maps upstream 403 to code: 'auth'", async () => {
    server.use(
      http.post(ENDPOINT, () => new HttpResponse(JSON.stringify({ error: {} }), { status: 403 })),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("auth");
    assertNoSecretLeak(result);
  });

  it("D3: maps upstream 429 to code: 'rate_limited' with retryAfter from header", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: { message: "slow down" } }), {
            status: 429,
            headers: { "retry-after": "30" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("rate_limited");
    expect(result.structuredContent.retryAfter).toBe(30);
    assertNoSecretLeak(result);
  });

  it("N1: 429 without retry-after omits retryAfter from structuredContent", async () => {
    server.use(
      http.post(ENDPOINT, () => new HttpResponse(JSON.stringify({ error: {} }), { status: 429 })),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("rate_limited");
    expect(result.structuredContent.retryAfter).toBeUndefined();
    expect("retryAfter" in result.structuredContent).toBe(false);
    assertNoSecretLeak(result);
  });

  it("D4: maps 400 context_length_exceeded to code: 'context_length'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(
            JSON.stringify({
              error: { code: "context_length_exceeded", message: "you sent too many tokens" },
            }),
            { status: 400 },
          ),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("context_length");
    assertNoSecretLeak(result);
  });

  it("D5: maps 400 content_filter to code: 'content_policy'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(
            JSON.stringify({ error: { code: "content_filter", message: "blocked by safety" } }),
            { status: 400 },
          ),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("content_policy");
    assertNoSecretLeak(result);
  });

  it("D6: maps 500 to code: 'upstream_error'", async () => {
    server.use(
      http.post(ENDPOINT, () => new HttpResponse(JSON.stringify({ error: {} }), { status: 500 })),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    assertNoSecretLeak(result);
  });

  it("D6b: forwards upstream 5xx body into result text", async () => {
    const body = '{"detail":"query rejected: out of domain"}';
    server.use(http.post(ENDPOINT, () => new HttpResponse(body, { status: 500 })));
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    expect(result.content[0]?.text).toContain("query rejected: out of domain");
    assertNoSecretLeak(result);
  });

  it("D6c: redacts the configured API key in forwarded 5xx body", async () => {
    const body = JSON.stringify({ detail: `leak ${TEST_API_KEY} end` });
    server.use(http.post(ENDPOINT, () => new HttpResponse(body, { status: 500 })));
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    expect(result.content[0]?.text).toContain("[REDACTED]");
    assertNoSecretLeak(result);
  });

  it("D7: maps a fetch-level network failure to code: 'upstream_error'", async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.error()));
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    assertNoSecretLeak(result);
  });

  it("D8: maps an unrecognized 4xx (422) to code: 'bad_request'", async () => {
    server.use(
      http.post(ENDPOINT, () => new HttpResponse(JSON.stringify({ error: {} }), { status: 422 })),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("bad_request");
    assertNoSecretLeak(result);
  });

  it("D9: maps a generic 400 (no special code) to code: 'bad_request'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () => new HttpResponse(JSON.stringify({ error: { message: "nope" } }), { status: 400 }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("bad_request");
    assertNoSecretLeak(result);
  });

  it("D10: no error result echoes the configured API key", async () => {
    const errorScenarios: Array<() => HttpResponse<string>> = [
      () =>
        new HttpResponse(JSON.stringify({ error: { message: TEST_API_KEY } }), {
          status: 401,
        }),
      () =>
        new HttpResponse(JSON.stringify({ error: { message: TEST_API_KEY } }), {
          status: 500,
        }),
      () =>
        new HttpResponse(
          JSON.stringify({
            error: { code: "context_length_exceeded", message: TEST_API_KEY },
          }),
          { status: 400 },
        ),
    ];
    const { handler } = makeHandler();
    for (const responseFactory of errorScenarios) {
      server.resetHandlers();
      server.use(http.post(ENDPOINT, () => responseFactory()));
      const result = await handler({ model: VALID_MODEL, messages: VALID_MESSAGES });
      expect(result.isError).toBe(true);
      assertNoSecretLeak(result);
    }
  });
});

// =========================================================================
// F: Bundle surface
// =========================================================================

describe("openai chat — handler bundle surface", () => {
  it("P1: bundle exposes name, description, schema, handler", () => {
    const bundle = makeHandler();
    expect(bundle.name).toBe("completion_chat");
    expect(typeof bundle.description).toBe("string");
    expect(bundle.description.length).toBeGreaterThan(0);
    const parsed = bundle.schema.safeParse({ model: VALID_MODEL, messages: VALID_MESSAGES });
    expect(parsed.success).toBe(true);
    expect(typeof bundle.handler).toBe("function");
  });

  it("P2: name and description are overridable per registration", () => {
    const bundle = makeHandler({ name: "azure_chat", description: "Azure deployment" });
    expect(bundle.name).toBe("azure_chat");
    expect(bundle.description).toBe("Azure deployment");
  });
});
