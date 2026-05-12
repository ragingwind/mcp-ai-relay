import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunIO, run } from "../../src/bin/run.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let scratchDir: string;
beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "ai-relay-run-"));
});
afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

interface CapturedIO {
  io: RunIO;
  stdout: { value: string };
  stderr: { value: string };
}

function makeIO(
  opts: {
    stdin?: string;
    stdinIsTTY?: boolean;
    env?: Record<string, string | undefined>;
    isTTY?: boolean;
  } = {},
): CapturedIO {
  const stdoutBuf = { value: "" };
  const stderrBuf = { value: "" };
  let stdin: Readable;
  let stdinIsTTY: boolean;
  if (opts.stdin === undefined) {
    stdin = new Readable({
      read() {
        this.push(null);
      },
    });
    stdinIsTTY = opts.stdinIsTTY ?? true;
  } else {
    stdin = Readable.from([opts.stdin]);
    stdinIsTTY = opts.stdinIsTTY ?? false;
  }
  const io: RunIO = {
    stdin,
    stdinIsTTY,
    stdout: {
      write: (s) => {
        stdoutBuf.value += s;
      },
    },
    stderr: {
      write: (s) => {
        stderrBuf.value += s;
      },
    },
    env: opts.env ?? {},
    isTTY: opts.isTTY ?? false,
  };
  return { io, stdout: stdoutBuf, stderr: stderrBuf };
}

