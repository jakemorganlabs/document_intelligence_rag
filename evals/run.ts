#!/usr/bin/env tsx
// Eval runner: ingest eval corpus, run all labelled fixtures, collect results.
//
// Usage:
//   npx tsx evals/run.ts [--clean]         # local mode
//   EVAL_ENV=prod npx tsx evals/run.ts     # production mode (requires HMAC_SECRET)
//
// Production mode:
//   - connects to DATABASE_URL (must point at the prod DB)
//   - ingests eval corpus with an `eval_` document-id prefix (non-contamination)
//   - calls the live public URL with HMAC-signed requests
//   - after the run, asserts no non-eval_ rows exist in the documents table
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, type PoolClient } from "pg";
import { getClient } from "../src/db.js";
import { ingestFile } from "../src/ingest.js";
import { queryDocument } from "../src/query.js";
import { runMigrations } from "../scripts/migrate.js";
import { signHmac } from "../src/auth.js";
import type {
  AnswerableLabel,
  AdversarialLabel,
  FixtureResult,
  UnanswerableLabel,
} from "./types.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const CORPUS_DIR = resolve(__dirname, "../fixtures/eval_corpus/pdfs");
const QUESTIONS_DIR = resolve(__dirname, "../fixtures/eval_corpus/questions");

const IS_PROD = process.env.EVAL_ENV === "prod";
const PROD_URL = process.env.PROD_QUERY_URL ?? "https://docs.jakemorganlabs.dev/query";

// helpers

async function loadFixtures<T>(filename: string): Promise<T[]> {
  const raw = await readFile(join(QUESTIONS_DIR, filename), "utf-8");
  return JSON.parse(raw) as T[];
}

async function getPdfFiles(): Promise<string[]> {
  const files = await readdir(CORPUS_DIR);
  return files
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => join(CORPUS_DIR, f))
    .sort();
}

async function ingestCorpus(client: PoolClient, namespace?: string): Promise<void> {
  const files = await getPdfFiles();
  console.log(`[eval] Ingesting ${files.length} eval PDFs${namespace ? ` with namespace '${namespace}_'` : ""}...`);
  for (const file of files) {
    const result = await ingestFile(file, client, { namespace });
    console.log(
      `  ${result.status === "indexed" ? "[OK]" : result.status === "skipped" ? "[SK]" : "[ER]"} ${result.source} | chunks: ${result.chunksTotal} | embed: ${result.chunksEmbedded}`
    );
  }
  console.log("[eval] Ingest complete.");
}

async function runLocalFixture(
  label: { id: string; question: string; expectedStatus?: "answered" | "insufficient_evidence" },
  client: PoolClient
): Promise<FixtureResult> {
  try {
    const result = await queryDocument({ question: label.question, client });
    return {
      labelId: label.id,
      question: label.question,
      category: "unknown",
      expectedStatus: label.expectedStatus,
      answer: result.answer,
      retrieved: result.retrieved,
      topScore: result.audit.top_score ?? 0,
      repairUsed: result.audit.repair_used,
      gateFired: result.audit.gate_fired,
      latencyMs: result.audit.latency_ms,
    };
  } catch (err) {
    return {
      labelId: label.id,
      question: label.question,
      category: "unknown",
      expectedStatus: label.expectedStatus,
      answer: {
        status: "insufficient_evidence",
        answer: "Eval error: query pipeline failed.",
        citations: [],
      },
      retrieved: [],
      topScore: 0,
      repairUsed: false,
      gateFired: null,
      latencyMs: 0,
      error: (err as Error).message,
    };
  }
}

async function runProdFixture(
  label: { id: string; question: string; expectedStatus?: "answered" | "insufficient_evidence" }
): Promise<FixtureResult> {
  const secret = process.env.HMAC_SECRET ?? "";
  if (!secret) throw new Error("HMAC_SECRET is required for EVAL_ENV=prod");

  const body = JSON.stringify({ question: label.question });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signHmac(secret, timestamp, body);

  const start = performance.now();
  try {
    const res = await fetch(PROD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Timestamp": String(timestamp),
        "X-Signature": signature,
      },
      body,
    });

    const latencyMs = Math.round(performance.now() - start);
    if (!res.ok) {
      return {
        labelId: label.id,
        question: label.question,
        category: "unknown",
        expectedStatus: label.expectedStatus,
        answer: { status: "insufficient_evidence", answer: `HTTP ${res.status}`, citations: [] },
        retrieved: [],
        topScore: 0,
        repairUsed: false,
        gateFired: null,
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    }

    const data = await res.json() as {
      status: "answered" | "insufficient_evidence";
      answer: string;
      citations: unknown[];
      audit_id?: string;
    };

    return {
      labelId: label.id,
      question: label.question,
      category: "unknown",
      expectedStatus: label.expectedStatus,
      answer: {
        status: data.status,
        answer: data.answer,
        citations: Array.isArray(data.citations) ? data.citations.map((c: unknown) => c as { chunk_id: string; source: string; page: number | null; snippet: string }) : [],
      },
      retrieved: [],
      topScore: 0,
      repairUsed: false,
      gateFired: null,
      latencyMs,
    };
  } catch (err) {
    return {
      labelId: label.id,
      question: label.question,
      category: "unknown",
      expectedStatus: label.expectedStatus,
      answer: { status: "insufficient_evidence", answer: "Network error", citations: [] },
      retrieved: [],
      topScore: 0,
      repairUsed: false,
      gateFired: null,
      latencyMs: Math.round(performance.now() - start),
      error: (err as Error).message,
    };
  }
}

