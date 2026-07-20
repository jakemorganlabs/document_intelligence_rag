import { describe, expect, it } from "vitest";
import { computeRecallAtK } from "../evals/metrics/recall.js";
import { computeAbstentionCorrectness } from "../evals/metrics/abstention.js";
import { computeCitationIntegrity } from "../evals/metrics/citations.js";
import type {
  AnswerableLabel,
  FixtureResult,
} from "../evals/types.js";
import type { RetrievedChunk } from "../types/index.js";

const mockChunks = (overrides: Partial<RetrievedChunk>[]): RetrievedChunk[] =>
  overrides.map((o) => ({
    chunk_id: "c-1",
    source: "doc.pdf",
    page: 1,
    text: "sample text",
    similarity: 0.5,
    ...o,
  }));

describe("eval metrics", () => {
  describe("recall@k", () => {
    const labels: AnswerableLabel[] = [
      {
        id: "a",
        question: "Q1",
        category: "single-chunk",
        gold_sources: ["01.pdf"],
        gold_pages: [1],
        gold_snippets: ["text"],
      },
      {
        id: "b",
        question: "Q2",
        category: "single-chunk",
        gold_sources: ["02.pdf"],
        gold_pages: [1],
        gold_snippets: ["text"],
      },
    ];

    it("returns 1.0 when gold source is in top-k", () => {
      const results: FixtureResult[] = [
        {
          labelId: "a",
          question: "Q1",
          category: "single-chunk",
          answer: { status: "answered", answer: "", citations: [] },
          retrieved: mockChunks([{ source: "01.pdf" }, { source: "x.pdf" }]),
          topScore: 0.7,
          repairUsed: false,
          gateFired: null,
          latencyMs: 100,
        },
        {
          labelId: "b",
          question: "Q2",
          category: "single-chunk",
          answer: { status: "answered", answer: "", citations: [] },
          retrieved: mockChunks([{ source: "02.pdf" }]),
          topScore: 0.7,
          repairUsed: false,
          gateFired: null,
          latencyMs: 100,
        },
      ];

      const r = computeRecallAtK(labels, results, 6);
      expect(r.recall).toBe(1);
      expect(r.perFixture.every((p) => p.hit)).toBe(true);
    });

    it("returns 0.0 when gold source is never retrieved", () => {
      const results: FixtureResult[] = [
        {
          labelId: "a",
          question: "Q1",
          category: "single-chunk",
          answer: { status: "answered", answer: "", citations: [] },
          retrieved: mockChunks([{ source: "x.pdf" }]),
          topScore: 0.1,
          repairUsed: false,
          gateFired: null,
          latencyMs: 100,
        },
        {
          labelId: "b",
          question: "Q2",
          category: "single-chunk",
          answer: { status: "answered", answer: "", citations: [] },
          retrieved: mockChunks([{ source: "y.pdf" }]),
          topScore: 0.1,
          repairUsed: false,
          gateFired: null,
          latencyMs: 100,
        },
      ];

      const r = computeRecallAtK(labels, results, 6);
      expect(r.recall).toBe(0);
    });

    it("respects k by ignoring chunks beyond it", () => {
      const results: FixtureResult[] = [
        {
          labelId: "a",
          question: "Q1",
          category: "single-chunk",
          answer: { status: "answered", answer: "", citations: [] },
          retrieved: mockChunks([
            { source: "x.pdf", similarity: 0.9 },
            { source: "01.pdf", similarity: 0.3 },
          ]),
          topScore: 0.9,
          repairUsed: false,
          gateFired: null,
          latencyMs: 100,
        },
      ];

      const aLabel = labels[0]!;
      // k=1: only "x.pdf" is considered -> miss
      const r1 = computeRecallAtK([aLabel], results, 1);
      expect(r1.recall).toBe(0);

      // k=2: "01.pdf" is in top-2 -> hit
      const r2 = computeRecallAtK([aLabel], results, 2);
      expect(r2.recall).toBe(1);
    });
  });

  describe("abstention correctness", () => {
    it("computes FAR and FAR-INV correctly", () => {
      const results: FixtureResult[] = [
        {
          labelId: "ans",
          question: "Q",
          category: "single-chunk",
          expectedStatus: "answered",
          answer: { status: "insufficient_evidence", answer: "", citations: [] },
          retrieved: [],
          topScore: 0.1,
          repairUsed: false,
          gateFired: "relevance",
          latencyMs: 10,
        },
        {
          labelId: "unans",
          question: "Q",
          category: "unanswerable",
          expectedStatus: "insufficient_evidence",
          answer: { status: "answered", answer: "", citations: [] },
          retrieved: [],
          topScore: 0.6,
          repairUsed: false,
          gateFired: null,
          latencyMs: 10,
        },
      ];

      const a = computeAbstentionCorrectness(results);
      expect(a.shouldAnswerTotal).toBe(1);
      expect(a.shouldAbstainTotal).toBe(1);
      expect(a.falseAnswers).toBe(1); // answered when should abstain
      expect(a.falseRefusals).toBe(1); // abstained when should answer
      expect(a.far).toBe(1);
      expect(a.farInv).toBe(1);
    });

    it("handles perfect correctness", () => {
      const results: FixtureResult[] = [
        {
          labelId: "ans",
          question: "Q",
          category: "single-chunk",
          expectedStatus: "answered",
          answer: { status: "answered", answer: "", citations: [] },
          retrieved: [],
          topScore: 0.6,
          repairUsed: false,
          gateFired: null,
          latencyMs: 10,
        },
        {
          labelId: "unans",
          question: "Q",
          category: "unanswerable",
          expectedStatus: "insufficient_evidence",
          answer: { status: "insufficient_evidence", answer: "", citations: [] },
          retrieved: [],
          topScore: 0.1,
          repairUsed: false,
          gateFired: "relevance",
          latencyMs: 10,
        },
      ];

      const a = computeAbstentionCorrectness(results);
      expect(a.far).toBe(0);
      expect(a.farInv).toBe(0);
      expect(a.correctAnswers).toBe(1);
      expect(a.correctAbstentions).toBe(1);
    });
  });

  describe("citation integrity", () => {
    it("returns 1.0 when no citations are emitted", () => {
      const results: FixtureResult[] = [
        {
          labelId: "a",
          question: "Q",
          category: "single-chunk",
          answer: { status: "insufficient_evidence", answer: "", citations: [] },
          retrieved: [],
          topScore: 0,
          repairUsed: false,
          gateFired: "relevance",
          latencyMs: 10,
        },
      ];

      const c = computeCitationIntegrity(results);
      // only answered results are counted; no answered results -> integrity = 1 by convention
      expect(c.integrity).toBe(1);
      expect(c.totalAnswered).toBe(0);
    });

    it("returns 1.0 when citations verify", () => {
      const results: FixtureResult[] = [
        {
          labelId: "a",
          question: "Q",
          category: "single-chunk",
          answer: {
            status: "answered",
            answer: "",
            citations: [
              {
                chunk_id: "c-1",
                source: "doc.pdf",
                snippet: "sample text",
              },
            ],
          },
          retrieved: mockChunks([{ chunk_id: "c-1", text: "sample text" }]),
          topScore: 0.6,
          repairUsed: false,
          gateFired: null,
          latencyMs: 10,
        },
      ];

      const c = computeCitationIntegrity(results);
      expect(c.integrity).toBe(1);
      expect(c.totalVerifiedCitations).toBe(1);
    });

    it("returns <1 when snippet is not present", () => {
      const results: FixtureResult[] = [
        {
          labelId: "a",
          question: "Q",
          category: "single-chunk",
          answer: {
            status: "answered",
            answer: "",
            citations: [
              {
                chunk_id: "c-1",
                source: "doc.pdf",
                snippet: "does not exist",
              },
            ],
          },
          retrieved: mockChunks([{ chunk_id: "c-1", text: "sample text" }]),
          topScore: 0.6,
          repairUsed: false,
          gateFired: null,
          latencyMs: 10,
        },
      ];

      const c = computeCitationIntegrity(results);
      expect(c.integrity).toBeLessThan(1);
      expect(c.totalVerifiedCitations).toBe(0);
    });
  });
});
