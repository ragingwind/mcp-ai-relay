// Minimal dotenv parser: KEY=VALUE per line, # comments, blank lines,
// optional double or single quotes around the value. Anything else
// (export prefix, $VAR expansion, multi-line values, JSON literals)
// is rejected with a typed error that references the line number only —
// the file body never appears in error messages because it can hold
// secrets.

import { UsageError } from "./parse.js";

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      throw new UsageError(`env-file line ${i + 1}: 'export ' prefix is not supported`);
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new UsageError(`env-file line ${i + 1}: missing '='`);
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new UsageError(`env-file line ${i + 1}: invalid key`);
    }
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}