// public API

export interface EvalRunResult {
  answerableResults: FixtureResult[];
  unanswerableResults: FixtureResult[];
  adversarialResults: FixtureResult[];
}

export async function runEvals(
  options: { client?: PoolClient; skipIngest?: boolean } = {}
): Promise<EvalRunResult> {
  const ownClient = !options.client;
  const client = options.client ?? (await getClient());

  if (!options.skipIngest) {
    const docCount = await client.query("SELECT COUNT(*) AS n FROM documents");
    if (Number(docCount.rows[0]?.n ?? 0) === 0) {
      // in prod mode, namespace eval docs with "eval" prefix
      await ingestCorpus(client, IS_PROD ? "eval" : undefined);
    } else {
      console.log("[eval] Documents already present; skip ingest (use --clean to force refresh).");
    }
  }

  const answerable = await loadFixtures<AnswerableLabel>("answerable.json");
  const unanswerable = await loadFixtures<UnanswerableLabel>("unanswerable.json");
  const adversarial = await loadFixtures<AdversarialLabel>("adversarial.json");

  console.log(`[eval] Running ${answerable.length} answerable fixtures...`);
  const answerableResults: FixtureResult[] = [];
  for (const label of answerable) {
    const r = IS_PROD
      ? await runProdFixture({ id: label.id, question: label.question, expectedStatus: undefined })
      : await runLocalFixture({ id: label.id, question: label.question, expectedStatus: undefined }, client);
    r.category = label.category;
    answerableResults.push(r);
  }

  console.log(`[eval] Running ${unanswerable.length} unanswerable fixtures...`);
  const unanswerableResults: FixtureResult[] = [];
  for (const label of unanswerable) {
    const r = IS_PROD
      ? await runProdFixture({ id: label.id, question: label.question, expectedStatus: "insufficient_evidence" })
      : await runLocalFixture({ id: label.id, question: label.question, expectedStatus: "insufficient_evidence" }, client);
    r.category = "unanswerable";
    unanswerableResults.push(r);
  }

  console.log(`[eval] Running ${adversarial.length} adversarial fixtures...`);
  const adversarialResults: FixtureResult[] = [];
  for (const label of adversarial) {
    const r = IS_PROD
      ? await runProdFixture({ id: label.id, question: label.question, expectedStatus: label.expected_status })
      : await runLocalFixture({ id: label.id, question: label.question, expectedStatus: label.expected_status }, client);
    r.category = label.category;
    adversarialResults.push(r);
  }

  if (ownClient) client.release();

  return { answerableResults, unanswerableResults, adversarialResults };
}

// CLI

async function main() {
  const cleanFlag = process.argv.includes("--clean");

  if (cleanFlag) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    const adminClient = new Client({ connectionString });
    await adminClient.connect();
    console.log("[eval] Dropping public schema for clean eval...");
    await adminClient.query("DROP SCHEMA IF EXISTS public CASCADE");
    await adminClient.query("CREATE SCHEMA public");
    await adminClient.query("GRANT ALL ON SCHEMA public TO public");
    await adminClient.end();
    await runMigrations(connectionString);
  }

  const results = await runEvals();

  // save raw results first: 75 live queries must never be discarded by a
  // bookkeeping check that runs afterwards
  const resultsFile = IS_PROD ? "results_prod.json" : "results.json";
  const resultsPath = resolve(__dirname, resultsFile);
  const resultsJson = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      env: IS_PROD ? "prod" : "local",
      answerable: results.answerableResults,
      unanswerable: results.unanswerableResults,
      adversarial: results.adversarialResults,
    },
    null,
    2
  );
  const { writeFile } = await import("node:fs/promises");
  await writeFile(resultsPath, resultsJson, "utf-8");
  console.log(`[eval] Raw results written to ${resultsPath}`);

  // corruption check in prod mode: assert no non-eval_ documents
  if (IS_PROD) {
    console.log("[eval] Verifying corpus non-contamination...");
    const client = await getClient();
    const nonEval = await client.query(
      `SELECT source FROM documents WHERE source NOT LIKE 'eval_%' LIMIT 1`
    );
    await client.release();
    if (nonEval.rows.length > 0) {
      console.error(
        `[eval] FAIL: Non-eval document found in DB: ${nonEval.rows[0]!.source}`
      );
      process.exit(1);
    }
    console.log("[eval] Corpus non-contamination verified.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[eval] Fatal error:", err);
    process.exit(1);
  });
}
