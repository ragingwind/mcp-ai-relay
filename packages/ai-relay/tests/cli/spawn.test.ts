import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultSseBody, type MockOpenAI, startMockOpenAI } from "./mock-openai.js";
import { ensureBuilt, runCli } from "./spawn-harness.js";

let mock: MockOpenAI;

beforeAll(async () => {
  await ensureBuilt();
  mock = await startMockOpenAI();
}, 180_000);

afterAll(async () => {
  if (mock) await mock.close();
});

beforeEach(() => {
  mock.requests.length = 0;
  mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));
});

function happyEnv(): Record<string, string> {
  return { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL };
}

describe("A: Positive — Happy Path Scenarios", () => {
  it("H-1: positional plain text against mocked upstream → exit 0", async () => {
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("hello world") }));
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "ping"],
      env: happyEnv(),
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toBe("hello world");
    expect(out.structuredContent.model).toBe("gpt-4o-mini");
  });

  it("H-2: stdin JSON → exit 0 + result on stdout", async () => {
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("hi back") }));
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini"],
      env: happyEnv(),
      input: '{"messages":[{"role":"user","content":"hi"}]}',
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(false);
    expect(Array.isArray(out.content)).toBe(true);
    expect(typeof out.content[0].text).toBe("string");
  });

  it("H-3: positional plain text desugared into messages[role=user]", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: happyEnv(),
    });
    expect(r.status).toBe(0);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body).toMatchObject({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("H-4: --name flag is NOT supported → exit 2", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "--name", "foo", "hi"],
      env: happyEnv(),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown flag: --name/);
  });

  it("H-5: --description flag is NOT supported → exit 2", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "--description", "x", "hi"],
      env: happyEnv(),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown flag: --description/);
  });
});

describe("C: Negative — Error / Exit Codes", () => {
  it("E-1: upstream 401 → exit 1 + isError + code 'auth'", async () => {
    mock.setResponse(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: "no auth" } }),
    }));
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: happyEnv(),
    });
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("auth");
  });

  it("E-2: upstream 429 → exit 1 + code 'rate_limited'", async () => {
    mock.setResponse(() => ({
      status: 429,
      body: JSON.stringify({ error: { message: "slow down" } }),
    }));
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: happyEnv(),
    });
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("rate_limited");
  });

  it("E-3: upstream 500 → exit 1 + code 'upstream_error'", async () => {
    mock.setResponse(() => ({
      status: 500,
      body: JSON.stringify({ error: { message: "boom" } }),
    }));
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: happyEnv(),
    });
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("upstream_error");
  });

  it("E-4: --timeout exceeded → exit 1 + code 'upstream_error'", async () => {
    mock.setResponse(() => ({ status: 200, body: "", hang: true }));
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "--timeout", "200", "hi"],
      env: happyEnv(),
      timeoutMs: 5_000,
    });
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("upstream_error");
  });

  it("E-5: connection refused → exit 1 + isError + code 'upstream_error'", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: "http://127.0.0.1:1/v1" },
      timeoutMs: 10_000,
    });
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("upstream_error");
  });

  it("E-6: invalid JSON on stdin (leading '{') → exit 2 + 'not valid JSON' on stderr", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini"],
      env: happyEnv(),
      input: "{not-valid-json",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not valid JSON");
  });

  it("E-7: messages is not an array → exit 1 + ZodError on stderr", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini"],
      env: happyEnv(),
      input: '{"messages":"not-an-array"}',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ZodError|Invalid input|messages/i);
  });
});

