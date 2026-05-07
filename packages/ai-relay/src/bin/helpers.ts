// Pure helpers for the CLI bin. Separated from `cli.ts` so unit tests
// can import them without triggering the top-level `main()` call that
// runs when the entry script is loaded.

import type { OpenAIChatConfig } from "../openai/index.js";

export type Provider = "openai-completion";

export interface ParsedArgs {
  provider: Provider | null;
  name?: string;
  description?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { provider: null, help: false, version: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--openai-completion":
        if (result.provider !== null) {
          throw new Error(
            `Multiple provider flags supplied. Pass exactly one (got: --${result.provider} and ${arg}).`,
          );
        }
        result.provider = "openai-completion";
        break;
      case "--name": {
        const next = argv[++i];
        if (!next || next.startsWith("--")) throw new Error("--name requires a value");
        result.name = next;
        break;
      }
      case "--description": {
        const next = argv[++i];
        if (!next || next.startsWith("--")) throw new Error("--description requires a value");
        result.description = next;
        break;
      }
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--version":
      case "-V":
        result.version = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    process.stderr.write(`Required environment variable ${key} is not set.\n`);
    process.exit(1);
  }
  return v;
}

export function optionalNumberEnv(key: string): number | undefined {
  const v = process.env[key];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`Environment variable ${key} must be a positive number, got: ${v}\n`);
    process.exit(1);
  }
  return n;
}

export function buildOpenAIChatConfig(args: ParsedArgs): OpenAIChatConfig {
  const config: OpenAIChatConfig = {
    apiKey: requireEnv("OPENAI_API_KEY"),
  };
  const baseURL = process.env.OPENAI_BASE_URL;
  if (baseURL) config.baseURL = baseURL;
  const ceiling = optionalNumberEnv("OPENAI_MAX_OUTPUT_TOKENS_CEILING");
  if (ceiling !== undefined) config.maxOutputTokensCeiling = ceiling;
  const timeoutMs = optionalNumberEnv("OPENAI_REQUEST_TIMEOUT_MS");
  if (timeoutMs !== undefined) config.requestTimeoutMs = timeoutMs;
  if (args.name) config.name = args.name;
  if (args.description) config.description = args.description;
  return config;
}
