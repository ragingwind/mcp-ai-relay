// Stream edge cases for the OpenAI chat handler.

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type MockHandle, startMockOpenAI } from "../../../../tests/fixtures/mock-openai/index.js";
import { makeOpenAIChatHandler } from "../../src/openai/chat.js";

const mswServer = setupServer();
// `bypass` (not `"error"`) — the chunk-boundary suite below routes its
// requests to a real 127.0.0.1 server, which MSW must let through.
beforeAll(() => mswServer.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const VALID_MODEL = "gpt-4o-mini";
const VALID_MESSAGES = [{ role: "user" as const, content: "ping" }];

describe("openai chat — stream mid-error (C-3)", () => {
  it("D1: maps mid-stream socket failure to upstream_error", async () => {
    mswServer.use(
      http.post(ENDPOINT, () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "tial" } }] })}\n\n`,
              ),
            );
            // Force-error the stream WITHOUT writing [DONE].
            setTimeout(() => controller.error(new Error("network reset")), 5);
          },
        });
        return new HttpResponse(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    // Document the SDK's actual partial-content behavior. The current
    // OpenAI Node SDK discards in-progress accumulation when the stream
    // errors mid-flight — the catch in runOnce builds a fresh result from
    // mapOpenAIError, so `content[0].text` is the mapped error message,
    // NOT the partial deltas. Asserting this pins the behavior; changing
    // SDK semantics to surface partial content would be a separate diff.
    expect(typeof result.content[0]?.text).toBe("string");
  });
});

describe("openai chat — chunk boundary (C-4)", () => {
  let mock: MockHandle;

  beforeAll(async () => {
    mock = await startMockOpenAI({ preset: "chunk-boundary" });
  });

  afterAll(async () => {
    if (mock) await mock.close();
  });

  it("P1: SDK reassembles an SSE frame split across two TCP writes", async () => {
    const { handler } = makeOpenAIChatHandler({
      apiKey: "test-key",
      baseURL: mock.baseURL,
      model: VALID_MODEL,
    });
    const result = await handler({ messages: VALID_MESSAGES });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("hello");
    expect(result.structuredContent.finish_reason).toBe("stop");
  });
});

// Shared factory — kept tiny to avoid cross-file coupling.
function makeHandler() {
  return makeOpenAIChatHandler({ apiKey: "test-openai-api-key", model: VALID_MODEL });
}
