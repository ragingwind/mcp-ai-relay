// CommonJS require() smoke for the ESM-only `ai-relay` package.
//
// On Node < 22 we expect a clean `ERR_REQUIRE_ESM` (or message containing
// "ESM"). On Node >= 22 the `require(esm)` flag may be enabled and the call
// can succeed — in that case we assert the returned module shape instead of
// asserting the throw.
//
// Either way the smoke succeeds. The point is to PROVE the failure mode is
// clear, not to mandate that the call throw.

let mod;
let caughtErr;
try {
  mod = require("ai-relay");
} catch (err) {
  caughtErr = err;
}

if (caughtErr) {
  const code = caughtErr.code ?? "";
  const msg = String(caughtErr.message ?? "");
  // Accept any of the canonical ESM-only failure modes:
  //  - `ERR_REQUIRE_ESM`: classic Node < 22 CJS-requiring-ESM error.
  //  - `ERR_PACKAGE_PATH_NOT_EXPORTED`: our exports map has only an `import`
  //    condition; CJS can't resolve any condition, so Node raises this.
  //  - Message text mentioning ESM.
  const looksESM =
    code === "ERR_REQUIRE_ESM" ||
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
    /ESM/i.test(msg) ||
    /import\(\) which is available/.test(msg) ||
    /No "exports" main defined/.test(msg);
  if (!looksESM) {
    console.error("FAIL: require() threw but error did not mention ESM:", caughtErr);
    process.exit(1);
  }
  console.log(`OK: require('ai-relay') threw ESM-only error (code=${code || "—"})`);
  process.exit(0);
}

// require() succeeded: assert the module exposes the expected named exports.
if (typeof mod.verifyBearer !== "function") {
  console.error("FAIL: require() succeeded but verifyBearer is missing");
  process.exit(1);
}
if (typeof mod.loadConfig !== "function") {
  console.error("FAIL: require() succeeded but loadConfig is missing");
  process.exit(1);
}
console.log("OK: require('ai-relay') succeeded under Node require(esm); shape verified");
