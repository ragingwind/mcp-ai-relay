# CLI spawn harness

Real-subprocess test coverage for the `ai-relay` one-shot CLI
(`packages/ai-relay/src/bin/run.ts` → built to `dist/bin/cli.js`).

## One-shot vs stdio MCP

The bin is intentionally **one-shot**: parse argv → read stdin once →
invoke the tool handler → write JSON to stdout → exit. It does NOT
speak the long-lived stdio MCP protocol. See
`packages/ai-relay/README.md:82-88` and `examples/stdio/server.ts`
for the long-lived stdio pattern.

These tests verify behavior in the same shape as a real user pipeline
(`echo … | ai-relay openai chat -m gpt-4o-mini`) by spawning the
compiled bin under `node` and feeding it through OS pipes. MSW cannot
intercept requests from a spawned child, so a local HTTP server in
`mock-openai.ts` stands in for the OpenAI API and is selected via
`AI_RELAY_BASE_URL`.

## Files

- `spawn-harness.ts` — small wrapper around `child_process.spawn`. Hides
  the build-on-first-call dance, sanitizes `AI_RELAY_*` out of the
  parent env, supports chunked stdin and signal injection, enforces a
  hard timeout that escalates to `SIGKILL`.
- `mock-openai.ts` — kernel-assigned-port HTTP server that records
  requests and lets a test set per-case responses (status, body, delay,
  hang).
- `spawn.test.ts` — happy paths (H-\*), error/exit-code mapping (E-\*),
  argv/env handling (A-\*), and lifecycle/secret cases (R-\*).

## Harness API

```ts
import { runCli } from "./spawn-harness.js";
import { startMockOpenAI, defaultSseBody } from "./mock-openai.js";

const mock = await startMockOpenAI();
mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));

const r = await runCli({
  args: ["openai", "chat", "-m", "gpt-4o-mini", "ping"],
  env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
});
// r: { status, signal, stdout, stderr, durationMs }
```

`SpawnOpts` also supports `input` (one-shot stdin write), `inputStream`
(chunked), `killAfterMs` + `killSignal`, and `timeoutMs` (default
10 s; on expiry the child is `SIGKILL`-ed and `status === null`).

## Adding a test

1. Pick a behavior zone (happy / edge / error / lifecycle).
2. Reset `mock.requests` and call `mock.setResponse(...)` for the
   case-specific upstream behavior.
3. Call `runCli` with `args` + `env`. Assert on `r.status`, parsed
   `r.stdout`, and `r.stderr`.
4. Never assert on `toBeTruthy()` alone — assert exact codes, exact
   substrings, and exact JSON shape.

## Why not MSW for the bin

MSW patches `globalThis.fetch` in the test process. A spawned child has
its own process and its own `fetch`, so MSW handlers never see the
child's requests. The local HTTP server is the simplest deterministic
substitute.

## Divergence from issue body

- **Error codes use underscores, not hyphens.** The actual mapping in
  `packages/ai-relay/src/openai/chat.ts:130-170` returns `auth`,
  `rate_limited`, `bad_request`, `upstream_error`, `context_length`,
  `content_policy`. The issue body suggested hyphenated forms
  (`rate-limited`, `upstream-server-error`); tests assert the real
  underscore-form codes.
- **No dedicated `timeout` error code.** Request timeouts surface as
  an `OpenAI.APIError` with no status, which maps to `upstream_error`
  (`chat.ts:162-164`). E-4 asserts that.
- **E-7 exits 1, not 2.** `schema.parse` runs inside the handler
  before the `runOnce` try/catch. A `ZodError` propagates up through
  `run()` (no try/catch around `bundle.handler(...)` in `run.ts:163`)
  and is caught by the top-level `.then(..., err => process.exit(1))`
  in `cli.ts:13-16`. The error message is written to stderr by the
  same handler. Test asserts status 1 and that the ZodError surfaces.
- **H-4 / H-5 are negative assertions.** `parse.ts:37-45` enumerates
  the value flags — `--name` and `--description` are not in the set,
  so they exit 2 with `unknown flag: --<key>`. Tests document this as
  the current contract.
