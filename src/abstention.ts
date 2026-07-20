// Abstention decision: two-gate deterministic logic (§11.5, FR-AB-1..3).
//
// Gate 1 (pre-generation): relevance floor. No model call if nothing survives.
// Gate 2 (post-generation): cross-field rules + citation verification.
// Repair: exactly one corrective attempt, then downgrade to insufficient evidence.
import { verifyAllCitations } from "./citation_verifier.js";
import {
  INSUFFICIENT_EVIDENCE_MESSAGE,
  INSUFFICIENT_EVIDENCE_STATUS,
} from "./constants.js";
import type { GroundedAnswer, RetrievedChunk } from "../types/index.js";
import retrievalConfig from "../config/retrieval.json" with { type: "json" };

export type PreGenerationResult =
  | { proceed: true; surviving: RetrievedChunk[]; topScore: number }
  | {
      proceed: false;
      result: GroundedAnswer;
      gate: "relevance";
      topScore: number;
    };

export type PostGenerationOutcome =
  | { outcome: "accept"; result: GroundedAnswer }
  | { outcome: "repair"; result: GroundedAnswer; reasons: string[] }
  | { outcome: "abstain"; result: GroundedAnswer; gate: "citation" | "cross_field"; reasons: string[] };

export function makeInsufficientEvidence(
  answer: string = INSUFFICIENT_EVIDENCE_MESSAGE
): GroundedAnswer {
  return {
    status: INSUFFICIENT_EVIDENCE_STATUS,
    answer,
    citations: [],
  };
}

export function applyRelevanceGate(
  retrieved: RetrievedChunk[],
  similarityFloor: number = retrievalConfig.similarity_floor
): RetrievedChunk[] {
  return retrieved.filter((chunk) => chunk.similarity >= similarityFloor);
}

export function preGenerationGate(
  retrieved: RetrievedChunk[],
  similarityFloor: number = retrievalConfig.similarity_floor
): PreGenerationResult {
  const topScore =
    retrieved.length > 0
      ? Math.max(...retrieved.map((chunk) => chunk.similarity))
      : 0;

  const surviving = applyRelevanceGate(retrieved, similarityFloor);

  if (surviving.length === 0) {
    return {
      proceed: false,
      result: makeInsufficientEvidence(),
      gate: "relevance",
      topScore,
    };
  }

  return { proceed: true, surviving, topScore };
}

export function validatePostGeneration(
  answer: GroundedAnswer,
  surviving: RetrievedChunk[]
): PostGenerationOutcome {
  if (answer.status === INSUFFICIENT_EVIDENCE_STATUS) {
    if (answer.citations.length > 0) {
      return {
        outcome: "abstain",
        result: makeInsufficientEvidence(),
        gate: "cross_field",
        reasons: ["insufficient_evidence status requires empty citations"],
      };
    }
    return { outcome: "accept", result: answer };
  }

  if (answer.citations.length === 0) {
    return {
      outcome: "abstain",
      result: makeInsufficientEvidence(),
      gate: "cross_field",
      reasons: ["answered status requires at least one citation"],
    };
  }

  const verification = verifyAllCitations(answer.citations, surviving);
  if (verification.verified) {
    return { outcome: "accept", result: answer };
  }

  return {
    outcome: "repair",
    result: answer,
    reasons: verification.reasons,
  };
}

export interface ResolveAnswerOptions {
  original: GroundedAnswer;
  surviving: RetrievedChunk[];
  repair?: () => GroundedAnswer | null | undefined;
}

export function resolveAnswerWithRepair(
  options: ResolveAnswerOptions
): { result: GroundedAnswer; repairUsed: boolean; gate: "none" | "citation" | "cross_field" } {
  const first = validatePostGeneration(options.original, options.surviving);

  if (first.outcome === "accept") {
    return { result: first.result, repairUsed: false, gate: "none" };
  }

  if (first.outcome === "abstain") {
    return { result: first.result, repairUsed: false, gate: first.gate };
  }

  const repaired = options.repair?.();
  if (!repaired) {
    return {
      result: makeInsufficientEvidence(),
      repairUsed: true,
      gate: "citation",
    };
  }

  const second = validatePostGeneration(repaired, options.surviving);
  if (second.outcome === "accept") {
    return { result: second.result, repairUsed: true, gate: "none" };
  }

  return {
    result: makeInsufficientEvidence(),
    repairUsed: true,
    gate: second.outcome === "abstain" ? second.gate : "citation",
  };
}