function sseChunks(chunks: string[]): ReadableStream<Uint8Array> {
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

function happyResponse(text = "ok") {
  return new HttpResponse(
    sseChunks([
      JSON.stringify({
        choices: [{ delta: { content: text }, finish_reason: "stop" }],
      }),
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("run — usage errors short-circuit", () => {
  it("D1: missing model positional → exit 2 + stderr usage message", async () => {
    const cap = makeIO();
    const code = await run(["chat-completions"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toMatch(/usage: ai-relay-cli/);
  });

  it("D2: unknown tool → exit 2", async () => {
    const cap = makeIO();
    const code = await run(["nope", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("unknown tool: nope");
  });

  it("D3: -h prints usage on stdout, exit 0", async () => {
    const cap = makeIO();
    const code = await run(["-h"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value).toContain("Usage: ai-relay-cli");
  });

  it("D4: -V prints version on stdout, exit 0", async () => {
    const cap = makeIO();
    const code = await run(["-V"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe("run — input handling", () => {
  it("D1: stdin + positional both present → exit 2 with conflict message", async () => {
    const cap = makeIO({ stdin: '{"messages":[]}' });
    const code = await run(["chat-completions", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("received both stdin and positional input");
  });

  it("P1: positional plain text desugared and dispatched", async () => {
    let captured: { messages?: { role: string; content: string }[] } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse("hello");
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["chat-completions", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(captured?.messages).toEqual([{ role: "user", content: "hi" }]);
    const out = JSON.parse(cap.stdout.value.trim());
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toBe("hello");
    expect(out.structuredContent.model).toBe("gpt-4o-mini");
  });

  it("P2: stdin JSON parsed verbatim", async () => {
    let captured: { messages?: { role: string; content: string }[] } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse();
      }),
    );
    const cap = makeIO({
      stdin: '{"messages":[{"role":"user","content":"ping"}]}',
      env: { AI_RELAY_API_KEY: "k" },
    });
    const code = await run(["chat-completions", "gpt-4o-mini"], cap.io);
    expect(code).toBe(0);
    expect(captured?.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("P3: positional JSON with model field — positional model overrides", async () => {
    let captured: { model?: string } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      [
        "chat-completions",
        "gpt-4o-mini",
        '{"model":"old","messages":[{"role":"user","content":"ping"}]}',
      ],
      cap.io,
    );
    expect(code).toBe(0);
    expect(captured?.model).toBe("gpt-4o-mini");
  });

  it("D2: empty stdin pipe → exit 2 with empty-stdin message (not generic 'requires input')", async () => {
    const cap = makeIO({ stdin: "", env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["chat-completions", "gpt-4o-mini"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("empty stdin");
    expect(cap.stderr.value).not.toContain("requires input");
  });

  it("D3: positional JSON array → exit 2 with array-rejection message naming the tool", async () => {
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["chat-completions", "gpt-4o-mini", "[1,2,3]"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain(
      "input JSON for chat-completions must be an object, not an array",
    );
  });

  it("P4: --system + plain text → system prepended", async () => {
    let captured: { messages?: { role: string; content: string }[] } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["chat-completions", "gpt-4o-mini", "-s", "be terse", "hi"], cap.io);
    expect(code).toBe(0);
    expect(captured?.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
  });
});

describe("run — env precedence", () => {
  let envFile: string;
  beforeEach(() => {
    envFile = join(scratchDir, `env-${Math.random().toString(36).slice(2)}.env`);
  });

  it("P1: --api-key flag wins over --env file value", async () => {
    let auth: string | null = null;
    server.use(
      http.post(ENDPOINT, ({ request }) => {
        auth = request.headers.get("authorization");
        return happyResponse();
      }),
    );
    writeFileSync(envFile, "AI_RELAY_API_KEY=fromfile\n");
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "fromenv" } });
    const code = await run(
      ["chat-completions", "gpt-4o-mini", "--api-key", "fromflag", "--env", envFile, "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(auth).toBe("Bearer fromflag");
  });

  it("P2: --env file value wins over process.env", async () => {
    let auth: string | null = null;
    server.use(
      http.post(ENDPOINT, ({ request }) => {
        auth = request.headers.get("authorization");
        return happyResponse();
      }),
    );
    writeFileSync(envFile, "AI_RELAY_API_KEY=fromfile\n");
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "fromenv" } });
    const code = await run(["chat-completions", "gpt-4o-mini", "--env", envFile, "hi"], cap.io);
    expect(code).toBe(0);
    expect(auth).toBe("Bearer fromfile");
  });

  it("P3: process.env value used when no flag and no env file", async () => {
    let auth: string | null = null;
    server.use(
      http.post(ENDPOINT, ({ request }) => {
        auth = request.headers.get("authorization");
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "fromenv" } });
    const code = await run(["chat-completions", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(auth).toBe("Bearer fromenv");
  });

  it("D1: no key from any source → exit 2 with config error", async () => {
    const cap = makeIO();
    const code = await run(["chat-completions", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("apiKey");
  });
});

describe("run — secret redaction", () => {
  it("D1: failing schema does NOT echo --api-key value", async () => {
    const sentinel = "leak-canary-9999";
    const cap = makeIO({ env: {} });
    const code = await run(
      ["chat-completions", "gpt-4o-mini", "--api-key", "", "--env", "/no/such/file.env", "hi"],
      cap.io,
    );
    expect(code).toBe(2);
    expect(cap.stderr.value).not.toContain(sentinel);
  });

  it("D2: env-file read failure does NOT echo file contents", async () => {
    const sentinel = "leak-marker-env-file";
    const cap = makeIO({ env: { AI_RELAY_API_KEY: sentinel } });
    const code = await run(
      ["chat-completions", "gpt-4o-mini", "--env", "/no/such/file.env", "hi"],
      cap.io,
    );
    expect(code).toBe(2);
    expect(cap.stderr.value).not.toContain(sentinel);
  });
});

describe("run — flag-driven config", () => {
  it("P1: --max-tokens flag flows to upstream request body", async () => {
    let body: { max_tokens?: number } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["chat-completions", "gpt-4o-mini", "--max-tokens", "256", "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(body?.max_tokens).toBe(256);
  });

  it("P2: --base-url flag retargets the upstream", async () => {
    let hit = false;
    server.use(
      http.post("https://relay.example.com/v1/chat/completions", () => {
        hit = true;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["chat-completions", "gpt-4o-mini", "--base-url", "https://relay.example.com/v1", "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(hit).toBe(true);
  });
});

describe("run — exit-code mapping", () => {
  it("P1: success → exit 0 + JSON on stdout", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse("done")));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["chat-completions", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value.trim().length).toBeGreaterThan(0);
  });

  it("D1: upstream 401 → isError + exit 1", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.json({ error: { message: "no auth" } }, { status: 401 }),
      ),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["chat-completions", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(1);
    const out = JSON.parse(cap.stdout.value.trim());
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("auth");
  });

  it("P2: TTY stdout is pretty-printed (multi-line)", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse()));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" }, isTTY: true });
    const code = await run(["chat-completions", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value.split("\n").length).toBeGreaterThan(2);
  });

  it("P3: piped stdout is single-line JSON", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse()));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" }, isTTY: false });
    const code = await run(["chat-completions", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value.trim().split("\n")).toHaveLength(1);
  });
});
