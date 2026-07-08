/**
 * Embedder unit tests — batching, retry, failure semantics.
 *
 * Satisfies: FR-EM-1 (batched embedding), FR-EM-4 (un-embedded remain re-runnable).
 */
import { describe, it, expect } from "vitest";
import { embedTexts, getEmbeddingConfigFromEnv } from "../src/embedder.js";

/**
 * CI passes a literal placeholder key when the secret is absent so other
 * pipeline config validation doesn't trip. Treat that sentinel (and the
 * obviously-missing case) as "no live key" so the network test is skipped
 * hermetically rather than timing out against the real embedding API.
 */
const PLACEHOLDER_KEYS = new Set([
  "",
  "placeholder-skipped",
  "placeholder",
  "skipped",
]);

function resolveLiveApiKey(): string | undefined {
  const key = process.env.EMBEDDING_PROVIDER_API_KEY ?? "";
  return PLACEHOLDER_KEYS.has(key) ? undefined : key;
}

describe("getEmbeddingConfigFromEnv", () => {
  it("provides sensible defaults when env is absent", () => {
    const cfg = getEmbeddingConfigFromEnv();
    expect(cfg.model).toBe("text-embedding-3-small");
    expect(cfg.batchSize).toBe(100);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.baseDelayMs).toBe(2000);
  });
});

describe("embedTexts (live API)", () => {
  const liveApiKey = resolveLiveApiKey();
  const liveTest = liveApiKey ? it : it.skip;

  liveTest(
    "embeds a batch of two short texts",
    async () => {
      const result = await embedTexts(
        ["A quick brown fox", "Lazy dog on a rug"],
        { apiKey: liveApiKey!, batchSize: 2 }
      );
      expect(result.succeeded.length).toBe(2);
      expect(result.failed.length).toBe(0);
      expect(result.succeeded[0]!.embedding.length).toBe(1536);
      expect(result.succeeded[0]!.embedModel).toBe("text-embedding-3-small");
      expect(result.succeeded[0]!.embedDims).toBe(1536);
    },
    30000
  );

  it("returns failed list when API key is invalid", async () => {
    const result = await embedTexts(["Hello"], {
      apiKey: "invalid_key_12345",
      maxRetries: 1,
      baseDelayMs: 100,
    });
    expect(result.failed.length).toBe(1);
    expect(result.succeeded.length).toBe(0);
  });
});
