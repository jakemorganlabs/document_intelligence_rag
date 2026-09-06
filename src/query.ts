// Query Pipeline: end-to-end query handler (§12.B).
//
// Flow:
//  0. instruction screen (abstain if the query is an instruction, not a question)
//  1. retrieve chunks (embed query + ANN search)
//  2. pre-generation relevance gate (abstain if nothing >= floor)
//  3. assemble prompt
//  4. call Gemma generator (JSON mode + responseSchema)
//  5. schema validate (ajv)
//  6. citation gate (chunk-in-set + snippet-present)
//  7. repair loop (max 1 attempt), then downgrade
//  8. persist audit
//  9. return GroundedAnswer
import { retrieveChunks } from "./retriever.js";
import {
  preGenerationGate,
  makeInsufficientEvidence,
  screenInstructionOverride,
  validatePostGeneration,
} from "./abstention.js";
import { assemblePrompt } from "./context_assembler.js";
import { generateGroundedAnswer, generateRepair } from "./generator.js";
import { getClient } from "./db.js";
import type { PoolClient } from "pg";
import type {
  GroundedAnswer,
  QueryAudit,
  RetrievedChunk,
} from "../types/index.js";
import generationConfig from "../config/generation.json" with { type: "json" };
import groundedAnswerSchema from "../schemas/grounded_answer.schema.json" with { type: "json" };
import { Ajv } from "ajv";
import { logEvent } from "./log.js";

const ajv = new Ajv({ strict: false, validateSchema: false });
const validateGroundedAnswer = ajv.compile(groundedAnswerSchema);

export interface QueryOptions {
  question: string;
  topK?: number;
  client?: PoolClient;
}

export interface QueryResult {
  answer: GroundedAnswer;
  audit: QueryAudit;
  retrieved: RetrievedChunk[];
}