describe("B: Argv / Env handling", () => {
  it("A-1: no args → exit 2 + usage on stderr", async () => {
    const r = await runCli({ args: [], env: {} });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage:|--model|provider/i);
  });

  it("A-2: unknown provider/tool → exit 2", async () => {
    const r = await runCli({
      args: ["nope", "gpt-4o-mini", "hi"],
      env: happyEnv(),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown tool: nope");
  });

  it("A-3: openai chat without AI_RELAY_API_KEY → exit 2 mentioning apiKey", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: {},
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("apiKey");
  });

  it("A-4: --help → exit 0 + 'Usage: ai-relay' on stdout + no upstream call", async () => {
    const before = mock.requests.length;
    const r = await runCli({ args: ["--help"], env: {} });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: ai-relay");
    expect(mock.requests.length).toBe(before);
  });

  it("A-5: --version → exit 0 + semver on stdout", async () => {
    const r = await runCli({ args: ["--version"], env: {} });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("A-6: env-only happy path (no flags besides -m) → exit 0", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: happyEnv(),
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(false);
  });
});

describe("D: Resilience / Lifecycle", () => {
  it("R-1: closed stdin + no positional → exit 2 within 1 s", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini"],
      env: happyEnv(),
      timeoutMs: 1_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/empty stdin|requires input/);
    expect(r.durationMs).toBeLessThan(1_000);
  });

  it("R-2: SIGTERM during slow upstream → child exits within 2 s", async () => {
    mock.setResponse(() => ({ status: 200, body: "", hang: true }));
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: happyEnv(),
      killAfterMs: 200,
      killSignal: "SIGTERM",
      timeoutMs: 5_000,
    });
    const terminated = r.signal === "SIGTERM" || (r.status !== null && r.status !== 0);
    expect(terminated).toBe(true);
    expect(r.durationMs).toBeLessThan(3_000);
  });

  it("R-3: SIGINT during slow upstream → child exits within 2 s", async () => {
    mock.setResponse(() => ({ status: 200, body: "", hang: true }));
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: happyEnv(),
      killAfterMs: 200,
      killSignal: "SIGINT",
      timeoutMs: 5_000,
    });
    const terminated = r.signal === "SIGINT" || (r.status !== null && r.status !== 0);
    expect(terminated).toBe(true);
    expect(r.durationMs).toBeLessThan(3_000);
  });

  it("R-4: stdout is JSON-only, stderr is not JSON", async () => {
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: happyEnv(),
    });
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    if (r.stderr.trim().length > 0) {
      expect(() => JSON.parse(r.stderr.trim())).toThrow();
    }
  });

  it("R-5: ~64 KB JSON input via chunked stdin → upstream receives full content", async () => {
    const big = "x".repeat(64 * 1024);
    const payload = JSON.stringify({ messages: [{ role: "user", content: big }] });
    let seenLen = 0;
    mock.setResponse((req) => {
      const messages = (req.body as { messages?: Array<{ content?: string }> }).messages;
      seenLen = messages?.[0]?.content?.length ?? 0;
      return { status: 200, body: defaultSseBody("ok") };
    });
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini"],
      env: happyEnv(),
      inputStream: async (stdin) => {
        const chunkSize = 8 * 1024;
        for (let i = 0; i < payload.length; i += chunkSize) {
          const chunk = payload.slice(i, i + chunkSize);
          await new Promise<void>((resolveWrite, rejectWrite) => {
            stdin.write(chunk, (err) => (err ? rejectWrite(err) : resolveWrite()));
          });
        }
      },
      timeoutMs: 15_000,
    });
    expect(r.status).toBe(0);
    expect(seenLen).toBe(big.length);
  });

  it("R-6a: failing --env path does not echo AI_RELAY_API_KEY", async () => {
    const canary = "leak-canary-XYZ";
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "--env", "/no/such.env", "hi"],
      env: { AI_RELAY_API_KEY: canary, AI_RELAY_BASE_URL: mock.baseURL },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain(canary);
    expect(r.stderr).not.toContain(canary);
  });

  it("R-6b: happy path does not echo AI_RELAY_API_KEY on stderr", async () => {
    const canary = "leak-canary-HAPPY";
    const r = await runCli({
      args: ["chat-completions", "gpt-4o-mini", "hi"],
      env: { AI_RELAY_API_KEY: canary, AI_RELAY_BASE_URL: mock.baseURL },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(canary);
  });
});
