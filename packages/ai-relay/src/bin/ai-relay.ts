#!/usr/bin/env node
// `ai-relay <api-type>` — start an MCP stdio server that relays calls
// to the upstream provider keyed by `<api-type>` (today: chat-completions).

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { VERSION } from "../version.js";
import { parseEnvFile } from "./env-file.js";
import { startMcpServer } from "./mcp-server.js";
import { type ParsedMcpInvocation, parseMcpArgv, UsageError } from "./parse.js";
import { registry, resolveApiType } from "./registry.js";

export { VERSION };

const USAGE = `Usage: ai-relay <api-type> [flags]

Start an MCP stdio server that relays calls to the given API. Intended to be
spawned by an MCP host (Claude Desktop, Claude Code, Cursor, …) — do not run
interactively.

API types:
  chat-completions  OpenAI Chat Completions API

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
        "args": ["-y", "ai-relay", "chat-completions"],
        "env": { "AI_RELAY_API_KEY": "sk-..." }
      }
    }
  }

For one-shot CLI invocation (no MCP server), use \`ai-relay-cli\`.
`;

const USAGE_NO_API_TYPE = `error: <api-type> positional is required

usage: ai-relay <api-type> [flags]
api types: ${Object.keys(registry).join(", ")}

For one-shot CLI invocation, use \`ai-relay-cli\`.
`;

export interface AiRelayIO {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  env: Record<string, string | undefined>;
}

export async function main(argv: readonly string[], io: AiRelayIO): Promise<number> {
  let parsed: ParsedMcpInvocation;
  try {
    parsed = parseMcpArgv(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (parsed.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.apiType === undefined) {
    io.stderr.write(USAGE_NO_API_TYPE);
    return 2;
  }

  const apiType = resolveApiType(parsed.apiType);
  if (apiType === undefined) {
    io.stderr.write(
      `unknown api-type: ${parsed.apiType}\nknown api types: ${Object.keys(registry).join(", ")}\n`,
    );
    return 2;
  }

  let envFileMap: Record<string, string> = {};
  if (parsed.flags.env !== undefined) {
    let body: string;
    try {
      body = await readFile(parsed.flags.env, "utf8");
    } catch (e) {
      const cause = e instanceof Error ? e.message : "unknown error";
      io.stderr.write(`cannot read --env file ${parsed.flags.env}: ${cause}\n`);
      return 2;
    }
    try {
      envFileMap = parseEnvFile(body);
    } catch (e) {
      io.stderr.write(`${(e as Error).message}\n`);
      return 2;
    }
  }

  const effectiveEnv = { ...io.env, ...envFileMap };

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
    io.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  await startMcpServer({
    apiType,
    version: VERSION,
    config: {
      apiKey: providerConfig.apiKey,
      ...(providerConfig.baseURL !== undefined ? { baseURL: providerConfig.baseURL } : {}),
      ...(providerConfig.maxOutputTokens !== undefined
        ? { maxOutputTokensCeiling: providerConfig.maxOutputTokens }
        : {}),
      ...(providerConfig.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: providerConfig.requestTimeoutMs }
        : {}),
    },
  });
  return 0;
}

// Entry shim — invoked when this file is executed directly as the bin.
// Vitest imports the module without triggering this branch. argv[1] may be
// a symlink (npm installs the bin under node_modules/.bin via symlink), so
// resolve it through realpath before comparing to import.meta.url.
function isDirectInvocationCheck(): boolean {
  if (typeof process === "undefined") return false;
  if (!Array.isArray(process.argv)) return false;
  const arg1 = process.argv[1];
  if (arg1 === undefined) return false;
  let realArg1: string;
  try {
    realArg1 = realpathSync(arg1);
  } catch {
    realArg1 = arg1;
  }
  return import.meta.url === pathToFileURL(realArg1).href;
}
const isDirectInvocation = isDirectInvocationCheck();

if (isDirectInvocation) {
  main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  }).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
      process.exit(1);
    },
  );
}
