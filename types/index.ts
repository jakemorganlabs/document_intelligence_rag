// Shared types for the deterministic core (S01).

export interface PageText {
  page: number;
  text: string;
}

export interface ChunkInput {
  source: string;
  contentHash: string;
  documentId: string;
  pages: PageText[];
}

export interface Chunk {
  chunk_index: number;
  source: string;
  page: number | null;
  section: string | null;
  char_start: number;
  char_end: number;
  text: string;
  token_count: number;
}

export interface ChunkRecord {
  chunk_id: string;
  document_id: string;
  content_hash: string;
  source: string;
  page: number | null;
  section: string | null;
  chunk_index: number;
  char_start: number | null;
  char_end: number | null;
  text: string;
  token_count: number;
  embedding?: number[] | null;
  embed_model?: string | null;
  embed_dims?: number | null;
  embedded_at?: string | null;
}

export interface Citation {
  chunk_id: string;
  source: string;
  page?: number | null;
  snippet: string;
}

export type AnswerStatus = "answered" | "insufficient_evidence";

export interface GroundedAnswer {
  status: AnswerStatus;
  answer: string;
  citations: Citation[];
}

export interface RetrievedChunk {
  chunk_id: string;
  source: string;
  page: number | null;
  text: string;
  similarity: number;
}

export interface CitationVerificationResult {
  verified: boolean;
  reasons: string[];
}

export type AbstentionGate = "instruction" | "relevance" | "citation" | "cross_field";

export interface AbstentionResult {
  status: "insufficient_evidence";
  answer: string;
  citations: [];
  gate: AbstentionGate;
  topScore?: number;
}

export interface QueryAudit {
  audit_id: string;
  question: string;
  retrieved_ids: string[];
  scores: Record<string, number>;
  status: AnswerStatus | "error";
  answer: string | null;
  citations: Citation[];
  gate_fired: AbstentionGate | "none" | null;
  top_score: number | null;
  repair_used: boolean;
  latency_ms: number;
}
