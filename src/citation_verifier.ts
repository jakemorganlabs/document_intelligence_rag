/**
 * Citation Verifier — deterministic grounding gate (§10.9, FR-CI-2).
 *
 * Invariant: a citation is verified only if its snippet is a verbatim (whitespace-normalized)
 *   substring of the retrieved chunk text and the chunk_id is in the retrieved set.
 * Deliberately does NOT: fuzzy-match, paraphrase-check, or tolerate missing chunk_ids.
 *   (those would weaken the grounding guarantee).
 *
 * Normalization rules (applied in order):
 * 1. Unicode NFC normalization
 * 2. Fold smart single/double quotes to ASCII straight quotes
 * 3. Replace NBSP and other unicode space variants with ASCII space
 * 4. Collapse all whitespace runs (tabs, newlines, form feeds) to a single space
 * 5. Trim leading/trailing whitespace
 *
 * These rules are tuned for PDF-extracted text (dirty whitespace, ligatures, smart quotes).
 * They intentionally do NOT strip punctuation or alter case — only whitespace and quote folding.
 */
import type {
  Citation,
  CitationVerificationResult,
  RetrievedChunk,
} from "../types/index.js";

const SMART_SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B]/g;
const SMART_DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F]/g;
const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g;
const WHITESPACE_RUNS = /\s+/gu;

export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(SMART_SINGLE_QUOTES, "'")
    .replace(SMART_DOUBLE_QUOTES, '"')
    .replace(ZERO_WIDTH_CHARS, " ")
    .replace(WHITESPACE_RUNS, " ")
    .trim();
}

export function verifyCitation(
  citation: Citation,
  retrieved: RetrievedChunk[]
): CitationVerificationResult {
  const reasons: string[] = [];
  const chunk = retrieved.find((c) => c.chunk_id === citation.chunk_id);

  if (!chunk) {
    reasons.push(`chunk_id "${citation.chunk_id}" not in retrieved set`);
    return { verified: false, reasons };
  }

  const normalizedSnippet = normalizeText(citation.snippet);
  const normalizedChunkText = normalizeText(chunk.text);

  if (normalizedSnippet.length === 0) {
    reasons.push("snippet is empty after normalization");
    return { verified: false, reasons };
  }

  if (!normalizedChunkText.includes(normalizedSnippet)) {
    reasons.push("snippet not present in cited chunk text (whitespace-normalized)");
    return { verified: false, reasons };
  }

  return { verified: true, reasons: [] };
}

export function verifyAllCitations(
  citations: Citation[],
  retrieved: RetrievedChunk[]
): CitationVerificationResult {
  const reasons: string[] = [];

  for (const citation of citations) {
    const result = verifyCitation(citation, retrieved);
    if (!result.verified) {
      reasons.push(...result.reasons);
    }
  }

  return {
    verified: reasons.length === 0,
    reasons,
  };
}
