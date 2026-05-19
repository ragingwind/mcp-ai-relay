# runtime-fixtures

Self-contained fixtures used by the runtime-matrix CI workflow
(`.github/workflows/runtime-matrix.yml`) and by the local `pnpm test:runtime`
script.

## Layout

| Fixture | Used by | What it proves |
|---|---|---|
| `smoke-node/` | Node matrix job (20.10.0, 20.x, 22.x, 24.x) + local `pnpm test:runtime` | The packed tarball installs and imports cleanly on every supported Node minor; no side-effects at import. |
| `smoke-bun/` | Bun job | The packed tarball installs and imports cleanly on Bun. |
| `cjs-require/` | ESM-only assertion job | `require('ai-relay')` from a CJS context fails with a clear ESM-only error (or, on Node 22+ with `require(esm)`, succeeds with the documented shape). See `cjs-require/README.md`. |
| `typecheck-bundler/` | Publish-contract test (`packages/ai-relay/tests/integration/pack-contract.test.ts`) | `ai-relay` types resolve under `moduleResolution: "bundler"` for every documented subpath. |
| `typecheck-nodenext/` | Publish-contract test | `ai-relay` types resolve under `moduleResolution: "nodenext"` for every documented subpath. |

## Provider SDK dependencies

`smoke-node/` and `smoke-bun/` simulate an **OpenAI consumer**: they declare
`openai` in their `package.json` `dependencies` so `npm install <tarball>`
pulls in the SDK alongside `ai-relay` exactly as a real OpenAI consumer
would. Without this, the optional `peerDependenciesMeta.openai` entry in
`ai-relay/package.json` leaves the consumer with `ai-relay/dist/openai/chat.js`
unable to resolve `openai` → `ERR_MODULE_NOT_FOUND`.

When adding a new provider fixture (e.g., `smoke-node-anthropic/`), declare
the corresponding peer SDK explicitly in its `package.json` so the fixture
maps to a single consumer shape.

`cjs-require/` only `require()`s the root `ai-relay` entry (not the
provider subpaths) so it does not need any provider SDK declared.

## smoke duplication

`smoke-node/smoke.mjs` and `smoke-bun/smoke.mjs` are byte-for-byte
identical today. They are duplicated rather than shared so that:

- Each runtime cell is self-contained — adding a new runtime (Deno, Cloudflare
  Workers) means copying one of these and editing it, not modifying a shared
  file with growing runtime branches.
- A runtime-specific divergence (e.g. Bun-only API check) can be added
  without affecting the others.

If the cells stay identical for a sustained period across 3+ runtimes the
duplication is cheap to collapse later.

## Adding a runtime cell

1. Copy `smoke-node/` to `smoke-<runtime>/`. Edit the SENTINEL string and any
   runtime-specific assertions.
2. Add a new job to `.github/workflows/runtime-matrix.yml` that installs the
   runtime, packs the SDK, installs the tarball into the fixture, and runs
   the smoke.
3. Update the table above.
