// OpenAI client factory + per-client request scope.
//
// Each call to `createOpenAIClient` produces a fresh `OpenAI` instance and
// its own `AsyncLocalStorage` scope. There is no module-level singleton —
// consumers can register multiple distinct upstreams (OpenAI, Azure,
// vLLM, Ollama, AI Gateway, …) on the same MCP server, each with its
// own credentials and base URL.
//
// `requestScope` carries an optional captured upstream-error body across
// the SDK call boundary so the error mapper can surface a redacted
// snippet on 5xx responses without touching the OpenAI SDK internals.
// AsyncLocalStorage is supported on Node, Bun, Deno, and Cloudflare
// Workers (with `compatibility_flags = ["nodejs_compat"]`). Runtimes
// without it must accept that the upstream-body redaction is silently
// skipped — the SDK's own error message remains the fallback.
//
// Streaming calls additionally pass `maxRetries: 0` at the call site to
// prevent mid-stream replays from emitting duplicated text.

import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";

const UPSTREAM_BODY_MAX_CHARS = 512;

export type RequestScope = AsyncLocalStorage<{ upstreamBody?: string }>;

export interface OpenAIClientConfig {
  /** OpenAI API key. Required. */
  apiKey: string;
  /** OpenAI base URL override (Azure / vLLM / Ollama / AI Gateway / mock). */
  baseURL?: string;
  /** Per-request timeout in ms. Default 60_000. */
  requestTimeoutMs?: number;
}

export interface CreatedOpenAIClient {
  client: OpenAI;
  requestScope: RequestScope;
}

export function createOpenAIClient(config: OpenAIClientConfig): CreatedOpenAIClient {
  const requestScope: RequestScope = new AsyncLocalStorage();
  const baseFetch: typeof fetch = globalThis.fetch.bind(globalThis);

  const captureFetch: typeof fetch = async (input, init) => {
    const res = await baseFetch(input, init);
    if (!res.ok) {
      const store = requestScope.getStore();
      if (store) {
        try {
          const text = await res.clone().text();
          if (text) {
            store.upstreamBody = redact(text, config.apiKey).slice(0, UPSTREAM_BODY_MAX_CHARS);
          }
        } catch {
          /* body unreadable; SDK's own message remains the fallback */
        }
      }
    }
    return res;
  };

  const client = new OpenAI({
    apiKey: config.apiKey,
    timeout: config.requestTimeoutMs ?? 60_000,
    fetch: captureFetch,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });

  return { client, requestScope };
}

function redact(s: string, apiKey: string): string {
  if (!apiKey) return s;
  return s.split(apiKey).join("[REDACTED]");
}
