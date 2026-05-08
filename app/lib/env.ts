// HTTP-only environment parser for the relay app.
//
// This is the relay app's private env schema — it lives in `app/lib/`
// because `RELAY_AUTH_TOKEN` (≥ 32 bytes) is an HTTP-server-specific
// concern, NOT of every consumer that embeds the `ai-relay` SDK in a
// stdio launcher, Cloudflare Worker, or Hono server. The other keys
// share the `AI_RELAY_*` namespace with the SDK so a single env
// vocabulary serves both the CLI and the HTTP transport.
//
// Side-effect-free module: importing this file does NOT read process.env.
// Consumers (the route file, scripts, tests) call `parseEnv(source)`
// explicitly with whatever object they want validated.
//
// Error messages MUST never echo any env var value. Failure messages
// are built strictly from `issue.path` + `issue.message` text.

import { z } from "zod";

// Schema is intentionally non-strict: process.env carries unrelated keys
// (PATH, HOME, etc.). AI_RELAY_API_KEY.min(1) enforces the migration error
// loudly instead of silently defaulting to an empty key that would fail
// with an obscure upstream 401.
const envSchema = z.object({
  AI_RELAY_API_KEY: z.string().min(1, "AI_RELAY_API_KEY is required"),
  AI_RELAY_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim().length === 0 ? undefined : v),
    z.string().url().optional(),
  ),
  RELAY_AUTH_TOKEN: z
    .string()
    .refine((s) => Buffer.byteLength(s, "utf8") >= 32, "must be at least 32 bytes"),
  AI_RELAY_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  AI_RELAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});

export type Env = z.infer<typeof envSchema>;

// Permissive env-shaped input. We deliberately do NOT type this as
// `NodeJS.ProcessEnv` because `next/types/global.d.ts` augments that
// interface with a required `NODE_ENV` key — `parseEnv` doesn't consume
// `NODE_ENV` and forcing tests to set it would be noise. `process.env`
// itself satisfies this signature, so callers passing it still type-check.
export type EnvSource = Record<string, string | undefined>;

// Mirrors redactZodError in packages/ai-relay/src/config.ts; keep the two in lock-step.
export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const failures = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment: ${failures}`);
}
