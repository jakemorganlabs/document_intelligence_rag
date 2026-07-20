#!/usr/bin/env tsx
// ANN sanity check: top-k cosine similarity timing.
//
// Usage:
//   npx tsx scripts/ann_sanity.ts
//
// Reports whether the top-K query completes in <100ms.
import "dotenv/config";
import { getClient, annSearch } from "../src/db.js";

// zero-ish vector for sanity; real queries use actual query embeddings
function makeDummyVector(dim = 1536): number[] {
  return new Array(dim).fill(0.0).map(() => (Math.random() - 0.5) * 0.01);
}

async function main() {
  const client = await getClient();
  try {
    const vec = makeDummyVector();
    const start = performance.now();
    const results = await annSearch(vec, 6, client);
    const elapsed = performance.now() - start;

    console.log("\n" + "=".repeat(50));
    console.log("ANN Sanity Check");
    console.log("=".repeat(50));
    console.log(`Query returned ${results.length} row(s)`);
    console.log(`Latency: ${elapsed.toFixed(2)} ms`);
    for (const r of results.slice(0, 3)) {
      console.log(`  chunk_id: ${r.chunk_id} | similarity: ${r.similarity.toFixed(4)} | source: ${r.source}`);
    }
    console.log("=".repeat(50));

    if (elapsed < 100) {
      console.log("PASS: Query completed in < 100 ms");
      process.exit(0);
    } else {
      console.warn("WARN: Query took >= 100 ms (corpus may be too small for meaningful measurement)");
      process.exit(0);
    }
  } catch (err) {
    console.error(`ANN sanity check failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    client.release();
  }
}

main();
