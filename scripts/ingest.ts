#!/usr/bin/env tsx
// CLI entry point for single-file or batch ingestion.
//
// Usage:
//   npx tsx scripts/ingest.ts <file_or_dir> [--replace]
//
// Examples:
//   npx tsx scripts/ingest.ts fixtures/smoke_pdfs/smoke_01_guidelines.pdf
//   npx tsx scripts/ingest.ts fixtures/smoke_pdfs/
//   npx tsx scripts/ingest.ts fixtures/smoke_pdfs/ --replace
import "dotenv/config";
import { readdir, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { ingestFile, type IngestResult } from "../src/ingest.js";
import { getClient } from "../src/db.js";

const SUPPORTED_EXTS = new Set([".pdf", ".txt", ".md", ".markdown"]);

async function main() {
  const target = process.argv[2];
  const replaceFlag = process.argv.includes("--replace");

  if (!target) {
    console.error("Usage: npx tsx scripts/ingest.ts <file_or_dir> [--replace]");
    process.exit(1);
  }

  const client = await getClient();
  let results: IngestResult[] = [];

  try {
    const targetPath = resolve(target);
    const info = await stat(targetPath);

    if (info.isDirectory()) {
      const entries = await readdir(targetPath);
      const files = entries
        .map((f) => resolve(targetPath, f))
        .filter((f) => SUPPORTED_EXTS.has(extname(f).toLowerCase()))
        .sort();

      if (files.length === 0) {
        console.error(`No supported files found in ${targetPath}`);
        process.exit(1);
      }

      console.log(`Batch ingestion of ${files.length} file(s) from ${targetPath}`);
      for (const file of files) {
        const result = await ingestFile(file, client, { replaceOnReingest: replaceFlag });
        results.push(result);
      }
    } else {
      const result = await ingestFile(targetPath, client, { replaceOnReingest: replaceFlag });
      results.push(result);
    }

    // summary
    console.log("\n" + "=".repeat(60));
    console.log("INGEST SUMMARY");
    console.log("=".repeat(60));

    let totalIndexed = 0;
    let totalSkipped = 0;
    let totalPartial = 0;
    let totalFailed = 0;
    let totalChunks = 0;

    for (const r of results) {
      const statusEmoji =
        r.status === "indexed" ? "[OK]" :
        r.status === "skipped" ? "[SK]" :
        r.status === "partial" ? "[PT]" : "[ER]";
      console.log(`${statusEmoji} ${r.source}`);
      console.log(`    status: ${r.status} | pages: ${r.pageCount} | chunks: ${r.chunksTotal} | embed_ok: ${r.chunksEmbedded} | unembedded: ${r.chunksUnembedded}`);
      if (r.reason) {
        console.log(`    reason: ${r.reason}`);
      }

      if (r.status === "indexed") totalIndexed++;
      if (r.status === "skipped") totalSkipped++;
      if (r.status === "partial") totalPartial++;
      if (r.status === "failed") totalFailed++;
      totalChunks += r.chunksTotal;
    }

    console.log("-".repeat(60));
    console.log(`Total: ${results.length} files | Indexed: ${totalIndexed} | Skipped: ${totalSkipped} | Partial: ${totalPartial} | Failed: ${totalFailed} | Chunks: ${totalChunks}`);
    console.log("=".repeat(60));
  } catch (err) {
    console.error(`Fatal error: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    client.release();
  }
}

main();
