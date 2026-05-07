// ai-relay — main entry.
//
// Common surface shared across all provider subpaths. Provider-specific
// registrars live under their own subpaths (e.g. `ai-relay/openai`).

export { verifyBearer } from "./auth.js";
