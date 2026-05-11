# mock-openai test fixture

A preset-driven mock of the OpenAI Chat Completions endpoint. Used by tests
that need to exercise the real `openai` SDK + the relay's `createOpenAIClient`
fetch capture against a controlled upstream — i.e. anywhere MSW cannot reach
(child processes, separate Node workers) or where we need TCP-level control
(packet splitting, mid-stream socket destruction).

## Why `node:http`, not Hono

The dev-plan originally specified Hono. The fixture lives under `tests/fixtures/`,
which is consumed by both `packages/ai-relay/tests/` and root-level `tests/`.
Neither test surface has `hono` as a direct dependency (only `app/` does),
and adding it as a root devDependency just to host one mock would expand the
surface area. `node:http` matches the existing pattern in
`packages/ai-relay/tests/integration/bin-tarball.test.ts` and is sufficient for
the small set of behaviors we exercise here.

## API

```ts
import { startMockOpenAI } from "../../tests/fixtures/mock-openai";

const mock = await startMockOpenAI({ preset: "happy" });
process.env.AI_RELAY_BASE_URL = mock.baseURL;        // http://127.0.0.1:<port>/v1
// run code under test ...
await mock.close();
```

`startMockOpenAI(opts)` accepts:

- `port` — bind port (default `0` = OS picks a free port).
- `preset` — one of the presets below (default `"happy"`).
- `handler(req, res)` — fully custom request handler; when supplied, `preset`
  is ignored. Use this for one-off shapes the preset set doesn't cover.

`mock.baseURL` is the path the OpenAI SDK targets: it appends
`/chat/completions` to whatever baseURL you hand it.

## Presets

| preset | behavior |
|---|---|
| `happy` | SSE with `"Hello"` + `" "` + `"world"` deltas, final `usage`, then `[DONE]`. Accumulated content is `"Hello world"`. |
| `401` | `401` JSON error body matching OpenAI's shape (`{error:{message}}`). |
| `429` | `429` JSON error + `Retry-After: 5` header. |
| `500` | `500` JSON error body. |
| `timeout` | Writes nothing; holds the connection open. Use to trigger the SDK's `timeout` / consumer's `AbortSignal`. |
| `stream-mid-error` | 2 valid delta chunks (`"par"`, `"tial"`), then destroys the socket without `[DONE]`. |
| `chunk-boundary` | A single SSE frame split across two TCP writes 10 ms apart, exercising the SDK's frame reassembly path. |

## Adding a new preset

1. Add the preset name to the `Preset` union in `index.ts`.
2. Add a `case` in `handleByPreset` returning a small `send<Preset>(res)` function.
3. Document it in the table above.

Keep the preset surface small. If you need something exotic (custom headers,
multi-tenant routing, body-driven branching), use the `handler` override
instead of growing the enum.
