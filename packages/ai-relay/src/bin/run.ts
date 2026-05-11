// CLI orchestrator. Pure with respect to its `io` argument so unit
// tests can drive it without touching real stdio or process.exit.

import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { loadConfig } from "../config.js";
import type { OpenAIChatConfig, OpenAIChatHandlerBundle } from "../openai/index.js";
import { parseEnvFile } from "./env-file.js";
import { type ParsedInvocation, parseArgv, UsageError } from "./parse.js";
import { type AnyTool, resolveTool } from "./registry.js";

export const VERSION = "0.3.0";

const USAGE = `Usage: ai-relay <provider> <tool> -m <model> [flags] [input]

Required:
  -m, --model <model>     Model id (e.g. gpt-4o-mini)

Inputs (exactly one of):
  positional <input>      JSON literal or plain text
  stdin (when piped)      JSON literal or plain text

Flags:
  -s, --system <text>     System message prepended to plain-text input
      --api-key <key>     Upstream API key (overrides AI_RELAY_API_KEY)
      --base-url <url>    Upstream base URL (overrides AI_RELAY_BASE_URL)
      --max-tokens <n>    Cap on max_tokens
      --timeout <ms>      Request timeout in ms
      --env <path>        Load AI_RELAY_* keys from a dotenv file
  -h, --help              Show this message
  -V, --version           Print SDK version

Examples:
  ai-relay openai chat -m gpt-4o-mini "ping"
  ai-relay openai chat -m gpt-4o-mini -s "be terse" "explain TLS"
  ai-relay openai chat -m gpt-4o-mini '{"messages":[{"role":"user","content":"ping"}]}'
  ai-relay openai chat -m gpt-4o-mini --api-key sk-... "ping"
  ai-relay openai chat -m gpt-4o-mini --base-url https://my-azure.openai.azure.com/v1 "ping"
  echo '{"messages":[…]}' | ai-relay openai chat -m gpt-4o-mini
`;

export interface RunIO {
  stdin: Readable;
  stdinIsTTY: boolean;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

export async function run(argv: readonly string[], io: RunIO): Promise<number> {
  let parsed: ParsedInvocation;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const tool = resolveTool(parsed.provider, parsed.tool);
  if (!tool) {
    io.stderr.write(`unknown ${parsed.provider}/${parsed.tool}\n`);
    return 2;
  }

  const stdinResult = await readStdinIfPiped(io.stdin, io.stdinIsTTY);
  if (parsed.positional !== undefined && stdinResult.kind === "text") {
    io.stderr.write("received both stdin and positional input; pass exactly one\n");
    return 2;
  }
  let rawInput: string | undefined;
  if (parsed.positional !== undefined) {
    rawInput = parsed.positional;
  } else if (stdinResult.kind === "text") {
    rawInput = stdinResult.value;
  } else if (stdinResult.kind === "empty-pipe") {
    io.stderr.write("received empty stdin; pipe a JSON object or plain text\n");
    return 2;
  }
  if (rawInput === undefined) {
    io.stderr.write(`${parsed.provider} ${parsed.tool} requires input (positional or stdin)\n`);
    return 2;
  }

  let inputObj: Record<string, unknown>;
  try {
    inputObj = coerceInput(rawInput, tool, {
      ...(parsed.flags.system !== undefined ? { system: parsed.flags.system } : {}),
      ...(parsed.flags.model !== undefined ? { model: parsed.flags.model } : {}),
    });
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  const merged: Record<string, unknown> = {
    ...inputObj,
    ...(parsed.flags.model !== undefined ? { model: parsed.flags.model } : {}),
    ...(parsed.flags["max-tokens"] !== undefined ? { max_tokens: parsed.flags["max-tokens"] } : {}),
  };

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

  const toolConfig: OpenAIChatConfig = {
    apiKey: providerConfig.apiKey,
    ...(providerConfig.baseURL !== undefined ? { baseURL: providerConfig.baseURL } : {}),
    ...(providerConfig.maxOutputTokens !== undefined
      ? { maxOutputTokensCeiling: providerConfig.maxOutputTokens }
      : {}),
    ...(providerConfig.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: providerConfig.requestTimeoutMs }
      : {}),
  };

  const bundle: OpenAIChatHandlerBundle = tool.makeHandler(toolConfig);
  const result = await bundle.handler(merged);

  const output = io.isTTY ? JSON.stringify(result, null, 2) : JSON.stringify(result);
  io.stdout.write(`${output}\n`);
  return result.isError ? 1 : 0;
}

function coerceInput(
  raw: string,
  tool: AnyTool,
  opts: { system?: string; model?: string },
): Record<string, unknown> {
  const trimmed = raw.trimStart();
  const first = trimmed[0];
  if (first === "{" || first === "[") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new UsageError("input is not valid JSON");
    }
    if (Array.isArray(parsed)) {
      throw new UsageError(
        `input JSON for ${tool.provider}/${tool.name} must be an object, not an array`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new UsageError("input JSON must be an object");
    }
    return parsed as Record<string, unknown>;
  }
  if (!tool.desugar) {
    throw new UsageError(
      `tool ${tool.provider} ${tool.name} does not accept plain text input; pass JSON`,
    );
  }
  return tool.desugar(raw, opts);
}

type StdinResult = { kind: "tty" } | { kind: "text"; value: string } | { kind: "empty-pipe" };

async function readStdinIfPiped(stdin: Readable, stdinIsTTY: boolean): Promise<StdinResult> {
  if (stdinIsTTY) return { kind: "tty" };
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const text = chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? { kind: "empty-pipe" } : { kind: "text", value: text };
}
