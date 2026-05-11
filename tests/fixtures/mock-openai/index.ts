// Mock OpenAI Chat Completions server — preset-driven test fixture.
//
// Lifecycle:
//   const mock = await startMockOpenAI({ preset: "happy" });
//   process.env.AI_RELAY_BASE_URL = mock.baseURL;  // http://127.0.0.1:<port>/v1
//   ...run code that hits Chat Completions...
//   await mock.close();
//
// The fixture binds to 127.0.0.1:0 and resolves the actual port from the
// listening socket, so concurrent tests do not clash. State is per-instance
// (no module-level mutables) so multiple fixtures can run in the same
// process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Preset =
  | "happy"
  | "401"
  | "429"
  | "500"
  | "timeout"
  | "stream-mid-error"
  | "chunk-boundary";

export interface StartOptions {
  port?: number;
  preset?: Preset;
  // Optional fully custom handler. When supplied, `preset` is ignored.
  handler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export interface MockHandle {
  baseURL: string;
  port: number;
  close: () => Promise<void>;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

export async function startMockOpenAI(opts: StartOptions = {}): Promise<MockHandle> {
  const preset: Preset = opts.preset ?? "happy";
  const customHandler = opts.handler;

  const server: Server = createServer((req, res) => {
    if (customHandler) {
      void customHandler(req, res);
      return;
    }
    handleByPreset(preset, req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo | null;
  if (!addr) throw new Error("mock-openai: listen() returned no address");

  return {
    baseURL: `http://127.0.0.1:${addr.port}/v1`,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Force-destroy any keep-alive sockets so close() resolves promptly.
        server.closeAllConnections?.();
      }),
  };
}

// --- preset handlers ------------------------------------------------------

function handleByPreset(preset: Preset, req: IncomingMessage, res: ServerResponse): void {
  // All presets only respond to POST on the chat/completions path the SDK
  // uses. The SDK appends `/chat/completions` to whatever baseURL we hand it.
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.statusCode = 404;
    res.end();
    return;
  }
  // Drain the request body so the socket can close cleanly.
  req.on("data", () => {});
  req.on("end", () => {
    switch (preset) {
      case "happy":
        return sendHappy(res);
      case "401":
        return sendJsonError(res, 401, { message: "Invalid API key" });
      case "429":
        return sendRateLimited(res);
      case "500":
        return sendJsonError(res, 500, { message: "Upstream server error" });
      case "timeout":
        return holdOpen(res);
      case "stream-mid-error":
        return sendStreamMidError(res);
      case "chunk-boundary":
        return sendChunkBoundary(res);
    }
  });
}

function sendHappy(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
  // Three deltas + final usage + DONE.
  const frames = [
    JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
    JSON.stringify({ choices: [{ delta: { content: " " } }] }),
    JSON.stringify({ choices: [{ delta: { content: "world" }, finish_reason: "stop" }] }),
    JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }),
  ];
  for (const f of frames) res.write(`data: ${f}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  error: { message: string; code?: string },
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function sendRateLimited(res: ServerResponse): void {
  res.writeHead(429, {
    "content-type": "application/json",
    "retry-after": "5",
  });
  res.end(JSON.stringify({ error: { message: "Rate limited" } }));
}

function holdOpen(res: ServerResponse): void {
  // Write nothing. The socket stays open until the client times out or the
  // server is closed via `mock.close()` → `closeAllConnections()`.
  res.writeHead(200, SSE_HEADERS);
  // Intentionally no .write / .end — caller's AbortSignal/timeout fires.
}

function sendStreamMidError(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "tial" } }] })}\n\n`);
  // Forcibly destroy the underlying socket without [DONE].
  setTimeout(() => res.destroy(new Error("network reset")), 10);
}

function sendChunkBoundary(res: ServerResponse): void {
  res.writeHead(200, SSE_HEADERS);
  // Split one SSE frame across two TCP writes with a delay so the OS
  // doesn't coalesce them. The SDK must reassemble correctly.
  res.write('data: {"choices":[{"de');
  setTimeout(() => {
    res.write('lta":{"content":"hello"},"finish_reason":"stop"}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  }, 10);
}
