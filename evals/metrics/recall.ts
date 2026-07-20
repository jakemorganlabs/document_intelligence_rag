// recall@k metric (§18, FR-RE-1).
//
// For each answerable question: did the retrieved set (top-k, before the
// relevance gate) contain at least one chunk whose source matches a gold
// source?
//
// Measures retriever quality, not end-to-end correctness.
import type { AnswerableLabel, FixtureResult } from "../types.js";

export interface RecallResult {
  k: number;
  total: number;
  hits: number;
  recall: number;
  perFixture: Array<{
    labelId: string;
    question: string;
    hit: boolean;
    matchedSources: string[];
  }>;
}

export function computeRecallAtK(
  labels: AnswerableLabel[],
  results: FixtureResult[],
  k: number
): RecallResult {
  const resultMap = new Map(results.map((r) => [r.labelId, r]));
  let hits = 0;

  const perFixture = labels.map((label) => {
    const result = resultMap.get(label.id);
    const retrieved = result?.retrieved ?? [];
    const retrievedSources = new Set(retrieved.slice(0, k).map((c) => c.source));
    const matchedSources = label.gold_sources.filter((s) => retrievedSources.has(s));
    const hit = matchedSources.length > 0;
    if (hit) hits++;

    return {
      labelId: label.id,
      question: label.question,
      hit,
      matchedSources,
    };
  });

  return {
    k,
    total: labels.length,
    hits,
    recall: labels.length > 0 ? hits / labels.length : 0,
    perFixture,
  };
}
