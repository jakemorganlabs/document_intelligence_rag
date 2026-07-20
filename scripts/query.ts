// CLI query script: run a single question through the pipeline.
//
// Usage: npx tsx scripts/query.ts "What is the maximum permanent link length?"
import "dotenv/config";
import { queryDocument } from "../src/query.js";

const question = process.argv[2]?.trim();
if (!question) {
  console.error("Usage: npx tsx scripts/query.ts <question>");
  process.exit(1);
}

async function main() {
  const result = await queryDocument({ question: question! });
  console.log(JSON.stringify({
    status: result.answer.status,
    answer: result.answer.answer,
    citations: result.answer.citations,
    audit_id: result.audit.audit_id,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
