// Generator: DeepInfra adapter for Google Gemma (§10.8, FR-AN-1..5).
//
// Calls google/gemma-4-26B-A4B-it via DeepInfra's OpenAI-compatible completions
// endpoint (https://api.deepinfra.com/v1/openai). Uses
// response_format: { type: "json_object" } plus system-prompt discipline to
// constrain output. Post-generation validation (schema + citation gate) is
// the correctness guarantee.
//
// No Anthropic, Claude, or Haiku models anywhere in this system.
//
// Repair loop: exactly one corrective re-call on schema or citation failure.
import generationConfig from "../config/generation.json" with { type: "json" };
import type { GroundedAnswer } from "../types/index.js";

export interface GenerateOptions {
  prompt: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GenerateResult {
  answer: GroundedAnswer;
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
}

// System prompt: constrains Gemma to valid JSON.
const JSON_SYSTEM_PROMPT = `You are a grounded question-answering assistant. Respond ONLY with a single JSON object matching this exact schema:
{
  "status": "answered" | "insufficient_evidence",
  "answer": "string",
  "citations": [
    { "chunk_id": "string", "source": "string", "page": number|null, "snippet": "string" }
  ]
}
Rules:
- status is "insufficient_evidence" if the passages do not contain enough information.
- Every citation snippet must be verbatim from the passages.
- Do not wrap the output in markdown fences.`;

// DeepInfra client.

function getApiKey(): string {
  const key = process.env.DEEPINFRA_API_KEY ?? process.env.GOOGLE_GENAI_API_KEY ?? "";
  if (!key) {
    throw new Error("DEEPINFRA_API_KEY (or GOOGLE_GENAI_API_KEY) not set");
  }
  return key;
}

function getBaseUrl(): string {
  return process.env.DEEPINFRA_BASE_URL ?? "https://api.deepinfra.com/v1/openai";
}

// utilities

function stripMarkdownFences(text: string): string {
  const cleaned = text
    .replace(/^```(?:json)?\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return cleaned;
  }
  return cleaned.slice(firstBrace, lastBrace + 1);
}

// generation

export async function generateGroundedAnswer(
  opts: GenerateOptions
): Promise<GenerateResult> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const model = opts.model ?? generationConfig.model_id;
  const temperature = opts.temperature ?? generationConfig.temperature;
  const maxTokens = opts.maxOutputTokens ?? generationConfig.max_tokens;

  const start = performance.now();

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: JSON_SYSTEM_PROMPT },
        { role: "user", content: opts.prompt },
      ],
      temperature,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "unknown");
    throw new Error(`DeepInfra API error ${res.status}: ${body}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const latencyMs = Math.round(performance.now() - start);

  const rawText = data.choices?.[0]?.message?.content ?? "";
  const stripped = stripMarkdownFences(rawText);

  let answer: GroundedAnswer;
  try {
    answer = JSON.parse(stripped) as GroundedAnswer;
  } catch (err) {
    answer = {
      status: "insufficient_evidence",
      answer:
        "I don't have enough information in the provided documents to answer that.",
      citations: [],
    };
  }

  const usage = data.usage;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;

  return {
    answer,
    rawText: stripped,
    inputTokens,
    outputTokens,
    totalTokens,
    latencyMs,
  };
}

// repair

export async function generateRepair(
  opts: GenerateOptions & {
    priorRawText: string;
    validationError: string;
  }
): Promise<GenerateResult> {
  const repairPrompt = [
    `Your previous response failed validation:\n${opts.validationError}\n`,
    `Your previous output was:\n${opts.priorRawText}\n`,
    `Please provide a corrected JSON response strictly matching the required schema.`,
    `Make sure every citation chunk_id exists in the passages and every snippet is verbatim.`,
    opts.prompt,
  ].join("\n\n---\n\n");

  return generateGroundedAnswer({
    ...opts,
    prompt: repairPrompt,
  });
}
