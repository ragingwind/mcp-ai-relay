// Bearer-token verification — portable across runtimes.
//
// Returns `true` only when both `actual` and `expected` are non-empty,
// have equal byte-length, and match every byte. Comparison runs in
// constant time using a manual XOR-OR loop with no early termination,
// so the function is safe on any runtime (Node, Bun, Deno, Cloudflare
// Workers without `nodejs_compat`).
//
// Why a manual loop instead of `node:crypto.timingSafeEqual`:
//   - `node:crypto` requires Workers' `nodejs_compat` flag.
//   - For ≤32-byte secrets, an XOR-OR accumulation matches the same
//     constant-time guarantee that `timingSafeEqual` provides.
//   - Keeping the SDK runtime-agnostic at this layer means consumers
//     don't need to opt into Node compatibility just to validate a
//     bearer token.
//
// Building the consumer's auth-info shape (clientId, scopes, etc.) is
// the consumer's responsibility — this primitive returns a boolean only,
// so it composes cleanly with `mcp-handler`'s `withMcpAuth`, a Hono
// middleware, or any other gate.
//
// Length-mismatch defense: returning false BEFORE the loop when lengths
// differ leaks 1 bit (the lengths differ), which is identical to what
// `timingSafeEqual` does — it throws on length mismatch.

const encoder = new TextEncoder();

export function verifyBearer(
  actual: string | undefined,
  expected: string | undefined,
): boolean {
  if (!actual || !expected) return false;

  const a = encoder.encode(actual);
  const b = encoder.encode(expected);
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= (a[i] as number) ^ (b[i] as number);
  }
  return mismatch === 0;
}
