// Zod-validated environment parser.
//
// Side-effect-free module: importing this file does NOT read process.env.
// Consumers (the route file, scripts, tests) call `parseEnv(source)`
// explicitly with whatever object they want validated. Keeping import
// time clean is the prerequisite for embedding the SDK in environments
// that don't expose `process.env` at module load (Cloudflare Workers,
// Deno, stdio launchers).
//
// Error messages MUST never echo any env var value. Failure messages
// are built strictly from `issue.path` + `issue.message` text.

import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim().length === 0 ? undefined : v),
    z.string().url().optional(),
  ),
  RELAY_AUTH_TOKEN: z
    .string()
    .refine((s) => Buffer.byteLength(s, "utf8") >= 32, "must be at least 32 bytes"),
  MAX_OUTPUT_TOKENS_CEILING: z.coerce.number().int().positive().default(4096),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});

export type Env = z.infer<typeof envSchema>;

// Permissive env-shaped input. We deliberately do NOT type this as
// `NodeJS.ProcessEnv` because `next/types/global.d.ts` augments that
// interface with a required `NODE_ENV` key — `parseEnv` doesn't consume
// `NODE_ENV` and forcing tests to set it would be noise. `process.env`
// itself satisfies this signature, so callers passing it still type-check.
export type EnvSource = Record<string, string | undefined>;

export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  // Redacted error: only path + message text from each zod issue. Never include
  // `issue.input` / `issue.received` / any value-derived strings.
  const failures = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment: ${failures}`);
}
