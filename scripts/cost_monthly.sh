#!/usr/bin/env bash
set -euo pipefail
#
# Monthly cost aggregator (§17.4, NFR-CO-1).
#
# Queries query_audit for the last 30 days, applies the versioned price
# config, and reports total cost, per-query average, and cache savings
# info. Gemma does not support explicit prompt caching, so the savings
# rate is reported as "N/A" (prefix stability is prompt-engineering only).
#
# Usage:
#   bash scripts/cost_monthly.sh
#
# Requires: DATABASE_URL environment variable.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PRICING="${REPO_ROOT}/config/pricing.json"
DAYS=30

if [ ! -f "$PRICING" ]; then
    echo "ERROR: Pricing config not found at $PRICING" >&2
    exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: DATABASE_URL not set" >&2
    exit 1
fi

# Effective date and age check
EFF_DATE=$(jq -r '.effective_date // empty' "$PRICING")
if [ -n "$EFF_DATE" ]; then
    EPOCH_EFF=$(date -j -f '%Y-%m-%d' "$EFF_DATE" +%s 2>/dev/null || true)
    EPOCH_NOW=$(date +%s)
    if [ -n "${EPOCH_EFF:-}" ] && [ "$EPOCH_NOW" -gt "$((EPOCH_EFF + 90*86400))" ]; then
        echo "WARNING: Pricing config is older than 90 days ($EFF_DATE). Review current rates." >&2
    fi
fi

echo "=============================================="
echo " Monthly Cost Report (last ${DAYS} days)"
echo " Pricing effective: ${EFF_DATE:-unknown}"
echo "=============================================="

# query token counts from query_audit
SQL="
SELECT
    COUNT(*)::int AS query_count,
    COALESCE(SUM((token_counts->>'input_tokens')::numeric), 0)::numeric AS total_input_tokens,
    COALESCE(SUM((token_counts->>'output_tokens')::numeric), 0)::numeric AS total_output_tokens,
    COALESCE(SUM((token_counts->>'total_tokens')::numeric), 0)::numeric AS total_tokens
FROM query_audits
WHERE created_at >= NOW() - INTERVAL '${DAYS} days'
    AND status IN ('answered', 'insufficient_evidence');
"

RESULT=$(psql "$DATABASE_URL" -t -A -F',' -c "$SQL")

QUERY_COUNT=$(echo "$RESULT" | cut -d',' -f1)
TOTAL_INPUT=$(echo "$RESULT" | cut -d',' -f2)
TOTAL_OUTPUT=$(echo "$RESULT" | cut -d',' -f3)
TOTAL_TOKENS=$(echo "$RESULT" | cut -d',' -f4)

# pull prices from config
GEN_INPUT_PRICE=$(jq -r '.providers[] | select(.provider=="google") | .input_price_per_mtok // 0' "$PRICING")
GEN_OUTPUT_PRICE=$(jq -r '.providers[] | select(.provider=="google") | .output_price_per_mtok // 0' "$PRICING")
EMBED_PRICE=$(jq -r '.providers[] | select(.provider=="openai") | .input_price_per_mtok // 0' "$PRICING")

# compute costs (tokens -> millions)
gen_input_cost=$(echo "$TOTAL_INPUT * $GEN_INPUT_PRICE / 1000000" | bc -l 2>/dev/null || echo "0")
gen_output_cost=$(echo "$TOTAL_OUTPUT * $GEN_OUTPUT_PRICE / 1000000" | bc -l 2>/dev/null || echo "0")
# embedding cost is harder to derive from query_audit because embedding tokens
# are not recorded there (they're an ingest-time cost). For a query-only report
# we focus on generation costs and note embedding is ingest-time.
total_cost=$(echo "$gen_input_cost + $gen_output_cost" | bc -l 2>/dev/null || echo "0")

if [ "$QUERY_COUNT" -gt 0 ]; then
    avg_cost=$(echo "scale=6; $total_cost / $QUERY_COUNT" | bc -l 2>/dev/null || echo "0")
else
    avg_cost="0"
fi

echo ""
echo "Summary"
echo "  Queries in window:        $QUERY_COUNT"
echo "  Total input tokens:       $TOTAL_INPUT"
echo "  Total output tokens:      $TOTAL_OUTPUT"
echo "  Total tokens:             $TOTAL_TOKENS"
echo ""
echo "Generation cost (Gemma)"
echo "  Input cost:               \$$(printf '%.4f' "$gen_input_cost")"
echo "  Output cost:              \$$(printf '%.4f' "$gen_output_cost")"
echo "  Total generation cost:      \$$(printf '%.4f' "$total_cost")"
echo ""
echo "Per-query average:          \$$(printf '%.4f' "$avg_cost")"
echo ""
echo "Cache savings:              N/A (Gemma has no prompt-caching API)"
echo ""
echo "Embedding cost:             Not captured here (ingest-time; see embed logs)"
echo "=============================================="
