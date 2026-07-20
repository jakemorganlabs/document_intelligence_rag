// Citation integrity metric (§18, FR-CI-2).
//
// For each answered result: count emitted citations and verified citations.
// Verified means chunk_id was in the retrieved surviving set AND snippet
// appears (whitespace-normalised) in that chunk's text.
//
// Aggregate: verified / emitted. Expected near 1.0.
import { verifyAllCitations } from "../../src/citation_verifier.js";
import type { FixtureResult } from "../types.js";
import type { RetrievedChunk } from "../../types/index.js";

export interface CitationIntegrityResult {
  totalAnswered: number;
  totalEmittedCitations: number;
  totalVerifiedCitations: number;
  integrity: number;
  perFixture: Array<{
    labelId: string;
    question: string;
    emitted: number;
    verified: number;
    failedReasons: string[];
  }>;
}

export function computeCitationIntegrity(
  results: FixtureResult[]
): CitationIntegrityResult {
  let totalAnswered = 0;
  let totalEmitted = 0;
  let totalVerified = 0;

  const perFixture = results
    .filter((r) => r.answer.status === "answered")
    .map((r) => {
      totalAnswered++;
      const emitted = r.answer.citations.length;
      totalEmitted += emitted;

      const surviving: RetrievedChunk[] = r.retrieved;
      const verification = verifyAllCitations(r.answer.citations, surviving);
      const verified = verification.verified ? emitted : emitted - verification.reasons.length;
      totalVerified += Math.max(0, verified);

      return {
        labelId: r.labelId,
        question: r.question,
        emitted,
        verified: Math.max(0, verified),
        failedReasons: verification.verified ? [] : verification.reasons,
      };
    });

  return {
    totalAnswered,
    totalEmittedCitations: totalEmitted,
    totalVerifiedCitations: totalVerified,
    integrity: totalEmitted > 0 ? totalVerified / totalEmitted : 1,
    perFixture,
  };
}
