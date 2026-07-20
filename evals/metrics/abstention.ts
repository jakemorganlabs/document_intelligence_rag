// Abstention correctness metric (§18, FR-AB-4).
//
// Builds a confusion matrix from labelled fixtures and system outputs.
//
// Rows:
//   - labelled answerable (should answer)
//   - labelled unanswerable (should abstain)
//   - labelled adversarial with expected_status = "answered"
//   - labelled adversarial with expected_status = "insufficient_evidence"
//
// Cols:
//   - system answered
//   - system abstained
//
// FAR (False Answer Rate): answered when should abstain / total should-abstain
// FAR-INV (False Abstention Rate): abstained when should answer / total should-answer
import type { FixtureResult } from "../types.js";

export interface AbstentionResult {
  total: number;
  shouldAnswerTotal: number;
  shouldAbstainTotal: number;
  correctAnswers: number;
  correctAbstentions: number;
  // answered when should abstain
  falseAnswers: number;
  // abstained when should answer
  falseRefusals: number;
  far: number; // false answer rate
  farInv: number; // false refusal rate
  perFixture: Array<{
    labelId: string;
    question: string;
    expected: string;
    actual: string;
    correct: boolean;
  }>;
}

export function computeAbstentionCorrectness(
  results: FixtureResult[]
): AbstentionResult {
  let shouldAnswerTotal = 0;
  let shouldAbstainTotal = 0;
  let correctAnswers = 0;
  let correctAbstentions = 0;
  let falseAnswers = 0;
  let falseRefusals = 0;

  const perFixture = results.map((r) => {
    const expected = r.expectedStatus ?? null;
    const actual = r.answer.status;
    let correct = false;

    if (expected === "answered") {
      shouldAnswerTotal++;
      if (actual === "answered") {
        correctAnswers++;
        correct = true;
      } else {
        falseRefusals++;
      }
    } else if (expected === "insufficient_evidence") {
      shouldAbstainTotal++;
      if (actual === "insufficient_evidence") {
        correctAbstentions++;
        correct = true;
      } else {
        falseAnswers++;
      }
    }

    return {
      labelId: r.labelId,
      question: r.question,
      expected: expected ?? "unknown",
      actual,
      correct,
    };
  });

  const far = shouldAbstainTotal > 0 ? falseAnswers / shouldAbstainTotal : 0;
  const farInv = shouldAnswerTotal > 0 ? falseRefusals / shouldAnswerTotal : 0;

  return {
    total: results.length,
    shouldAnswerTotal,
    shouldAbstainTotal,
    correctAnswers,
    correctAbstentions,
    falseAnswers,
    falseRefusals,
    far,
    farInv,
    perFixture,
  };
}
