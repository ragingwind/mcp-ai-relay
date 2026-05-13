// Unit tests for `lib/openai/chat.ts` — the framework-agnostic registrar.
//
// Tests target `makeOpenAIChatHandler(config)` directly: the same factory
// `registerOpenAIChat` calls internally. Each test creates its own handler
// so there is no module-level shared state to reset.
//
// As of v0.10.0, the caller-facing tool inputSchema accepts only
// `{ messages }`. Model and sampling fields (model / temperature /
// max_tokens / top_p / stop) live on the server config and are injected
// into every upstream call. Sampling fields baked into the server config
// are advertised in the tool description.

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeOpenAIChatHandler,
  type OpenAIChatConfig,
  type OpenAIChatHandlerBundle,
  type OpenAIChatResult,
} from "../../src/openai/chat.js";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

const TEST_API_KEY = "test-openai-api-key";
const TEST_RELAY_TOKEN_SENTINEL = "x".repeat(32);

const VALID_MODEL = "gpt-4o-mini";
const VALID_MESSAGES = [{ role: "user" as const, content: "say hi" }];

function makeHandler(overrides: Partial<OpenAIChatConfig> = {}): OpenAIChatHandlerBundle {
  return makeOpenAIChatHandler({
    apiKey: TEST_API_KEY,
    model: VALID_MODEL,
    ...overrides,
  });
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
// A: Input Validation — caller schema is { messages } only
// =========================================================================

describe("openai chat — input validation (caller schema = messages only)", () => {
  it("P1: accepts a minimal { messages } input", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
  });

  it("D1: rejects when `messages` is missing", async () => {
    const { handler } = makeHandler();
    await expect(handler({})).rejects.toThrow();
  });

  it("D2: rejects when `messages` is empty", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: [] })).rejects.toThrow();
  });

  it("D3: rejects caller-supplied `model` (strict schema)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ model: "override", messages: VALID_MESSAGES })).rejects.toThrow();
  });

  it("D4: rejects caller-supplied `temperature` (strict schema)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: VALID_MESSAGES, temperature: 0.5 })).rejects.toThrow();
  });

  it("D5: rejects caller-supplied `max_tokens` (strict schema)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: VALID_MESSAGES, max_tokens: 100 })).rejects.toThrow();
  });

  it("D6: rejects caller-supplied `top_p` (strict schema)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: VALID_MESSAGES, top_p: 0.9 })).rejects.toThrow();
  });

  it("D7: rejects caller-supplied `stop` (strict schema)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: VALID_MESSAGES, stop: "END" })).rejects.toThrow();
  });

  it("D8: rejects unknown extra keys", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: VALID_MESSAGES, unknown: "x" })).rejects.toThrow();
  });
});

// =========================================================================
// B: Config-driven upstream parameters
// =========================================================================

describe("openai chat — server config drives upstream call", () => {
  it("P1: config.model is forwarded as the upstream model", async () => {
    let observedModel: string | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { model?: string };
        observedModel = body.model;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler({ model: "config-model-id" });
    await handler({ messages: VALID_MESSAGES });
    expect(observedModel).toBe("config-model-id");
  });

  it("P2: config.temperature is forwarded when set", async () => {
    let body: { temperature?: number } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler({ temperature: 0.7 });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.temperature).toBe(0.7);
  });

  it("N1: temperature is omitted from upstream call when unset", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    expect(body).toBeDefined();
    expect("temperature" in (body ?? {})).toBe(false);
  });

  it("P3: config.max_tokens is forwarded as max_tokens", async () => {
    let body: { max_tokens?: number } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler({ max_tokens: 256 });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.max_tokens).toBe(256);
  });

  it("N2: max_tokens is omitted from upstream call when unset", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    expect("max_tokens" in (body ?? {})).toBe(false);
  });

  it("P4: config.top_p is forwarded when set", async () => {
    let body: { top_p?: number } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler({ top_p: 0.9 });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.top_p).toBe(0.9);
  });

  it("P5: config.stop (string) is forwarded as upstream stop", async () => {
    let body: { stop?: unknown } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler({ stop: "END" });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.stop).toBe("END");
  });

  it("P6: config.stop (array) is forwarded as upstream stop", async () => {
    let body: { stop?: unknown } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler({ stop: ["END", "STOP"] });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.stop).toEqual(["END", "STOP"]);
  });

  it("D9: makeOpenAIChatHandler throws when config.model is missing", () => {
    // @ts-expect-error - intentional missing required field
    expect(() => makeOpenAIChatHandler({ apiKey: TEST_API_KEY })).toThrow(/model/i);
  });

  it("D10: makeOpenAIChatHandler throws when config.model is empty string", () => {
    expect(() => makeOpenAIChatHandler({ apiKey: TEST_API_KEY, model: "" })).toThrow(/model/i);
  });
});

