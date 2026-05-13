#!/usr/bin/env node
// Real-server smoke test. Run `pnpm dev` in another terminal first, then
// `pnpm verify` here.
//
// Sends JSON-RPC directly to /api/mcp, covering C1, C2, C5 from
// doc/QA-MCP-INSPECTOR.md. The caller-facing MCP tool accepts ONLY
// { messages } per 0.10.0 — model / sampling parameters live on the server
// (env or flags). This script asserts the server is correctly configured
// by reading structuredContent.model back from the C2 response.
//
// Skipped:
//   C4 (server-side sampling override) — requires restarting the server with
//      different env values; stays manual per QA-MCP-INSPECTOR.md.
//   C6 (cancellation) — relies on visual inspection of the OpenAI usage
//      page; stays manual per QA-MCP-INSPECTOR.md.

const TOKEN = process.env.AI_RELAY_AUTH_TOKEN;
if (!TOKEN) {
  console.error(
    "[verify] AI_RELAY_AUTH_TOKEN missing — set in .env.local (auto-loaded by `pnpm verify`) or export in your shell",
  );
  process.exit(1);
}

const argUrl = process.argv.slice(2).find((a) => a.startsWith("--url="));
const URL_BASE =
  (argUrl && argUrl.slice("--url=".length)) ||
  process.env.MCP_URL ||
  "http://localhost:8787/api/mcp";

const ACCEPT_BOTH = "application/json, text/event-stream";

async function readJsonRpc(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  const lines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((s) => s && s !== "[DONE]");
  if (!lines.length) throw new Error("No SSE data lines in response");
  return JSON.parse(lines.at(-1));
}

async function rpc(body, opts = {}) {
  return fetch(URL_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT_BOTH,
      authorization: `Bearer ${opts.token ?? TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

const results = [];
function record(id, label, pass, note) {
  results.push({ id, label, pass, note });
  const stamp = pass ? "PASS" : "FAIL";
  console.log(`[${stamp}] ${id}  ${label}${note ? "  — " + note : ""}`);
}

try {
  await fetch(URL_BASE, { method: "GET" });
} catch {
  console.error("");
  console.error(`[verify] cannot reach ${URL_BASE}`);
  console.error("         run `pnpm dev` in another terminal first.");
  console.error("         override URL: pnpm verify --url=http://localhost:3001/api/mcp");
  console.error("");
  process.exit(1);
}

console.log(`endpoint:  ${URL_BASE}`);
console.log("model:     (server-configured; read from C2 response)");
console.log("");

// ---- C1: tools/list ----------------------------------------------------

try {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const env = await readJsonRpc(res);
  const tools = env.result?.tools ?? [];
  const ok = tools.length === 1 && tools[0]?.name === "chat-completions";
  record(
    "C1",
    "tools/list — single chat-completions",
    ok,
    ok ? "1 tool" : `got ${JSON.stringify(tools.map((t) => t.name))}`,
  );
} catch (err) {
  record("C1", "tools/list — single chat-completions", false, err.message);
}

// ---- C2: chat-completions happy path ---------------------------------------

try {
  const res = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "chat-completions",
      arguments: {
        messages: [{ role: "user", content: "ping" }],
      },
    },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const env = await readJsonRpc(res);
  const result = env.result;
  const text = result?.content?.[0]?.text ?? "";
  const usage = result?.structuredContent?.usage;
  const model = result?.structuredContent?.model;
  const ok =
    result?.isError === false &&
    typeof text === "string" &&
    text.length > 0 &&
    typeof usage?.total_tokens === "number" &&
    usage.total_tokens > 0 &&
    typeof model === "string" &&
    model.length > 0;
  const note = usage
    ? `model=${model ?? "(missing)"} prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`
    : "no usage";
  record("C2", "chat-completions happy path", ok, note);
} catch (err) {
  record("C2", "chat-completions happy path", false, err.message);
}

// ---- C5: wrong bearer 401 ---------------------------------------------

try {
  const res = await rpc(
    { jsonrpc: "2.0", id: 5, method: "tools/list" },
    { token: "wrong-token-1234567890123456789012" },
  );
  const wwwAuth = res.headers.get("www-authenticate") || "";
  const ok = res.status === 401 && /Bearer/i.test(wwwAuth);
  record("C5", "wrong bearer 401 + WWW-Authenticate", ok, `HTTP ${res.status}`);
} catch (err) {
  record("C5", "wrong bearer 401 + WWW-Authenticate", false, err.message);
}

// ---- Summary + evidence record ---------------------------------------

console.log("");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} scenarios passed`);
console.log("");
console.log("--- evidence record (paste into PR) ---");
console.log(`MCP smoke verification — ${new Date().toISOString()}`);
console.log(`Endpoint:  ${URL_BASE}`);
console.log("Model:     (server-configured via AI_RELAY_MODEL)");
console.log("");
for (const r of results) {
  console.log(`${r.id}  ${r.pass ? "PASS" : "FAIL"}  ${r.label}${r.note ? " — " + r.note : ""}`);
}
console.log("C4  N/A   server-side sampling override; manual only");
console.log("C6  N/A   cancellation; manual only");
console.log("--- end ---");

process.exit(passed === results.length ? 0 : 1);