export async function queryDocument(
  opts: QueryOptions
): Promise<QueryResult> {
  const traceId = crypto.randomUUID();
  const startTotal = performance.now();
  const ownClient = !opts.client;
  const client = opts.client ?? (await getClient());

  // step 0: instruction screen. No embedding, no retrieval, no model call.
  const screen = screenInstructionOverride(opts.question);
  if (screen.override) {
    const latency = Math.round(performance.now() - startTotal);
    logEvent({ trace_id: traceId, stage: "instruction_screen", status: "abstain", gate_fired: "instruction", error: screen.reasons.join(",") });
    const result = makeInsufficientEvidence();
    const audit = await writeAudit(client, {
      question: opts.question,
      retrievedIds: [],
      scores: {},
      status: result.status,
      answer: result.answer,
      citations: result.citations,
      modelId: null,
      parameters: null,
      gateFired: "instruction",
      topScore: 0,
      repairUsed: false,
      latencyMs: latency,
      inputTokens: 0,
      outputTokens: 0,
      rawOutput: null,
    });
    if (ownClient) client.release();
    return { answer: result, audit, retrieved: [] };
  }

  // step 1: retrieve (embed + ANN)
  logEvent({ trace_id: traceId, stage: "retrieve", status: "start", query_id: opts.question });
  const retrieveStart = performance.now();
  const { chunks: retrieved, topScore } = await retrieveChunks({
    question: opts.question,
    topK: opts.topK,
    client,
  });
  const retrieveMs = Math.round(performance.now() - retrieveStart);
  logEvent({ trace_id: traceId, stage: "retrieve", status: "success", latency_ms: retrieveMs, similarity_top: topScore });

  // step 2: pre-generation relevance gate
  logEvent({ trace_id: traceId, stage: "pre_gen_gate", status: "start" });
  const gate1 = preGenerationGate(retrieved);
  if (!gate1.proceed) {
    logEvent({ trace_id: traceId, stage: "pre_gen_gate", status: "abstain", gate_fired: "relevance", similarity_top: topScore });
    const result = gate1.result;
    const audit = await writeAudit(client, {
      question: opts.question,
      retrievedIds: retrieved.map((c) => c.chunk_id),
      scores: Object.fromEntries(retrieved.map((c) => [c.chunk_id, c.similarity])),
      status: result.status,
      answer: result.answer,
      citations: result.citations,
      modelId: null,
      parameters: null,
      gateFired: "relevance",
      topScore,
      repairUsed: false,
      latencyMs: retrieveMs,
      inputTokens: 0,
      outputTokens: 0,
      rawOutput: null,
    });
    if (ownClient) client.release();
    return { answer: result, audit, retrieved };
  }
  logEvent({ trace_id: traceId, stage: "pre_gen_gate", status: "success", gate_fired: null, similarity_top: topScore });

  const surviving = gate1.surviving;

  // step 3: assemble prompt
  logEvent({ trace_id: traceId, stage: "assemble_prompt", status: "start" });
  const { prompt } = assemblePrompt(surviving, opts.question);
  logEvent({ trace_id: traceId, stage: "assemble_prompt", status: "success" });

  // step 4: generate
  logEvent({ trace_id: traceId, stage: "generate", status: "start", model_id: generationConfig.model_id });
  const genStart = performance.now();
  let genResult = await generateGroundedAnswer({ prompt });
  let genMs = Math.round(performance.now() - genStart);
  logEvent({
    trace_id: traceId,
    stage: "generate",
    status: "success",
    latency_ms: genMs,
    model_id: generationConfig.model_id,
    input_tokens: genResult.inputTokens,
    output_tokens: genResult.outputTokens,
    total_tokens: genResult.totalTokens,
  });

  let rawOutput = genResult.rawText;
  let repairUsed = false;
  let currentAnswer = genResult.answer;

  // step 5: schema validate
  logEvent({ trace_id: traceId, stage: "schema_validate", status: "start" });
  const schemaValid = validateGroundedAnswer(currentAnswer);

  if (!schemaValid) {
    logEvent({ trace_id: traceId, stage: "schema_validate", status: "failure", error: ajv.errorsText(validateGroundedAnswer.errors ?? []) });
    const schemaError = ajv.errorsText(validateGroundedAnswer.errors ?? []);
    const repaired = await generateRepair({
      prompt,
      priorRawText: rawOutput,
      validationError: `Schema validation failed: ${schemaError}`,
    });
    repairUsed = true;
    rawOutput = repaired.rawText;
    currentAnswer = repaired.answer;
    genMs += repaired.latencyMs;
    logEvent({
      trace_id: traceId,
      stage: "repair",
      status: "success",
      latency_ms: repaired.latencyMs,
      input_tokens: repaired.inputTokens,
      output_tokens: repaired.outputTokens,
      total_tokens: repaired.totalTokens,
    });
  } else {
    logEvent({ trace_id: traceId, stage: "schema_validate", status: "success" });
  }

  // step 6+7: citation gate with optional repair
  logEvent({ trace_id: traceId, stage: "citation_verify", status: "start" });
  const firstPost = validatePostGeneration(currentAnswer, surviving);

  let finalAnswer: GroundedAnswer;
  let finalGate: "none" | "citation" | "cross_field" = "none";

  if (firstPost.outcome === "accept") {
    logEvent({ trace_id: traceId, stage: "citation_verify", status: "success" });
    finalAnswer = currentAnswer;
  } else if (firstPost.outcome === "abstain") {
    logEvent({ trace_id: traceId, stage: "citation_verify", status: "abstain", gate_fired: firstPost.gate });
    finalAnswer = firstPost.result;
    finalGate = firstPost.gate;
  } else {
    logEvent({ trace_id: traceId, stage: "citation_verify", status: "failure", error: firstPost.reasons.join("; ") });
    // citation gate fired "repair": attempt once
    if (!repairUsed) {
      const repaired = await generateRepair({
        prompt,
        priorRawText: rawOutput,
        validationError: `Citation verification failed: ${firstPost.reasons.join("; ")}`,
      });
      repairUsed = true;
      rawOutput = repaired.rawText;
      currentAnswer = repaired.answer;
      genMs += repaired.latencyMs;
      logEvent({
        trace_id: traceId,
        stage: "repair",
        status: "success",
        latency_ms: repaired.latencyMs,
        input_tokens: repaired.inputTokens,
        output_tokens: repaired.outputTokens,
        total_tokens: repaired.totalTokens,
      });

      const secondPost = validatePostGeneration(currentAnswer, surviving);
      if (secondPost.outcome === "accept") {
        logEvent({ trace_id: traceId, stage: "citation_verify", status: "success" });
        finalAnswer = currentAnswer;
      } else if (secondPost.outcome === "abstain") {
        logEvent({ trace_id: traceId, stage: "citation_verify", status: "abstain", gate_fired: secondPost.gate });
        finalAnswer = secondPost.result;
        finalGate = secondPost.gate;
      } else {
        logEvent({ trace_id: traceId, stage: "citation_verify", status: "failure", gate_fired: "citation" });
        finalAnswer = makeInsufficientEvidence();
        finalGate = "citation";
      }
    } else {
      // repair already used on schema; downgrade
      logEvent({ trace_id: traceId, stage: "citation_verify", status: "abstain", gate_fired: "citation", error: "repair_already_used" });
      finalAnswer = makeInsufficientEvidence();
      finalGate = "citation";
    }
  }

  const totalLatency = Math.round(performance.now() - startTotal);

  // step 8: audit
  logEvent({ trace_id: traceId, stage: "persist_audit", status: "start", latency_ms: totalLatency });
  const audit = await writeAudit(client, {
    question: opts.question,
    retrievedIds: retrieved.map((c) => c.chunk_id),
    scores: Object.fromEntries(retrieved.map((c) => [c.chunk_id, c.similarity])),
    status: finalAnswer.status,
    answer: finalAnswer.answer,
    citations: finalAnswer.citations,
    modelId: generationConfig.model_id,
    parameters: { temperature: generationConfig.temperature, max_tokens: generationConfig.max_tokens },
    gateFired: finalGate === "none" ? null : finalGate,
    topScore,
    repairUsed,
    latencyMs: totalLatency,
    inputTokens: genResult.inputTokens,
    outputTokens: genResult.outputTokens,
    rawOutput,
  });
  logEvent({ trace_id: traceId, stage: "persist_audit", status: "success", latency_ms: totalLatency });

  if (ownClient) client.release();
  return { answer: finalAnswer, audit, retrieved };
}

