// Markdown report generator for the eval suite. Reads eval results, computes
// metrics, and writes a markdown report suitable for CI artifacts and
// portfolio display.
import type {
  MetricSummary,
  CategoryBreakdown,
  EvalReport,
  FixtureResult,
  AnswerableLabel,
} from "./types.js";
import { computeRecallAtK } from "./metrics/recall.js";
import { computeAbstentionCorrectness } from "./metrics/abstention.js";
import { computeCitationIntegrity } from "./metrics/citations.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

interface RawResultsFile {
  generatedAt: string;
  answerable: FixtureResult[];
  unanswerable: FixtureResult[];
  adversarial: FixtureResult[];
}

async function loadRawResults(): Promise<RawResultsFile> {
  const raw = await readFile(join(__dirname, "results.json"), "utf-8");
  return JSON.parse(raw) as RawResultsFile;
}

async function loadAnswerableLabels(): Promise<AnswerableLabel[]> {
  const raw = await readFile(
    resolve(__dirname, "../fixtures/eval_corpus/questions/answerable.json"),
    "utf-8"
  );
  return JSON.parse(raw) as AnswerableLabel[];
}

async function loadThresholds(): Promise<{
  recall_at_k: { k: number; threshold: number };
  abstention: { false_answer_rate_max: number; false_refusal_rate_max: number };
  citation_integrity: { threshold: number };
}> {
  const raw = await readFile(join(__dirname, "thresholds.json"), "utf-8");
  return JSON.parse(raw);
}

