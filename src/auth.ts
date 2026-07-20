// HMAC-SHA256 authentication for the query endpoint (§16, NFR-SE-1).
//
// Every production request carries X-Timestamp + X-Signature headers. Unsigned
// requests are rejected before retrieval, grounding, or generation. Does NOT
// implement OAuth, JWT, or session cookies. HMAC is enough for stateless
// machine-to-machine queries.
//
// Signature = HMAC-SHA256(secret, timestamp || body)
// where timestamp is unix epoch seconds as a string.
//
// Headers:
//   X-Timestamp: <unix_seconds>
//   X-Signature: <base64_hmac>
//
// Rejects:
//   - missing headers
//   - timestamp older than the 5-minute replay window
//   - signature mismatch (constant-time compare)
import { createHmac, timingSafeEqual } from "crypto";

export interface VerifyOptions {
  timestamp: string;
  signature: string;
  body: string;
  secret: string;
  replayWindowSeconds?: number;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

const DEFAULT_REPLAY_WINDOW = 300; // 5 minutes

export function verifyHmac(opts: VerifyOptions): VerifyResult {
  const replayWindow = opts.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW;

  // required fields
  if (!opts.timestamp || !opts.signature || !opts.secret) {
    return { valid: false, reason: "missing_auth_header" };
  }

  // timestamp must be numeric
  const ts = parseInt(opts.timestamp, 10);
  if (Number.isNaN(ts)) {
    return { valid: false, reason: "invalid_timestamp" };
  }

  // replay window
  const now = Math.floor(Date.now() / 1000);
  if (now - ts > replayWindow) {
    return { valid: false, reason: "timestamp_expired" };
  }
  if (ts > now + 60) {
    // clock skew: timestamp more than 60s in the future
    return { valid: false, reason: "timestamp_future" };
  }

  // expected signature: HMAC(secret, timestamp || body)
  const payload = `${opts.timestamp}${opts.body}`;
  const expected = createHmac("sha256", opts.secret)
    .update(payload, "utf8")
    .digest("base64");

  // constant-time compare
  const sigBuf = Buffer.from(opts.signature, "base64");
  const expBuf = Buffer.from(expected, "base64");

  if (sigBuf.length !== expBuf.length) {
    return { valid: false, reason: "signature_mismatch" };
  }

  if (!timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}

// Convenience: sign a request payload for testing or client scripts.
export function signHmac(secret: string, timestamp: number, body: string): string {
  const payload = `${timestamp}${body}`;
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64");
}
