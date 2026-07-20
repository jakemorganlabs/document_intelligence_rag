#!/usr/bin/env bash
set -euo pipefail
#
# S02 Ingest Smoke Test
#
# Usage (from repo root):
#   bash scripts/ingest_smoke.sh
#
# Prerequisites:
#   - Postgres + pgvector running and accessible via DATABASE_URL
#   - EMBEDDING_PROVIDER_API_KEY set (or test runs without embedding)
#   - Python3 + pypdf installed
#

echo "=============================================="
echo "S02 Ingest Pipeline Smoke Test"
echo "=============================================="

# 1. Ensure migration is current
echo ""
echo "Step 1: Run migrations..."
npx tsx scripts/migrate-fresh.ts

# 2. Ingest 3 PDFs
echo ""
echo "Step 2: Ingest 3 smoke PDFs..."
npx tsx scripts/ingest.ts fixtures/smoke_pdfs/

# 3. Re-ingest the same 3 PDFs (should be no-op)
echo ""
echo "Step 3: Re-ingest same PDFs (should all be SKIPPED)..."
npx tsx scripts/ingest.ts fixtures/smoke_pdfs/

# 4. Create a deliberately corrupt PDF and add it to a batch
echo ""
echo "Step 4: Create corrupt PDF and ingest..."
SMOKE_DIR="fixtures/smoke_pdfs"
head -c 50 "$SMOKE_DIR/smoke_01_guidelines.pdf" > "$SMOKE_DIR/corrupt.pdf"
npx tsx scripts/ingest.ts "$SMOKE_DIR/"
rm -f "$SMOKE_DIR/corrupt.pdf"

# 5. ANN sanity check
echo ""
echo "Step 5: ANN top-6 cosine query (requires at least one embedded chunk)..."
npx tsx scripts/ann_sanity.ts

echo ""
echo "=============================================="
echo "Smoke test complete."
echo "=============================================="
