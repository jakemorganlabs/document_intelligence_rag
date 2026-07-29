// Embedder: batched OpenAI embedding API with retry (FR-EM-1..4).
//
// Three-attempt retry with exponential backoff (2s / 4s / 8s). On exhaustion,
// returns the affected chunks so the caller can record them as un-embedded and
// re-run later (FR-EM-4).
import OpenAI from "openai";

export interface EmbeddingConfig {
  provider: "openai";
  model: string;
  apiKey: string;
  batchSize: number;
  maxRetries: number;
  baseDelayMs: number;
}

export interface EmbeddedChunk {
  text: string;
  embedding: number[];
  embedModel: string;
  embedDims: number;
  embeddedAt: string;
}

export interface EmbedResult {
  succeeded: EmbeddedChunk[];
  // texts that failed after retries
  failed: string[];
}

const DEFAULT_CONFIG: EmbeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
  apiKey: "",
  batchSize: 100,
  maxRetries: 3,
  baseDelayMs: 2000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: process.env.EMBEDDING_BASE_URL || undefined,
  });
}

// Embed a batch of text strings. Returns succeeded embeddings and any texts
// that ultimately failed.
export async function embedTexts(
  texts: string[],
  config?: Partial<EmbeddingConfig>
): Promise<EmbedResult> {
  const cfg: EmbeddingConfig = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.apiKey) {
    throw new Error("EMBEDDING_PROVIDER_API_KEY not configured");
  }

  const client = buildClient(cfg.apiKey);
  const succeeded: EmbeddedChunk[] = [];
  const failed: string[] = [];

  for (let i = 0; i < texts.length; i += cfg.batchSize) {
    const batch = texts.slice(i, i + cfg.batchSize);
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < cfg.maxRetries) {
      try {
        const resp = await client.embeddings.create({
          model: cfg.model,
          input: batch,
          encoding_format: "float",
          dimensions: Number(process.env.EMBEDDING_DIMENSIONS) || 1536,
        });

        succeeded.push(
          ...resp.data.map((d, idx) => ({
            text: batch[idx]!,
            embedding: d.embedding as number[],
            embedModel: cfg.model,
            embedDims: d.embedding.length,
            embeddedAt: new Date().toISOString(),
          }))
        );
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        attempts += 1;
        if (attempts < cfg.maxRetries) {
          const delay = cfg.baseDelayMs * Math.pow(2, attempts - 1);
          await sleep(delay);
        }
      }
    }

    if (attempts >= cfg.maxRetries && lastError) {
      failed.push(...batch);
    }
  }

  return { succeeded, failed };
}

export function getEmbeddingConfigFromEnv(): Partial<EmbeddingConfig> {
  return {
    provider: "openai",
    model: process.env.EMBEDDING_MODEL_ID ?? DEFAULT_CONFIG.model,
    apiKey: process.env.EMBEDDING_PROVIDER_API_KEY ?? "",
    batchSize: Number(process.env.EMBEDDING_BATCH_SIZE) || DEFAULT_CONFIG.batchSize,
    maxRetries: Number(process.env.EMBEDDING_MAX_RETRIES) || DEFAULT_CONFIG.maxRetries,
    baseDelayMs: Number(process.env.EMBEDDING_BASE_DELAY_MS) || DEFAULT_CONFIG.baseDelayMs,
  };
}
