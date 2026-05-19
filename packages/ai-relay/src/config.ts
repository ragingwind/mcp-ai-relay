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

export type Provider = "openai" | "anthropic";
export type Capability = "chat" | "messages";

const stopSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const openaiConfigSchema = z
  .object({
    id: z.string().min(1).optional(),
    provider: z.literal("openai"),
    capability: z.literal("chat").default("chat"),
    apiKey: z.string().min(1),
    baseURL: z.string().url().optional(),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: stopSchema.optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    description: z.string().optional(),
  })
  .strict();

const anthropicConfigSchema = z
  .object({
    id: z.string().min(1).optional(),
    provider: z.literal("anthropic"),
    capability: z.literal("messages").default("messages"),
    apiKey: z.string().min(1),
    baseURL: z.string().url().optional(),
    model: z.string().min(1),
    temperature: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: stopSchema.optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    description: z.string().optional(),
  })
  .strict();

const providerConfigSchema = z.discriminatedUnion("provider", [
  openaiConfigSchema,
  anthropicConfigSchema,
]);

const relayConfigSchema = z
  .object({
    providers: z.array(providerConfigSchema).min(1),
  })
  .strict();

export type OpenAIProviderConfig = z.infer<typeof openaiConfigSchema>;
export type AnthropicProviderConfig = z.infer<typeof anthropicConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type RelayConfig = z.infer<typeof relayConfigSchema>;

export type EnvSource = Record<string, string | undefined>;

export type ArgsSource = {
  provider?: Provider;
  capability?: Capability;
  id?: string;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  requestTimeoutMs?: number;
  description?: string;
};

export type LoadConfigSource = {
  env?: EnvSource;
  file?: string;
  args?: ArgsSource;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// Mirrors redactZodError in app/lib/env.ts; keep the two in lock-step.
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
    throw new Error("Invalid positive integer (env value redacted)");
  }
  return n;
}

function parseFloatInRange(value: string | undefined, lo: number, hi: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < lo || n > hi) {
    throw new Error("Invalid number in range (env value redacted)");
  }
  return n;
}

function parseStopList(value: string | undefined): string | string[] | undefined {
  if (value === undefined || value === "") return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return parts;
}

type EnvPartial = Partial<Record<string, unknown>>;

function envCommonPartial(env: EnvSource): EnvPartial {
  const out: EnvPartial = {};
  if (env.AI_RELAY_API_KEY) out.apiKey = env.AI_RELAY_API_KEY;
  if (env.AI_RELAY_BASE_URL && env.AI_RELAY_BASE_URL.trim().length > 0) {
    out.baseURL = env.AI_RELAY_BASE_URL;
  }
  if (env.AI_RELAY_MODEL && env.AI_RELAY_MODEL.length > 0) {
    out.model = env.AI_RELAY_MODEL;
  }
  const maxTokens = parsePositiveInt(env.AI_RELAY_MAX_TOKENS);
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  const topP = parseFloatInRange(env.AI_RELAY_TOP_P, 0, 1);
  if (topP !== undefined) out.top_p = topP;
  const stop = parseStopList(env.AI_RELAY_STOP);
  if (stop !== undefined) out.stop = stop;
  const timeoutMs = parsePositiveInt(env.AI_RELAY_REQUEST_TIMEOUT_MS);
  if (timeoutMs !== undefined) out.requestTimeoutMs = timeoutMs;
  return out;
}

function envOpenAIPartial(env: EnvSource): EnvPartial {
  const out = envCommonPartial(env);
  const temperature = parseFloatInRange(env.AI_RELAY_TEMPERATURE, 0, 2);
  if (temperature !== undefined) out.temperature = temperature;
  return out;
}

function envAnthropicPartial(env: EnvSource): EnvPartial {
  const out = envCommonPartial(env);
  const temperature = parseFloatInRange(env.AI_RELAY_TEMPERATURE, 0, 1);
  if (temperature !== undefined) out.temperature = temperature;
  return out;
}