// helper: write an audit row

interface AuditWriteOpts {
  question: string;
  retrievedIds: string[];
  scores: Record<string, number>;
  status: GroundedAnswer["status"];
  answer: string;
  citations: GroundedAnswer["citations"];
  modelId: string | null;
  parameters: Record<string, unknown> | null;
  gateFired: "instruction" | "relevance" | "citation" | "cross_field" | "none" | null;
  topScore: number;
  repairUsed: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  rawOutput: string | null;
}

async function writeAudit(
  client: PoolClient,
  opts: AuditWriteOpts
): Promise<QueryAudit> {
  const res = await client.query<{ audit_id: string }>(
    `INSERT INTO query_audits
      (question, retrieved_ids, scores, status, answer, citations,
       model_id, parameters, gate_fired, top_score, repair_used,
       latency_ms, token_counts, error_info)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING audit_id`,
    [
      opts.question,
      opts.retrievedIds,
      JSON.stringify(opts.scores),
      opts.status,
      opts.answer,
      JSON.stringify(opts.citations),
      opts.modelId,
      opts.parameters ? JSON.stringify(opts.parameters) : null,
      opts.gateFired,
      opts.topScore,
      opts.repairUsed,
      opts.latencyMs,
      JSON.stringify({
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
        total_tokens: opts.inputTokens + opts.outputTokens,
      }),
      opts.rawOutput ? JSON.stringify({ raw_output: opts.rawOutput }) : null,
    ]
  );

  return {
    audit_id: res.rows[0]!.audit_id,
    question: opts.question,
    retrieved_ids: opts.retrievedIds,
    scores: opts.scores,
    status: opts.status as QueryAudit["status"],
    answer: opts.answer,
    citations: opts.citations,
    model_id: opts.modelId,
    parameters: opts.parameters,
    gate_fired: opts.gateFired,
    top_score: opts.topScore,
    repair_used: opts.repairUsed,
    latency_ms: opts.latencyMs,
  } as unknown as QueryAudit;
}
