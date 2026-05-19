// Anthropic client factory + per-client request scope.
//
// Mirrors the OpenAI client factory. Each call to `createAnthropicClient`
// produces a fresh `Anthropic` instance and its own `AsyncLocalStorage`
// scope. There is no module-level singleton.
//
// `requestScope` carries an optional captured upstream-error body across
// the SDK call boundary so the error mapper can surface a redacted
// snippet on 5xx responses without touching the SDK internals.
//
// Streaming calls additionally pass `maxRetries: 0` at the call site to
// prevent mid-stream replays from emitting duplicated text.

import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";
import { redactSecret, type VerboseLogger } from "../bin/logger.js";

const UPSTREAM_BODY_MAX_CHARS = 512;

export type RequestScope = AsyncLocalStorage<{ upstreamBody?: string }>;

export interface AnthropicClientConfig {
  /** Anthropic API key. Required. */
  apiKey: string;
  /** Anthropic base URL override. */
  baseURL?: string;
  /** Per-request timeout in ms. Default 60_000. */
  requestTimeoutMs?: number;
  /** Optional verbose logger. When enabled, emits `anthropic-http-request`
   *  and `anthropic-http-response` events with the Authorization header
   *  + x-api-key value redacted. SSE bodies are not consumed; their
   *  content surfaces via `anthropic-stream-*` events in `messages.ts`. */
  logger?: VerboseLogger;
}

export interface CreatedAnthropicClient {
  client: Anthropic;
  requestScope: RequestScope;
}

export function createAnthropicClient(config: AnthropicClientConfig): CreatedAnthropicClient {
  const requestScope: RequestScope = new AsyncLocalStorage();
  const baseFetch: typeof fetch = globalThis.fetch.bind(globalThis);
  const logger = config.logger;

  const captureFetch: typeof fetch = async (input, init) => {
    if (logger?.enabled) {
      logRequest(logger, input, init, config.apiKey);
    }
    const res = await baseFetch(input, init);
    if (logger?.enabled) {
      await logResponse(logger, res, config.apiKey);
    }
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

  const client = new Anthropic({
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

function logRequest(
  logger: VerboseLogger,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  apiKey: string,
): void {
  try {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method =
      init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET");
    const headers = collectHeaders(
      init?.headers ??
        (typeof input !== "string" && !(input instanceof URL) ? input.headers : undefined),
      apiKey,
    );
    const body = init?.body;
    const bodyDump = renderBody(body, apiKey);
    logger.log("anthropic-http-request", { method, url, headers, body: bodyDump });
  } catch {
    /* logging never blocks delivery */
  }
}

async function logResponse(logger: VerboseLogger, res: Response, apiKey: string): Promise<void> {
  try {
    const ct = res.headers.get("content-type") ?? "";
    let body: unknown;
    if (ct.includes("text/event-stream")) {
      body = "<sse stream — see anthropic-stream-* events>";
    } else {
      try {
        const text = await res.clone().text();
        const redacted = redact(text, apiKey);
        body = tryParseJson(redacted);
      } catch {
        body = "<unreadable response body>";
      }
    }
    logger.log("anthropic-http-response", {
      status: res.status,
      statusText: res.statusText,
      body,
    });
  } catch {
    /* logging never blocks delivery */
  }
}

function collectHeaders(h: unknown, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (h === null || h === undefined) return out;
  const apply = (k: string, v: string) => {
    const lower = k.toLowerCase();
    if (lower === "authorization") {
      const bearerMatch = v.match(/^(\s*Bearer\s+)(.+)$/i);
      if (bearerMatch) {
        out[k] = `${bearerMatch[1]}${redactSecret(bearerMatch[2])}`;
      } else {
        out[k] = redactSecret(v);
      }
      return;
    }
    if (lower === "x-api-key") {
      out[k] = redactSecret(v);
      return;
    }
    out[k] = apiKey && v.includes(apiKey) ? v.split(apiKey).join("[REDACTED]") : v;
  };
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    h.forEach((v, k) => {
      apply(k, v);
    });
  } else if (Array.isArray(h)) {
    for (const entry of h as Array<[string, string]>) {
      apply(entry[0], entry[1]);
    }
  } else if (typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) apply(k, String(v));
  }
  return out;
}

function renderBody(body: unknown, apiKey: string): unknown {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return tryParseJson(redact(body, apiKey));
  if (body instanceof ArrayBuffer) return `<ArrayBuffer ${body.byteLength}B>`;
  if (ArrayBuffer.isView(body)) return `<TypedArray ${(body as ArrayBufferView).byteLength}B>`;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== "undefined" && body instanceof FormData) return "<FormData>";
  if (typeof Blob !== "undefined" && body instanceof Blob) return `<Blob ${body.size}B>`;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
    return "<ReadableStream>";
  return "<unknown body>";
}

function tryParseJson(s: string): unknown {
  const trimmed = s.trimStart();
  if (trimmed.length === 0) return s;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return s;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
}
