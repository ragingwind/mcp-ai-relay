// AsyncLocalStorage scope isolation across concurrent registrations.
//
// `multi-registration.test.ts` proves closure isolation (each handler holds
// its own apiKey + baseURL). This file proves the request-scope (ALS)
// captured upstream-error body cannot leak across handlers when they run
// concurrently.
//
// Setup: three registrations, each with a distinct apiKey. Each MSW handler
// echoes the matching apiKey verbatim in a 5xx body. The createOpenAIClient
// fetch-capture stores the body in `requestScope.getStore().upstreamBody`
// after redacting the configured apiKey. The captured body is then surfaced
// by `mapOpenAIError` into the result text. Because the redaction is keyed
// on each handler's own apiKey, handler A's result must contain "[REDACTED]"
// (its own key removed) but NOT a verbatim copy of B's or C's apiKey.

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOpenAIChatHandler } from "../../src/openai/chat.js";

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

const VALID_MODEL = "gpt-4o-mini";
const VALID_MESSAGES = [{ role: "user" as const, content: "ping" }];

describe("ALS scope isolation across concurrent handlers", () => {
  it("D1: each handler's captured upstreamBody is scoped to its own AsyncLocalStorage", async () => {
    const keyA = "sk-tenant-AAA-xxxxxxxxxxxxxxxxxxxx";
    const keyB = "sk-tenant-BBB-yyyyyyyyyyyyyyyyyyyy";
    const keyC = "sk-tenant-CCC-zzzzzzzzzzzzzzzzzzzz";

    // Each MSW handler responds with a 5xx body containing the apiKey it
    // received via Authorization. Routing by base URL keeps each handler
    // hitting only its own MSW intercept.
    function makeHandlerFor(url: string, apiKey: string) {
      return http.post(url, async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        // Body echoes the bearer (which equals the handler's apiKey) and
        // forces a real upstream-style stall before responding so the
        // handlers' fetches genuinely overlap.
        await new Promise((r) => setTimeout(r, 25));
        return new HttpResponse(
          JSON.stringify({ error: { message: `tenant ${auth} blew up; key=${apiKey}` } }),
          { status: 500 },
        );
      });
    }

    mswServer.use(
      makeHandlerFor("https://a.example.com/v1/chat/completions", keyA),
      makeHandlerFor("https://b.example.com/v1/chat/completions", keyB),
      makeHandlerFor("https://c.example.com/v1/chat/completions", keyC),
    );

    const a = makeOpenAIChatHandler({
      apiKey: keyA,
      baseURL: "https://a.example.com/v1",
    });
    const b = makeOpenAIChatHandler({
      apiKey: keyB,
      baseURL: "https://b.example.com/v1",
    });
    const c = makeOpenAIChatHandler({
      apiKey: keyC,
      baseURL: "https://c.example.com/v1",
    });

    const [ra, rb, rc] = await Promise.all([
      a.handler({ model: VALID_MODEL, messages: VALID_MESSAGES }),
      b.handler({ model: VALID_MODEL, messages: VALID_MESSAGES }),
      c.handler({ model: VALID_MODEL, messages: VALID_MESSAGES }),
    ]);

    expect(ra.isError).toBe(true);
    expect(rb.isError).toBe(true);
    expect(rc.isError).toBe(true);
    expect(ra.structuredContent.code).toBe("upstream_error");
    expect(rb.structuredContent.code).toBe("upstream_error");
    expect(rc.structuredContent.code).toBe("upstream_error");

    const txtA = ra.content[0]?.text ?? "";
    const txtB = rb.content[0]?.text ?? "";
    const txtC = rc.content[0]?.text ?? "";

    // Each result must contain its own redaction marker (proves the body
    // was captured under this handler's scope and redaction ran with this
    // handler's apiKey).
    expect(txtA).toContain("[REDACTED]");
    expect(txtB).toContain("[REDACTED]");
    expect(txtC).toContain("[REDACTED]");

    // Cross-tenant leakage check — no result text contains another
    // tenant's apiKey verbatim.
    expect(txtA).not.toContain(keyB);
    expect(txtA).not.toContain(keyC);
    expect(txtB).not.toContain(keyA);
    expect(txtB).not.toContain(keyC);
    expect(txtC).not.toContain(keyA);
    expect(txtC).not.toContain(keyB);

    // And the result texts must each have redacted exactly the configured key.
    expect(txtA).not.toContain(keyA);
    expect(txtB).not.toContain(keyB);
    expect(txtC).not.toContain(keyC);
  });
});
