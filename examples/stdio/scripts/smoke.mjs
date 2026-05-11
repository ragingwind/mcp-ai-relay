#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const SENTINEL = "openai-mock-sentinel-abc123";

function sseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeMockOpenAI(sentinel) {
  return createServer((req, res) => {
    if (req.method === "POST" && req.url && req.url.endsWith("/chat/completions")) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const created = Math.floor(Date.now() / 1000);
        res.write(
          sseFrame({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created,
            model: "gpt-4o-mini",
            choices: [{ index: 0, delta: { role: "assistant", content: sentinel }, finish_reason: null }],
          }),
        );
        res.write(
          sseFrame({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created,
            model: "gpt-4o-mini",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

function startMockOpenAI() {
  return makeMockOpenAI(SENTINEL);
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return port;
}

class JsonRpcDriver {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.pending = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
  }

  #onData(chunk) {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const resolver = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            resolver(msg);
          }
        } catch {
          // Ignore non-JSON output (e.g., stderr leaking — actually stderr is separate).
        }
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  send(payload) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} id=${id}`));
      }, 10_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
}

function fail(id, reason) {
  console.error(`[smoke] FAIL ${id}: ${reason}`);
  console.error("[smoke] === FAIL ===");
  process.exit(1);
}

async function main() {
  const mock = startMockOpenAI();
  const port = await listen(mock);
  const baseURL = `http://127.0.0.1:${port}/v1`;
  console.error(`[smoke] mock OpenAI listening at ${baseURL}`);

  const exampleDir = new URL("..", import.meta.url).pathname;
  const child = spawn("pnpm", ["--filter", "@example/stdio", "start"], {
    env: {
      ...process.env,
      AI_RELAY_API_KEY: "test",
      AI_RELAY_BASE_URL: baseURL,
    },
    cwd: exampleDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrChunks = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => stderrChunks.push(c));

  const cleanup = () => {
    try {
      child.kill("SIGTERM");
    } catch {}
    try {
      mock.close();
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  let earlyExit = false;
  child.on("exit", (code, signal) => {
    earlyExit = true;
    console.error(`[smoke] child exited code=${code} signal=${signal}`);
  });

  await delay(800);

  // S-1: child alive after startup
  if (earlyExit) {
    console.error("----- child stderr -----");
    console.error(stderrChunks.join(""));
    fail("S-1", "child exited before driver could send initialize");
  }

  const driver = new JsonRpcDriver(child);

  // S-2: initialize
  const initResp = await driver.request(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    },
    1,
  );
  if (initResp.result?.serverInfo?.name !== "openai-relay-stdio") {
    fail(
      "S-2",
      `expected serverInfo.name=openai-relay-stdio, got ${JSON.stringify(initResp.result?.serverInfo)}`,
    );
  }
  driver.notify("notifications/initialized", {});

  // S-3: tools/list
  const listResp = await driver.request("tools/list", {}, 2);
  const toolNames = (listResp.result?.tools ?? []).map((t) => t.name);
  if (!toolNames.includes("openai_chat")) {
    fail("S-3", `tools/list missing openai_chat (got ${toolNames.join(",")})`);
  }

  // S-4: tools/call openai_chat
  const callResp = await driver.request(
    "tools/call",
    {
      name: "openai_chat",
      arguments: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "ping" }],
      },
    },
    3,
  );
  const content = callResp.result?.content ?? [];
  const text = content.map((c) => c.text ?? "").join("");
  if (!text.includes(SENTINEL)) {
    fail("S-4", `tools/call response did not contain sentinel; got: ${text.slice(0, 200)}`);
  }

  // S-5: send malformed JSON; child should not crash.
  child.stdin.write("this is not json\n");
  await delay(500);
  if (earlyExit) {
    console.error("----- child stderr -----");
    console.error(stderrChunks.join(""));
    fail("S-5", "child exited after receiving malformed JSON line");
  }

  console.error("[smoke] === PASS ===");
  console.log("=== PASS ===");
  cleanup();
  await delay(100);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[smoke] driver error: ${err.stack ?? err}`);
  console.error("[smoke] === FAIL ===");
  process.exit(1);
});