const envPartialByProvider: Record<Provider, (env: EnvSource) => EnvPartial> = {
  openai: envOpenAIPartial,
  anthropic: envAnthropicPartial,
};

function defaultCapability(provider: Provider): Capability {
  return provider === "anthropic" ? "messages" : "chat";
}

function materialiseId(p: ProviderConfig): ProviderConfig {
  if (p.id && p.id.length > 0) return p;
  return { ...p, id: `${p.provider}_${p.capability}` };
}

function withDefaults(p: ProviderConfig): ProviderConfig {
  return {
    ...p,
    requestTimeoutMs: p.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function buildFromArgsAndEnv(args: ArgsSource, env: EnvSource): RelayConfig {
  const provider: Provider = args.provider ?? "openai";
  const envPartial = envPartialByProvider[provider](env);
  const capability: Capability = args.capability ?? defaultCapability(provider);
  const merged: Record<string, unknown> = {
    provider,
    capability,
    // env first, args overrides
    ...envPartial,
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
    ...(args.baseURL !== undefined ? { baseURL: args.baseURL } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}),
    ...(args.top_p !== undefined ? { top_p: args.top_p } : {}),
    ...(args.stop !== undefined ? { stop: args.stop } : {}),
    ...(args.requestTimeoutMs !== undefined ? { requestTimeoutMs: args.requestTimeoutMs } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
  };

  const parsed = providerConfigSchema.safeParse(merged);
  if (!parsed.success) throw redactZodError("Invalid config", parsed.error);
  return { providers: [withDefaults(materialiseId(parsed.data))] };
}

function buildFromEnvOnly(env: EnvSource): RelayConfig {
  const envPartial = envPartialByProvider.openai(env);
  const merged = {
    provider: "openai" as const,
    capability: "chat" as const,
    ...envPartial,
  };
  const parsed = providerConfigSchema.safeParse(merged);
  if (!parsed.success) throw redactZodError("Invalid config", parsed.error);
  return { providers: [withDefaults(materialiseId(parsed.data))] };
}

function applyArgsOverrides(p: ProviderConfig, args: ArgsSource): ProviderConfig {
  // Match contract: provider must equal; if args.capability is set it must equal too.
  if (args.provider !== undefined && args.provider !== p.provider) return p;
  if (args.capability !== undefined && args.capability !== p.capability) return p;
  return {
    ...p,
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
    ...(args.baseURL !== undefined ? { baseURL: args.baseURL } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(args.max_tokens !== undefined ? { max_tokens: args.max_tokens } : {}),
    ...(args.top_p !== undefined ? { top_p: args.top_p } : {}),
    ...(args.stop !== undefined ? { stop: args.stop } : {}),
    ...(args.requestTimeoutMs !== undefined ? { requestTimeoutMs: args.requestTimeoutMs } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
  };
}

function buildFromFile(
  file: string,
  env: EnvSource | undefined,
  args: ArgsSource | undefined,
): RelayConfig {
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

  const filled = parsed.data.providers.map((p) => {
    const envPartial = env ? envPartialByProvider[p.provider](env) : {};
    const withEnv: ProviderConfig = {
      ...p,
      apiKey: p.apiKey,
      ...(p.baseURL
        ? { baseURL: p.baseURL }
        : envPartial.baseURL
          ? { baseURL: envPartial.baseURL as string }
          : {}),
    };
    const merged = args ? applyArgsOverrides(withEnv, args) : withEnv;
    return withDefaults(materialiseId(merged));
  });

  return { providers: filled };
}

export function loadConfig(source: LoadConfigSource): RelayConfig {
  const { env, file, args } = source;

  if (file !== undefined) {
    return buildFromFile(file, env, args);
  }

  if (args && args.provider !== undefined) {
    return buildFromArgsAndEnv(args, env ?? {});
  }

  if (env?.AI_RELAY_API_KEY) {
    return buildFromEnvOnly(env);
  }

  throw new Error(
    "loadConfig: no providers resolved — provide args.provider, file, or set AI_RELAY_API_KEY in env",
  );
}
