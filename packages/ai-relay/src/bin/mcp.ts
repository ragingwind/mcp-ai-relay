#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { registerOpenAIChat } from "../openai/index.js";
import { parseEnvFile } from "./env-file.js";

const VERSION = "0.4.1";

const USAGE = `Usage: ai-relay-mcp [flags]

Starts a stdio MCP server exposing the \`openai_chat\` tool. Intended to be
spawned by an MCP host (Claude Desktop, Claude Code, Cursor, …) — do not
run interactively.

Flags:
      --api-key <key>     Upstream API key (overrides AI_RELAY_API_KEY)
      --base-url <url>    Upstream base URL (overrides AI_RELAY_BASE_URL)
      --max-tokens <n>    Ceiling for max_tokens
      --timeout <ms>      Upstream request timeout in ms
      --env <path>        Load AI_RELAY_* keys from a dotenv file
  -h, --help              Show this message
  -V, --version           Print SDK version

Example claude_desktop_config.json:
  {
    "mcpServers": {
      "ai-relay": {
        "command": "npx",
        "args": ["-y", "--package=ai-relay", "ai-relay-mcp"],
        "env": { "AI_RELAY_API_KEY": "sk-..." }
      }
    }
  }
`;

interface Flags {
  "api-key"?: string;
  "base-url"?: string;
  "max-tokens"?: number;
  timeout?: number;
  env?: string;
}

const VALUE_FLAGS = new Set(["api-key", "base-url", "max-tokens", "timeout", "env"]);
const NUMERIC_FLAGS = new Set(["max-tokens", "timeout"]);

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return n;
}

function parseFlags(argv: readonly string[]): { help: boolean; version: boolean; flags: Flags } {
  const flags: Flags = {};
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;

    if (tok === "-h" || tok === "--help") {
      help = true;
      continue;
    }
    if (tok === "-V" || tok === "--version") {
      version = true;
      continue;
    }
    if (!tok.startsWith("--")) {
      throw new Error(`unknown argument: ${tok}`);
    }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    if (!VALUE_FLAGS.has(key)) {
      throw new Error(`unknown flag: --${key}`);
    }
    let value: string;
    if (inline !== undefined) {
      value = inline;
    } else {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`--${key} requires a value`);
      value = next;
      i += 1;
    }
    if (NUMERIC_FLAGS.has(key)) {
      (flags as Record<string, unknown>)[key] = parsePositiveInt(key, value);
    } else {
      (flags as Record<string, unknown>)[key] = value;
    }
  }

  return { help, version, flags };
}

async function main(): Promise<number> {
  let parsed: { help: boolean; version: boolean; flags: Flags };
  try {
    parsed = parseFlags(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let envFileMap: Record<string, string> = {};
  if (parsed.flags.env !== undefined) {
    let body: string;
    try {
      body = await readFile(parsed.flags.env, "utf8");
    } catch (e) {
      const cause = e instanceof Error ? e.message : "unknown error";
      process.stderr.write(`cannot read --env file ${parsed.flags.env}: ${cause}\n`);
      return 2;
    }
    try {
      envFileMap = parseEnvFile(body);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 2;
    }
  }

  const effectiveEnv = { ...process.env, ...envFileMap };

  const args: Record<string, unknown> = { provider: "openai" };
  if (parsed.flags["api-key"] !== undefined) args.apiKey = parsed.flags["api-key"];
  if (parsed.flags["base-url"] !== undefined) args.baseURL = parsed.flags["base-url"];
  if (parsed.flags["max-tokens"] !== undefined) args.maxOutputTokens = parsed.flags["max-tokens"];
  if (parsed.flags.timeout !== undefined) args.requestTimeoutMs = parsed.flags.timeout;

  let providerConfig: {
    apiKey: string;
    baseURL?: string | undefined;
    maxOutputTokens?: number | undefined;
    requestTimeoutMs?: number | undefined;
  };
  try {
    const cfg = loadConfig({ env: effectiveEnv, args });
    const first = cfg.providers[0];
    if (!first) throw new Error("loadConfig returned no providers");
    providerConfig = first;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  const server = new McpServer({ name: "ai-relay", version: VERSION });
  registerOpenAIChat(server, {
    apiKey: providerConfig.apiKey,
    ...(providerConfig.baseURL !== undefined ? { baseURL: providerConfig.baseURL } : {}),
    ...(providerConfig.maxOutputTokens !== undefined
      ? { maxOutputTokensCeiling: providerConfig.maxOutputTokens }
      : {}),
    ...(providerConfig.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: providerConfig.requestTimeoutMs }
      : {}),
  });

  await server.connect(new StdioServerTransport());
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
    process.exit(1);
  },
);
