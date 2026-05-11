import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const VALID_INPUT = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "say hello" }],
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function withTimeout(promise, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startMockOpenAI(replyText) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(body),
    });

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected smoke-test route" }));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: replyText } }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address();
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function getText(result) {
  return result.content?.find((part) => part.type === "text")?.text;
}

async function main() {
  const upstream = await startMockOpenAI("from stdio");
  const transport = new StdioClientTransport({
    command: "corepack",
    args: ["pnpm", "exec", "tsx", "server.ts"],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      AI_RELAY_API_KEY: "smoke-openai-key",
      AI_RELAY_BASE_URL: upstream.baseURL,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-smoke", version: "0.0.0" });

  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await withTimeout(client.connect(transport), "initialize");

    const list = await withTimeout(client.listTools(), "tools/list");
    assert(
      list.tools.some((tool) => tool.name === "openai_chat"),
      `expected openai_chat in tools/list; stderr:\n${stderr}`,
    );

    const result = await withTimeout(
      client.callTool({ name: "openai_chat", arguments: VALID_INPUT }),
      "tools/call",
    );
    assert(result.isError !== true, `openai_chat returned an error: ${JSON.stringify(result)}`);
    assert(getText(result) === "from stdio", `unexpected tool text: ${JSON.stringify(result)}`);
    assert(upstream.requests.length === 1, `expected one upstream request, saw ${upstream.requests.length}`);
    assert(
      upstream.requests[0]?.authorization === "Bearer smoke-openai-key",
      "upstream request did not include the configured API key",
    );
    assert(upstream.requests[0]?.body?.model === VALID_INPUT.model, "upstream request used the wrong model");

    transport._process?.stdin?.write("{not valid json}\n");
    await delay(100);
    assert(transport._process?.exitCode === null, "server exited after malformed JSON");
    await withTimeout(client.listTools(), "tools/list after malformed JSON");

    console.log("=== PASS ===");
  } finally {
    await client.close();
    await upstream.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
