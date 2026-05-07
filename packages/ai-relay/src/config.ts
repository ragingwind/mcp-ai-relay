// Provider-agnostic relay configuration.
//
// `loadConfig({ env, file, args })` is the single resolution function for
// every embed shape (CLI, HTTP server, stdio launcher). It is synchronous
// (called once at startup) and side-effect-free — it reads only what its
// caller passes via `source`. Module load does NOT touch process.env.
//
// Error messages MUST never echo any source value. Failure messages are
// built strictly from `issue.path` + `issue.message` text.

import { readFileSync } from "node:fs";
import { z } from "zod";

export type Provider = "openai";
export type Capability = "chat";

const providerConfigSchema = z
  .object({
    id: z.string().min(1).optional(),
    provider: z.literal("openai"),
    capability: z.literal("chat").default("chat"),
    apiKey: z.string().min(1),
    baseURL: z.string().url().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    description: z.string().optional(),
  })
  .strict();

const relayConfigSchema = z.object({
  providers: z.array(providerConfigSchema).min(1),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type RelayConfig = z.infer<typeof relayConfigSchema>;

export type EnvSource = Record<string, string | undefined>;

export type ArgsSource = {
  provider?: Provider;
  capability?: Capability;
  id?: string;
  apiKey?: string;
  baseURL?: string;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  description?: string;
};

export type LoadConfigSource = {
  env?: EnvSource;
  file?: string;
  args?: ArgsSource;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function redactZodError(prefix: string, error: z.ZodError): Error {
  const failures = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return new Error(`${prefix}: ${failures}`);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid positive integer: ${value.length > 0 ? "(redacted)" : ""}`);
  }
  return n;
}

function envOpenAIPartial(env: EnvSource): Partial<ProviderConfig> {
  const out: Partial<ProviderConfig> = {};
  if (env.OPENAI_API_KEY) out.apiKey = env.OPENAI_API_KEY;
  if (env.OPENAI_BASE_URL && env.OPENAI_BASE_URL.trim().length > 0) {
    out.baseURL = env.OPENAI_BASE_URL;
  }
  const maxTok = parsePositiveInt(env.AI_RELAY_MAX_OUTPUT_TOKENS);
  if (maxTok !== undefined) out.maxOutputTokens = maxTok;
  const timeoutMs = parsePositiveInt(env.AI_RELAY_REQUEST_TIMEOUT_MS);
  if (timeoutMs !== undefined) out.requestTimeoutMs = timeoutMs;
  return out;
}

function materialiseId(p: ProviderConfig): ProviderConfig {
  if (p.id && p.id.length > 0) return p;
  return { ...p, id: `${p.provider}_${p.capability}` };
}

function withDefaults(p: ProviderConfig): ProviderConfig {
  return {
    ...p,
    maxOutputTokens: p.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    requestTimeoutMs: p.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function buildFromArgsAndEnv(args: ArgsSource, env: EnvSource): RelayConfig {
  const envPartial = envOpenAIPartial(env);
  const provider = args.provider ?? "openai";
  const capability = args.capability ?? "chat";
  const merged: Record<string, unknown> = {
    provider,
    capability,
    // env first, args overrides
    ...envPartial,
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
    ...(args.baseURL !== undefined ? { baseURL: args.baseURL } : {}),
    ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
    ...(args.requestTimeoutMs !== undefined ? { requestTimeoutMs: args.requestTimeoutMs } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
  };

  const parsed = providerConfigSchema.safeParse(merged);
  if (!parsed.success) throw redactZodError("Invalid config", parsed.error);
  return { providers: [withDefaults(materialiseId(parsed.data))] };
}

function buildFromEnvOnly(env: EnvSource): RelayConfig {
  const envPartial = envOpenAIPartial(env);
  const merged = {
    provider: "openai" as const,
    capability: "chat" as const,
    ...envPartial,
  };
  const parsed = providerConfigSchema.safeParse(merged);
  if (!parsed.success) throw redactZodError("Invalid config", parsed.error);
  return { providers: [withDefaults(materialiseId(parsed.data))] };
}

function buildFromFile(file: string, env: EnvSource | undefined): RelayConfig {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const cause = e instanceof Error ? e.message : "unknown error";
    throw new Error(`Cannot read config file ${file}: ${cause}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Never echo the file body — it may contain secrets.
    throw new Error(`Invalid config file ${file}: not valid JSON`);
  }

  const parsed = relayConfigSchema.safeParse(json);
  if (!parsed.success) throw redactZodError(`Invalid config file ${file}`, parsed.error);

  const envPartial = env ? envOpenAIPartial(env) : {};
  const filled = parsed.data.providers.map((p) => {
    const merged: ProviderConfig = {
      ...p,
      apiKey: p.apiKey || envPartial.apiKey || p.apiKey,
      ...(p.baseURL
        ? { baseURL: p.baseURL }
        : envPartial.baseURL
          ? { baseURL: envPartial.baseURL }
          : {}),
    };
    return withDefaults(materialiseId(merged));
  });

  return { providers: filled };
}

export function loadConfig(source: LoadConfigSource): RelayConfig {
  const { env, file, args } = source;

  if (file !== undefined) {
    return buildFromFile(file, env);
  }

  if (args && args.provider !== undefined) {
    return buildFromArgsAndEnv(args, env ?? {});
  }

  if (env?.OPENAI_API_KEY) {
    return buildFromEnvOnly(env);
  }

  throw new Error(
    "loadConfig: no providers resolved — provide args.provider, file, or set OPENAI_API_KEY in env",
  );
}
