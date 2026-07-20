// Hash utility tests: SHA-256 content hash generation (FR-IG-5).
import { describe, it, expect } from "vitest";
import { computeContentHash } from "../src/hash.js";

describe("computeContentHash", () => {
  it("produces deterministic SHA-256 hex for same bytes", () => {
    const buf = Buffer.from("Document Intelligence RAG test content");
    const h1 = computeContentHash(buf);
    const h2 = computeContentHash(buf);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hashes for different content", () => {
    const a = computeContentHash(Buffer.from("Alpha"));
    const b = computeContentHash(Buffer.from("Beta"));
    expect(a).not.toBe(b);
  });

  it("handles empty buffer", () => {
    const h = computeContentHash(Buffer.from([]));
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});
