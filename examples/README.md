# Examples

Each example ships a committed smoke test that runs without network access
and ends with `=== PASS ===` on success.

| Example | Pattern | Smoke command |
|---|---|---|
| [`stdio/`](./stdio) | Single-tool stdio MCP server for Claude Desktop | `pnpm --filter @example/stdio smoke` |
| [`multi-upstream/`](./multi-upstream) | One MCP server, multiple OpenAI-compatible upstreams | `pnpm --filter @example/multi-upstream smoke` |
| [`cloudflare-workers/`](./cloudflare-workers) | Remote MCP over SSE on Workers (`agents/mcp`) | `pnpm --filter @example/cloudflare-workers smoke` |
| [`vercel/`](./vercel) | Community-supported Vercel deploy recipe | `bash examples/vercel/scripts/smoke.sh` |

Run all of them sequentially from the repo root:

```bash
pnpm examples:smoke
```

The Cloudflare Workers smoke needs `wrangler` and is skipped when
`SKIP_CF_SMOKE=1`; CI sets this because `wrangler dev` is heavy and
network-bound.
