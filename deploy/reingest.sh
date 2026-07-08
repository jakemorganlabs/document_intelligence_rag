#!/usr/bin/env bash
set -euo pipefail
#
# deploy/reingest.sh — Re-ingest the entire /corpus after restore or corpus drop (§10.1).
#
# Usage (from repo root):
#   bash deploy/reingest.sh
#
# Exits non-zero if zero files ingested, which catches the silent UID/GID skip
# from §7 (containers cannot read the corpus bind-mount).

CORPUS_DIR="./corpus"
INGESTED=0
SKIPPED=0

if [[ ! -d "$CORPUS_DIR" ]]; then
  echo "[reingest] FAIL: corpus directory does not exist: $CORPUS_DIR"
  exit 1
fi

echo "[reingest] Scanning $CORPUS_DIR for PDFs..."

for pdf in "$CORPUS_DIR"/*.pdf; do
  # If no PDFs match, the literal string '*.pdf' will be returned — skip it
  [[ "$pdf" == "$CORPUS_DIR/*.pdf" ]] && continue

  echo "[reingest] Ingesting $(basename "$pdf")..."
  RESULT=$(npx tsx scripts/ingest.ts "$pdf" 2>&1) || true
  if echo "$RESULT" | grep -q "skipped"; then
    SKIPPED=$((SKIPPED + 1))
  elif echo "$RESULT" | grep -q "indexed"; then
    INGESTED=$((INGESTED + 1))
  fi
done

echo "[reingest] Done. Ingested: $INGESTED | Skipped: $SKIPPED"

if [[ "$INGESTED" -eq 0 ]]; then
  echo "[reingest] FAIL: zero files ingested. Check UID/GID on the corpus mount."
  exit 1
fi

exit 0