function buildReport(
  raw: RawResultsFile,
  labels: AnswerableLabel[],
  thresholds: {
    recall_at_k: { k: number; threshold: number };
    abstention: { false_answer_rate_max: number; false_refusal_rate_max: number };
    citation_integrity: { threshold: number };
  }
): EvalReport {
  const allResults = [
    ...raw.answerable,
    ...raw.unanswerable,
    ...raw.adversarial,
  ];

  // metrics
  const recall = computeRecallAtK(labels, raw.answerable, thresholds.recall_at_k.k);
  const abstention = computeAbstentionCorrectness(allResults);
  const citation = computeCitationIntegrity(
    [...raw.answerable, ...raw.adversarial]
  );

  const metrics: MetricSummary[] = [
    {
      name: "recall@k",
      value: recall.recall,
      threshold: thresholds.recall_at_k.threshold,
      passed:
        recall.recall >= thresholds.recall_at_k.threshold,
      description: `Retriever: gold chunk present in top-${recall.k}`,
    },
    {
      name: "false_answer_rate",
      value: abstention.far,
      threshold: thresholds.abstention.false_answer_rate_max,
      passed:
        abstention.far <= thresholds.abstention.false_answer_rate_max,
      description:
        "Answering when should abstain / total should-abstain",
    },
    {
      name: "false_refusal_rate",
      value: abstention.farInv,
      threshold: thresholds.abstention.false_refusal_rate_max,
      passed:
        abstention.farInv <= thresholds.abstention.false_refusal_rate_max,
      description:
        "Abstaining when should answer / total should-answer",
    },
    {
      name: "citation_integrity",
      value: citation.integrity,
      threshold: thresholds.citation_integrity.threshold,
      passed:
        citation.integrity >= thresholds.citation_integrity.threshold,
      description:
        "Verified citations / emitted citations",
    },
  ];

  // category breakdowns
  const categoryMap = new Map<string, CategoryBreakdown>();

  function ensureCategory(name: string): CategoryBreakdown {
    if (!categoryMap.has(name)) {
      categoryMap.set(name, {
        category: name,
        total: 0,
        passed: 0,
        failed: 0,
        details: [],
      });
    }
    return categoryMap.get(name)!;
  }

  // process adversarial
  for (const r of raw.adversarial) {
    const cat = ensureCategory(r.category);
    cat.total++;
    const expected = r.expectedStatus ?? "unknown";
    const actual = r.answer.status;
    const ok = expected === actual;
    if (ok) cat.passed++;
    else cat.failed++;
    cat.details.push({
      labelId: r.labelId,
      expected,
      actual,
      reason: ok ? "matched" : `expected ${expected}, got ${actual}`,
    });
  }

  // process answerable by category
  const labelMap = new Map(labels.map((l) => [l.id, l]));
  for (const r of raw.answerable) {
    const label = labelMap.get(r.labelId);
    const catName = label?.category ?? "unknown";
    const cat = ensureCategory(catName);
    cat.total++;
    const expected = "answered";
    const actual = r.answer.status;
    const ok = actual === "answered";
    if (ok) cat.passed++;
    else cat.failed++;
    cat.details.push({
      labelId: r.labelId,
      expected,
      actual,
      reason: ok ? "matched" : `expected answered, got ${actual}`,
    });
  }

  // process unanswerable
  const unansCat = ensureCategory("unanswerable");
  for (const r of raw.unanswerable) {
    unansCat.total++;
    const expected = "insufficient_evidence";
    const actual = r.answer.status;
    const ok = actual === "insufficient_evidence";
    if (ok) unansCat.passed++;
    else unansCat.failed++;
    unansCat.details.push({
      labelId: r.labelId,
      expected,
      actual,
      reason: ok ? "matched" : `expected abstain, got ${actual}`,
    });
  }

  const failures: EvalReport["failures"] = [];
  for (const cat of categoryMap.values()) {
    for (const d of cat.details) {
      if (d.actual !== d.expected) {
        failures.push({
          labelId: d.labelId,
          question: allResults.find((r) => r.labelId === d.labelId)?.question ?? "",
          expected: d.expected ?? "unknown",
          actual: d.actual,
          reason: d.reason,
        });
      }
    }
  }

  return {
    generatedAt: raw.generatedAt,
    totalFixtures: allResults.length,
    metrics,
    categoryResults: Array.from(categoryMap.values()).sort((a, b) =>
      a.category.localeCompare(b.category)
    ),
    failures,
  };
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];

  lines.push(`# MICT-RAG-002 Eval Report`);
  lines.push(``);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Total fixtures: ${report.totalFixtures}`);
  lines.push(``);

  lines.push(`## Headline Metrics`);
  lines.push(``);
  lines.push(`| Metric | Value | Threshold | Pass |`);
  lines.push(`|--------|-------|-----------|------|`);
  for (const m of report.metrics) {
    const status = m.passed ? "PASS" : "FAIL";
    lines.push(
      `| ${m.name} | ${formatPercent(m.value)} | ${formatPercent(m.threshold)} | ${status} |`
    );
  }
  lines.push(``);

  const allPassed = report.metrics.every((m) => m.passed);
  lines.push(
    `**Overall: ${allPassed ? "PASS" : "FAIL"}**`
  );
  lines.push(``);

  lines.push(`## Category Breakdowns`);
  lines.push(``);
  for (const cat of report.categoryResults) {
    lines.push(`### ${cat.category}`);
    lines.push(``);
    lines.push(`- Total: ${cat.total}`);
    lines.push(`- Passed: ${cat.passed}`);
    lines.push(`- Failed: ${cat.failed}`);
    lines.push(``);
    if (cat.details.some((d) => d.actual !== d.expected)) {
      lines.push(`| ID | Expected | Actual | Reason |`);
      lines.push(`|----|----------|--------|--------|`);
      for (const d of cat.details) {
        if (d.actual !== d.expected) {
          lines.push(
            `| ${d.labelId} | ${d.expected} | ${d.actual} | ${d.reason} |`
          );
        }
      }
      lines.push(``);
    }
  }

  if (report.failures.length > 0) {
    lines.push(`## Failure Table`);
    lines.push(``);
    lines.push(`| ID | Question | Expected | Actual | Reason |`);
    lines.push(`|----|----------|----------|--------|--------|`);
    for (const f of report.failures) {
      lines.push(
        `| ${f.labelId} | ${f.question.slice(0, 60).replace(/\|/g, "\\|")}${
          f.question.length > 60 ? "..." : ""
        } | ${f.expected} | ${f.actual} | ${f.reason} |`
      );
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(
    `*Report generated by MICT-RAG-002 S04 eval suite. Recall@k measures retriever only; end-to-end correctness is captured by abstention + citation integrity together.*`
  );

  return lines.join("\n");
}

// CLI

async function main() {
  const raw = await loadRawResults();
  const labels = await loadAnswerableLabels();
  const thresholds = await loadThresholds();
  const report = buildReport(raw, labels, thresholds);
  const markdown = renderMarkdown(report);

  const { writeFile } = await import("node:fs/promises");
  const reportPath = resolve(__dirname, "report.md");
  await writeFile(reportPath, markdown, "utf-8");
  console.log(`[eval] Report written to ${reportPath}`);

  const passed = report.metrics.every((m) => m.passed);
  process.exit(passed ? 0 : 1);
}

if (import.meta.url === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[eval] Report generation failed:", err);
    process.exit(1);
  });
}
