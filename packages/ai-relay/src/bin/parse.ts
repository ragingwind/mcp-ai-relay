// argv → ParsedInvocation. Pure module with no I/O.
//
// Surface: `ai-relay-cli <provider> <tool> [flags] [input]`
//
// Long flags: --system -s, --model -m, --api-key, --base-url,
//             --max-tokens, --timeout, --env, --verbose -v,
//             --help -h, --version -V.
//
// Short forms: only the ones listed above are accepted.

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ParsedFlags {
  system?: string;
  model?: string;
  "api-key"?: string;
  "base-url"?: string;
  "max-tokens"?: number;
  timeout?: number;
  env?: string;
}

export interface ParsedInvocation {
  help: boolean;
  version: boolean;
  verbose: boolean;
  provider: string;
  tool: string;
  flags: ParsedFlags;
  positional?: string;
}

const VALUE_FLAGS = new Set([
  "system",
  "model",
  "api-key",
  "base-url",
  "max-tokens",
  "timeout",
  "env",
]);
const NUMERIC_FLAGS = new Set(["max-tokens", "timeout"]);
const SHORT_TO_LONG: Record<string, string> = {
  s: "system",
  m: "model",
  h: "help",
  V: "version",
  v: "verbose",
};

function parseNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--${name} must be a positive integer`);
  }
  return n;
}

export function parseArgv(argv: readonly string[]): ParsedInvocation {
  const out: ParsedInvocation = {
    help: false,
    version: false,
    verbose: false,
    provider: "",
    tool: "",
    flags: {},
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;

    if (tok === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        const v = argv[j];
        if (v !== undefined) positionals.push(v);
      }
      break;
    }

    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      const key = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

      if (key === "help") {
        out.help = true;
        continue;
      }
      if (key === "version") {
        out.version = true;
        continue;
      }
      if (key === "verbose") {
        out.verbose = true;
        continue;
      }
      if (!VALUE_FLAGS.has(key)) {
        throw new UsageError(`unknown flag: --${key}`);
      }
      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new UsageError(`--${key} requires a value`);
        }
        value = next;
        i += 1;
      }
      if (NUMERIC_FLAGS.has(key)) {
        (out.flags as Record<string, unknown>)[key] = parseNumber(key, value);
      } else {
        (out.flags as Record<string, unknown>)[key] = value;
      }
      continue;
    }

    if (tok.startsWith("-") && tok !== "-") {
      const body = tok.slice(1);
      const eq = body.indexOf("=");
      const short = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
      const long = SHORT_TO_LONG[short];
      if (!long) {
        throw new UsageError(`unknown flag: -${short}`);
      }
      if (long === "help") {
        out.help = true;
        continue;
      }
      if (long === "version") {
        out.version = true;
        continue;
      }
      if (long === "verbose") {
        out.verbose = true;
        continue;
      }
      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new UsageError(`-${short} requires a value`);
        }
        value = next;
        i += 1;
      }
      if (NUMERIC_FLAGS.has(long)) {
        (out.flags as Record<string, unknown>)[long] = parseNumber(long, value);
      } else {
        (out.flags as Record<string, unknown>)[long] = value;
      }
      continue;
    }

    positionals.push(tok);
  }

  if (out.help || out.version) {
    return out;
  }

  if (positionals.length < 2) {
    throw new UsageError("usage: ai-relay-cli <provider> <tool> [flags] [input]");
  }

  const provider = positionals[0];
  const tool = positionals[1];
  if (provider === undefined || tool === undefined) {
    throw new UsageError("usage: ai-relay-cli <provider> <tool> [flags] [input]");
  }
  out.provider = provider;
  out.tool = tool;

  if (positionals.length > 3) {
    throw new UsageError("at most one positional input is accepted after <tool>");
  }
  if (positionals.length === 3) {
    const pos = positionals[2];
    if (pos !== undefined) out.positional = pos;
  }

  return out;
}

// argv → ParsedMcpInvocation. Pure module with no I/O.
//
// Surface: `ai-relay <provider> [flags]`
// Flags: --api-key, --base-url, --max-tokens, --timeout, --env,
//        --verbose -v, --help -h, --version -V.

export interface ParsedMcpFlags {
  "api-key"?: string;
  "base-url"?: string;
  "max-tokens"?: number;
  timeout?: number;
  env?: string;
}

export interface ParsedMcpInvocation {
  help: boolean;
  version: boolean;
  verbose: boolean;
  provider?: string;
  flags: ParsedMcpFlags;
}

const MCP_VALUE_FLAGS = new Set(["api-key", "base-url", "max-tokens", "timeout", "env"]);
const MCP_NUMERIC_FLAGS = new Set(["max-tokens", "timeout"]);

export function parseMcpArgv(argv: readonly string[]): ParsedMcpInvocation {
  const out: ParsedMcpInvocation = {
    help: false,
    version: false,
    verbose: false,
    flags: {},
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;

    if (tok === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        const v = argv[j];
        if (v !== undefined) positionals.push(v);
      }
      break;
    }

    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      const key = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

      if (key === "help") {
        out.help = true;
        continue;
      }
      if (key === "version") {
        out.version = true;
        continue;
      }
      if (key === "verbose") {
        out.verbose = true;
        continue;
      }
      if (!MCP_VALUE_FLAGS.has(key)) {
        throw new UsageError(`unknown flag: --${key}`);
      }
      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new UsageError(`--${key} requires a value`);
        }
        value = next;
        i += 1;
      }
      if (MCP_NUMERIC_FLAGS.has(key)) {
        (out.flags as Record<string, unknown>)[key] = parseNumber(key, value);
      } else {
        (out.flags as Record<string, unknown>)[key] = value;
      }
      continue;
    }

    if (tok.startsWith("-") && tok !== "-") {
      const body = tok.slice(1);
      if (body === "h") {
        out.help = true;
        continue;
      }
      if (body === "V") {
        out.version = true;
        continue;
      }
      if (body === "v") {
        out.verbose = true;
        continue;
      }
      throw new UsageError(`unknown flag: -${body}`);
    }

    positionals.push(tok);
  }

  if (out.help || out.version) {
    return out;
  }

  if (positionals.length === 0) {
    return out;
  }
  if (positionals.length > 1) {
    throw new UsageError("usage: ai-relay <provider> [flags]");
  }
  const first = positionals[0];
  if (first !== undefined) out.provider = first;
  return out;
}
