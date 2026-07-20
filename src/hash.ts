// Content hash utility: SHA-256 over file bytes (FR-IG-5).
// No async here; caller reads bytes and passes them in.
import { createHash } from "node:crypto";

export function computeContentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
