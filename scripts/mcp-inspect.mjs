#!/usr/bin/env node
// CLI wrapper around `npx @modelcontextprotocol/inspector --cli` for ad-hoc
// MCP smoke checks against /api/mcp. Inputs (priority: flag > env (incl.
// --env-file-if-exists=.env.local) > default):
//
//   --url=<URL>      MCP_URL              http://localhost:8787/api/mcp
//   --token=<TOK>    AI_RELAY_AUTH_TOKEN  (required)
//   --tool=<NAME>    MCP_TOOL             chat-completions
//   --model=<NAME>   MCP_MODEL            gpt-4o-mini
//   --message=<TXT>  MCP_MESSAGE          ping
//   --method=<RPC>                        tools/call   (also: tools/list)
//
// Examples:
//   pnpm inspect                                  # tools/call → chat-completions
//   pnpm inspect --method=tools/list
//   pnpm inspect --url=http://localhost:3001/api/mcp --model=gpt-4o
//   pnpm inspect --tool=other_tool --message="..."
//   MCP_URL=https://relay.example.com/api/mcp AI_RELAY_AUTH_TOKEN=... pnpm inspect

import { spawn } from "node:child_process";

const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const i = a.indexOf("=");
      return i < 0 ? [a.slice(2), "true"] : [a.slice(2, i), a.slice(i + 1)];
    }),
);

const URL_BASE =
  flags.url ?? process.env.MCP_URL ?? "http://localhost:8787/api/mcp";
const TOKEN = flags.token ?? process.env.AI_RELAY_AUTH_TOKEN;
const TOOL = flags.tool ?? process.env.MCP_TOOL ?? "chat-completions";
const MODEL = flags.model ?? process.env.MCP_MODEL ?? "gpt-4o-mini";
const MESSAGE = flags.message ?? process.env.MCP_MESSAGE ?? "ping";
const METHOD = flags.method ?? "tools/call";

if (!TOKEN) {
  console.error(
    "[mcp-inspect] missing token. Set AI_RELAY_AUTH_TOKEN in .env.local or pass --token=...",
  );
  process.exit(1);
}

const ALLOWED_METHODS = new Set(["tools/list", "tools/call"]);
if (!ALLOWED_METHODS.has(METHOD)) {
  console.error(
    `[mcp-inspect] --method must be one of: ${[...ALLOWED_METHODS].join(", ")}`,
  );
  process.exit(1);
}

const args = [
  "--yes",
  "@modelcontextprotocol/inspector",
  "--cli",
  URL_BASE,
  "--transport",
  "http",
  "--header",
  `Authorization: Bearer ${TOKEN}`,
  "--method",
  METHOD,
];

if (METHOD === "tools/call") {
  args.push(
    "--tool-name",
    TOOL,
    "--tool-arg",
    `model=${MODEL}`,
    "--tool-arg",
    `messages=${JSON.stringify([{ role: "user", content: MESSAGE }])}`,
  );
}

const tokenPreview = `${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}`;
const callDetail =
  METHOD === "tools/call" ? `  tool=${TOOL}  model=${MODEL}` : "";
console.error(
  `[mcp-inspect] ${METHOD} → ${URL_BASE}${callDetail}  token=${tokenPreview}`,
);

const child = spawn("npx", args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