// =========================================================================
// C: Streaming
// =========================================================================

describe("openai chat — streaming accumulation, usage, finish_reason, maxRetries", () => {
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
    const result = await handler({ messages: VALID_MESSAGES });
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
    const result = await handler({ messages: VALID_MESSAGES });
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
    const result = await handler({ messages: VALID_MESSAGES });
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
    const result = await handler({ messages: VALID_MESSAGES }, { signal: ac.signal });
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
    const promise = handler({ messages: VALID_MESSAGES }, { signal: ac.signal });
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

describe("openai chat — error mapping", () => {
  it("D1: maps upstream 401 to code: 'auth'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () => new HttpResponse(JSON.stringify({ error: { message: "no key" } }), { status: 401 }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
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
    const result = await handler({ messages: VALID_MESSAGES });
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
    const result = await handler({ messages: VALID_MESSAGES });
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
    const result = await handler({ messages: VALID_MESSAGES });
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
    const result = await handler({ messages: VALID_MESSAGES });
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
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("content_policy");
    assertNoSecretLeak(result);
  });

  it("D6: maps 500 to code: 'upstream_error'", async () => {
    server.use(
      http.post(ENDPOINT, () => new HttpResponse(JSON.stringify({ error: {} }), { status: 500 })),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    assertNoSecretLeak(result);
  });

  it("D6b: forwards upstream 5xx body into result text", async () => {
    const body = '{"detail":"query rejected: out of domain"}';
    server.use(http.post(ENDPOINT, () => new HttpResponse(body, { status: 500 })));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    expect(result.content[0]?.text).toContain("query rejected: out of domain");
    assertNoSecretLeak(result);
  });

  it("D6c: redacts the configured API key in forwarded 5xx body", async () => {
    const body = JSON.stringify({ detail: `leak ${TEST_API_KEY} end` });
    server.use(http.post(ENDPOINT, () => new HttpResponse(body, { status: 500 })));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    expect(result.content[0]?.text).toContain("[REDACTED]");
    assertNoSecretLeak(result);
  });

  it("D7: maps a fetch-level network failure to code: 'upstream_error'", async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.error()));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    assertNoSecretLeak(result);
  });

  it("D8: maps an unrecognized 4xx (422) to code: 'bad_request'", async () => {
    server.use(
      http.post(ENDPOINT, () => new HttpResponse(JSON.stringify({ error: {} }), { status: 422 })),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
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
    const result = await handler({ messages: VALID_MESSAGES });
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
      const result = await handler({ messages: VALID_MESSAGES });
      expect(result.isError).toBe(true);
      assertNoSecretLeak(result);
    }
  });
});

// =========================================================================
// F: Bundle surface — description hint includes baked-in config values
// =========================================================================

describe("openai chat — handler bundle surface", () => {
  it("P1: bundle exposes name, description, schema, handler", () => {
    const bundle = makeHandler();
    expect(bundle.name).toBe("chat-completions");
    expect(typeof bundle.description).toBe("string");
    expect(bundle.description.length).toBeGreaterThan(0);
    const parsed = bundle.schema.safeParse({ messages: VALID_MESSAGES });
    expect(parsed.success).toBe(true);
    expect(typeof bundle.handler).toBe("function");
  });

  it("P2: default description advertises the configured model", () => {
    const bundle = makeHandler({ model: "gpt-4o" });
    expect(bundle.description).toContain("model: gpt-4o");
  });

  it("P3: default description advertises baked-in sampling fields", () => {
    const bundle = makeHandler({
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 256,
      top_p: 0.9,
      stop: ["END"],
    });
    expect(bundle.description).toContain("temperature: 0.2");
    expect(bundle.description).toContain("max_tokens: 256");
    expect(bundle.description).toContain("top_p: 0.9");
    expect(bundle.description).toContain("stop:");
  });

  it("P4: explicit `description` overrides the default", () => {
    const bundle = makeHandler({ description: "Custom description" });
    expect(bundle.description).toBe("Custom description");
  });

  it("P5: name is overridable per registration", () => {
    const bundle = makeHandler({ name: "azure_chat" });
    expect(bundle.name).toBe("azure_chat");
  });
});

