// Stage 4R: the SHA-256 digest of an AI explanation context's exact canonical
// bytes, kept apart from the pure projection (explanationContext.ts) because
// it uses the platform's Web Crypto (available in the renderer, and in the
// Electron main process's Node). No new dependency, no hand-written
// cryptography. A digest identifies bytes; it is not consent or
// authorization by itself.
import { canonicalBytes } from "./explanationContext";

/** Lower-case hex SHA-256 of the UTF-8 bytes of `json` (a context's canonical JSON). */
export async function digestCanonicalJson(json: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", canonicalBytes(json)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
