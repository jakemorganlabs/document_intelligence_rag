// Eval suite types (internal contract).
//
// Used only by the eval runner and metrics modules. They do not appear in the
// production query path.

import type { GroundedAnswer, RetrievedChunk } from "../types/index.js";

// One answerable fixture from fixtures/eval_corpus/questions/answerable.json
export interface AnswerableLabel {
  id: string;
  question: string;
  category: "single-chunk" | "multi-hop" | "synthesis";
  gold_sources: string[];
  gold_pages: number[];
  gold_snippets: string[];
}

// One unanswerable fixture from fixtures/eval_corpus/questions/unanswerable.json
export interface UnanswerableLabel {
  id: string;
  question: string;
  note: string;
}

// One adversarial fixture from fixtures/eval_corpus/questions/adversarial.json
export interface AdversarialLabel {
  id: string;
  question: string;
  poisoned_source: string | null;
  category: string;
  expected_behavior: string;
  expected_status: "answered" | "insufficient_evidence";
}

// Result of running a single fixture through the system
export interface FixtureResult {
  labelId: string;
  question: string;
  category: string;
  expectedStatus?: "answered" | "insufficient_evidence";
  answer: GroundedAnswer;
  retrieved: RetrievedChunk[];
  topScore: number;
  repairUsed: boolean;
  gateFired: string | null;
  latencyMs: number;
  error?: string;
}

// Per-metric summary
export interface MetricSummary {
  name: string;
  value: number;
  threshold: number; // pass threshold
  passed: boolean;
  description: string;
}

// Per-category breakdown
export interface CategoryBreakdown {
  category: string;
  total: number;
  passed: number;
  failed: number;
  details: Array<{
    labelId: string;
    expected?: string;
    actual: string;
    reason: string;
  }>;
}

// Final eval report
export interface EvalReport {
  generatedAt: string;
  totalFixtures: number;
  metrics: MetricSummary[];
  categoryResults: CategoryBreakdown[];
  failures: Array<{
    labelId: string;
    question: string;
    expected: string;
    actual: string;
    reason: string;
  }>;
}