// =========================================================================
// G: Timeout
// =========================================================================

describe("openai chat — requestTimeoutMs propagation", () => {
  it("D1: returns upstream_error within ~timeout when upstream stalls", async () => {
    server.use(
      http.post(ENDPOINT, async () => {
        await new Promise((r) => setTimeout(r, 500));
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "late" }, finish_reason: "stop" }] }),
        ]);
      }),
    );
    const { handler } = makeHandler({ requestTimeoutMs: 50 });
    const t0 = Date.now();
    const result = await handler({ messages: VALID_MESSAGES });
    const elapsed = Date.now() - t0;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    expect(elapsed).toBeLessThan(450);
    assertNoSecretLeak(result);
  });
});

// =========================================================================
// H: Verbose logger injection
// =========================================================================

describe("openai chat — verbose logger injection", () => {
  function makeLogger() {
    const lines: string[] = [];
    const stream = {
      write(chunk: string) {
        lines.push(chunk);
      },
    };
    return {
      lines,
      stream,
      logger: {
        enabled: true,
        log(stage: string, data: unknown) {
          const rendered = typeof data === "string" ? data : JSON.stringify(data, null, 2);
          lines.push(`[ai-relay] ${stage}: ${rendered}\n`);
        },
      },
    };
  }

  it("P1: openai-http-request emits redacted Authorization + full request body", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]),
      ),
    );
    const { lines, logger } = makeLogger();
    const { handler } = makeHandler({ logger });
    const userMarker = "verbose-injection-user-marker";
    await handler({
      messages: [{ role: "user", content: userMarker }],
    });
    const combined = lines.join("");
    expect(combined).toContain("openai-http-request");
    expect(combined).toMatch(/Bearer \*\*\*redacted\(\d+chars\)\*\*\*/);
    expect(combined).not.toContain(TEST_API_KEY);
    expect(combined).toContain(userMarker);
  });

  it("P2: openai-stream-start emits messages verbatim (role + content)", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]),
      ),
    );
    const { lines, logger } = makeLogger();
    const { handler } = makeHandler({ logger });
    const userMarker = "stream-start-user-marker-7777";
    await handler({
      messages: [{ role: "user", content: userMarker }],
    });
    const startLine = lines.find((l) => l.includes("openai-stream-start"));
    expect(startLine).toBeDefined();
    expect(startLine).toContain(userMarker);
    expect(startLine).toContain('"role"');
  });

  it("P3: openai-stream-end emits the full accumulated text", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "Hello " } }] }),
          JSON.stringify({
            choices: [{ delta: { content: "world" }, finish_reason: "stop" }],
          }),
        ]),
      ),
    );
    const { lines, logger } = makeLogger();
    const { handler } = makeHandler({ logger });
    await handler({ messages: VALID_MESSAGES });
    const endLine = lines.find((l) => l.includes("openai-stream-end"));
    expect(endLine).toBeDefined();
    expect(endLine).toContain("Hello world");
    expect(endLine).toContain("accumulatedText");
  });

  it("D1: openai-cancelled emitted when abort fires (pre-aborted signal)", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }),
        ]),
      ),
    );
    const { lines, logger } = makeLogger();
    const { handler } = makeHandler({ logger });
    const ac = new AbortController();
    ac.abort();
    await handler({ messages: VALID_MESSAGES }, { signal: ac.signal });
    expect(lines.some((l) => l.includes("openai-cancelled"))).toBe(true);
  });

  it("D2: secret API key sentinel never appears in any verbose line", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]),
      ),
    );
    const sentinel = "sk-supersecret-canary-12345";
    const { lines, logger } = makeLogger();
    const { handler } = makeHandler({ logger, apiKey: sentinel });
    await handler({ messages: VALID_MESSAGES });
    const combined = lines.join("");
    expect(combined).not.toContain(sentinel);
    expect(combined).not.toContain("supersecret");
  });
});
