# cjs-require runtime fixture

Validates that `require('ai-relay')` from a CommonJS context produces a
clear, ESM-only failure mode.

## Why this fixture

`ai-relay` ships as ESM-only (`"type": "module"`, `exports` map with
`"import"` only, no `"require"` condition). A CommonJS consumer who tries
to `require()` it should hit a clear error so the migration path is
obvious — silently importing a stale partial shape would be worse.

Node 22 added experimental `require(esm)` support. When the flag is on,
`require()` may succeed. This fixture handles both outcomes:

- If `require()` throws, the error must be one of the canonical ESM-only
  failures: `ERR_REQUIRE_ESM` (classic), `ERR_PACKAGE_PATH_NOT_EXPORTED`
  (raised when the `exports` map exposes only an `import` condition, so
  CJS can't resolve anything), or a message containing `"ESM"` /
  `"No \"exports\" main defined"`.
- If `require()` succeeds, the returned module must expose the documented
  named exports.

Either outcome passes the smoke. We do NOT require throwing — that would
fail on Node 22+ with `require(esm)` enabled.
