#!/usr/bin/env bash
set -euo pipefail
#
# deploy/restore.sh — Restore test with ANN sanity check.
#
# Steps:
#   1. Find newest backup dump.
#   2. Spin scratch pgvector/pgvector:pg16.
#   3. pg_restore the dump.
#   4. Run ANN sanity query: ORDER BY embedding <=> $1 LIMIT 3.
#   5. Assert rows returned → PASS/FAIL.
#
# This is the "restore test passed" criterion for nightly backups (§17).

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

BACKUP_DIR="/var/backups/pgvector"
DUMP_FILE=$(find "$BACKUP_DIR" -name "rag_*.dump" -type f -print0 | xargs -0 ls -t | head -n 1)

if [[ -z "$DUMP_FILE" ]]; then
  echo -e "${RED}FAIL: No backup dump found in $BACKUP_DIR${NC}"
  exit 1
fi

echo "[restore] Using newest dump: $DUMP_FILE"

# Spin scratch container
CONTAINER_NAME="docintel-restore-test"
DEFAULT_DB_USER="${POSTGRES_USER:-postgres}"
DEFAULT_DB_NAME="${POSTGRES_DB:-docintel}"

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
echo "[restore] Starting scratch pgvector/pgvector:pg16..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=restore_test \
  -e POSTGRES_USER="$DEFAULT_DB_USER" \
  -e POSTGRES_DB="$DEFAULT_DB_NAME" \
  -p 15432:5432 \
  pgvector/pgvector:pg16 \
  >/dev/null

# Wait for Postgres to accept connections
for i in {1..30}; do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$DEFAULT_DB_USER" -d "$DEFAULT_DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[restore] Restoring dump..."
docker exec -i "$CONTAINER_NAME" pg_restore \
  --no-owner \
  --dbname="$DEFAULT_DB_NAME" \
  --username="$DEFAULT_DB_USER" \
  -Fc < "$DUMP_FILE"

echo "[restore] Dump restored. Running ANN sanity query..."

ANN_RESULT=$(docker exec "$CONTAINER_NAME" psql -U "$DEFAULT_DB_USER" -d "$DEFAULT_DB_NAME" -Atc "
  SELECT chunk_id
  FROM chunks
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> (SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1)
  LIMIT 3;
" 2>/dev/null || echo "")

# Clean up
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

if [[ -n "$ANN_RESULT" ]]; then
  ROW_COUNT=$(echo "$ANN_RESULT" | grep -c "^" || true)
  if [[ "$ROW_COUNT" -ge 1 ]]; then
    echo -e "${GREEN}[restore] PASS — ANN sanity returned $ROW_COUNT row(s). Vectors survived.${NC}"
    exit 0
  fi
fi

echo -e "${RED}[restore] FAIL — ANN sanity query returned no rows. Restore is incomplete.${NC}"
exit 1
