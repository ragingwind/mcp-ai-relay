#!/usr/bin/env node
// Minimal OpenAI Chat Completions mock for the docker smoke harness.
//
// Usage:
//   node tests/fixtures/mock-openai/server.mjs --port=0
//   node tests/fixtures/mock-openai/server.mjs --port=18080
//
// Contract for the docker-smoke harness:
//   - Exits 0 on SIGTERM/SIGINT.
//   - Prints exactly one line `LISTENING port=<N>` to stdout once the
//     listener is bound. The harness greps stdout for this token to
//     discover the port (`--port=0` lets the OS pick a free port).
//   - Returns the OpenAI v1 chat-completion JSON shape; the assistant
//     content is the literal token `smoke-canned-reply` so callers can
//     assert on it.
//
// Per project CLAUDE.md §4: never log request/response bodies.

import { createServer } from "node:http";

const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = Number(portArg ? portArg.slice("--port=".length) : 0);

const CANNED_REPLY = "smoke-canned-reply";

function chatCompletionResponse(model) {
  return {
    id: "chatcmpl-smoke-0001",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof model === "string" && model.length > 0 ? model : "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: CANNED_REPLY },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
  };
}

function streamChunk(model, delta, finishReason, usage) {
  const obj = {
    id: "chatcmpl-smoke-0001",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: typeof model === "string" && model.length > 0 ? model : "gpt-4o-mini",
    choices:
      delta !== null
        ? [
            {
              index: 0,
              delta: delta,
              finish_reason: finishReason,
            },
          ]
        : [],
    ...(usage ? { usage } : {}),
  };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    let bodyLen = 0;
    req.on("data", (chunk) => {
      bodyLen += chunk.length;
      if (bodyLen < 16384) body += chunk.toString("utf8");
    });
    req.on("end", () => {
      // Match `"model":"..."` and `"stream":true` without parsing the body.
      const modelMatch = body.match(/"model"\s*:\s*"([^"]+)"/);
      const model = modelMatch ? modelMatch[1] : "";
      const wantsStream = /"stream"\s*:\s*true/.test(body);
      if (wantsStream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(streamChunk(model, { role: "assistant", content: "" }, null, null));
        res.write(streamChunk(model, { content: CANNED_REPLY }, null, null));
        res.write(streamChunk(model, {}, "stop", null));
        res.write(
          streamChunk(model, null, null, {
            prompt_tokens: 1,
            completion_tokens: 3,
            total_tokens: 4,
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const payload = JSON.stringify(chatCompletionResponse(model));
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      }
    });
    req.on("error", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock upstream read error" } }));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

// Bind 0.0.0.0 so the docker-smoke harness can reach this fixture from
// inside the container via host.docker.internal. 127.0.0.1 would only
// be reachable from the host's loopback interface.
server.listen(port, "0.0.0.0", () => {
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  process.stdout.write(`LISTENING port=${boundPort}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  // Force-exit if shutdown hangs (in-flight request held the socket).
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
