#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const SENTINEL_A = "from-upstream-A";
const SENTINEL_B = "from-upstream-B";

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

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
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
        } catch {}
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
  const mockA = makeMockOpenAI(SENTINEL_A);
  const mockB = makeMockOpenAI(SENTINEL_B);
  const portA = await listen(mockA);
  const portB = await listen(mockB);
  const baseA = `http://127.0.0.1:${portA}/v1`;
  const baseB = `http://127.0.0.1:${portB}/v1`;
  console.error(`[smoke] mock A (chat-completions): ${baseA}`);
  console.error(`[smoke] mock B (local_llm):   ${baseB}`);

  const exampleDir = new URL("..", import.meta.url).pathname;
  const child = spawn("pnpm", ["--filter", "@example/multi-upstream", "start"], {
    env: {
      ...process.env,
      AI_RELAY_API_KEY: "test-a",
      AI_RELAY_BASE_URL: baseA,
      LOCAL_LLM_BASE_URL: baseB,
      LOCAL_LLM_KEY: "test-b",
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
      mockA.close();
    } catch {}
    try {
      mockB.close();
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

  await delay(1000);
  if (earlyExit) {
    console.error("----- child stderr -----");
    console.error(stderrChunks.join(""));
    fail("M-1", "child exited before initialize");
  }

  const driver = new JsonRpcDriver(child);
  await driver.request(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    },
    1,
  );
  driver.notify("notifications/initialized", {});

  // M-1: stderr contains "registered 2 tool(s)."
  const stderrText = stderrChunks.join("");
  if (!stderrText.includes("registered 2 tool(s).")) {
    fail("M-1", `stderr missing 'registered 2 tool(s).'; got: ${stderrText.slice(0, 300)}`);
  }

  // M-2: tools/list returns chat-completions + local_llm
  const listResp = await driver.request("tools/list", {}, 2);
  const toolNames = (listResp.result?.tools ?? []).map((t) => t.name);
  if (!toolNames.includes("chat-completions") || !toolNames.includes("local_llm")) {
    fail("M-2", `expected chat-completions + local_llm, got ${toolNames.join(",")}`);
  }

  // M-3: tools/call chat-completions returns SENTINEL_A
  const callA = await driver.request(
    "tools/call",
    {
      name: "chat-completions",
      arguments: { model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] },
    },
    3,
  );
  const textA = (callA.result?.content ?? []).map((c) => c.text ?? "").join("");
  if (!textA.includes(SENTINEL_A)) {
    fail("M-3", `chat-completions content missing ${SENTINEL_A}; got: ${textA.slice(0, 200)}`);
  }

  // M-4: tools/call local_llm returns SENTINEL_B
  const callB = await driver.request(
    "tools/call",
    {
      name: "local_llm",
      arguments: { model: "local-model", messages: [{ role: "user", content: "ping" }] },
    },
    4,
  );
  const textB = (callB.result?.content ?? []).map((c) => c.text ?? "").join("");
  if (!textB.includes(SENTINEL_B)) {
    fail("M-4", `local_llm content missing ${SENTINEL_B}; got: ${textB.slice(0, 200)}`);
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
