import http from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const VALID_INPUT = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "route this request" }],
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
  const upstreamA = await startMockOpenAI("from A");
  const upstreamB = await startMockOpenAI("from B");
  const transport = new StdioClientTransport({
    command: "corepack",
    args: ["pnpm", "exec", "tsx", "server.ts"],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      AZURE_OPENAI_KEY: "smoke-azure-key",
      AZURE_OPENAI_BASE_URL: upstreamA.baseURL,
      LOCAL_LLM_BASE_URL: upstreamB.baseURL,
      LOCAL_LLM_KEY: "smoke-local-key",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "multi-upstream-smoke", version: "0.0.0" });

  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await withTimeout(client.connect(transport), "initialize");

    const list = await withTimeout(client.listTools(), "tools/list");
    const names = list.tools.map((tool) => tool.name).sort();
    assert(
      names.includes("azure_chat") && names.includes("local_llm"),
      `expected azure_chat and local_llm in tools/list, saw ${names.join(", ")}; stderr:\n${stderr}`,
    );

    const resultA = await withTimeout(
      client.callTool({ name: "azure_chat", arguments: VALID_INPUT }),
      "azure_chat call",
    );
    const resultB = await withTimeout(
      client.callTool({ name: "local_llm", arguments: VALID_INPUT }),
      "local_llm call",
    );

    assert(resultA.isError !== true, `azure_chat returned an error: ${JSON.stringify(resultA)}`);
    assert(resultB.isError !== true, `local_llm returned an error: ${JSON.stringify(resultB)}`);
    assert(getText(resultA) === "from A", `unexpected azure_chat text: ${JSON.stringify(resultA)}`);
    assert(getText(resultB) === "from B", `unexpected local_llm text: ${JSON.stringify(resultB)}`);
    assert(upstreamA.requests.length === 1, `expected one A request, saw ${upstreamA.requests.length}`);
    assert(upstreamB.requests.length === 1, `expected one B request, saw ${upstreamB.requests.length}`);
    assert(upstreamA.requests[0]?.authorization === "Bearer smoke-azure-key", "A used the wrong key");
    assert(upstreamB.requests[0]?.authorization === "Bearer smoke-local-key", "B used the wrong key");

    console.log("=== PASS ===");
  } finally {
    await client.close();
    await upstreamA.close();
    await upstreamB.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
