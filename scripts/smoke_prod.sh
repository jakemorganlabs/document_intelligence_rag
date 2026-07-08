#!/usr/bin/env bash
set -euo pipefail
#
# scripts/smoke_prod.sh — HMAC-signed external smoke test against production.
#
# Usage (from any laptop with bash + curl + openssl + jq):
#   HMAC_SECRET="your-secret" bash scripts/smoke_prod.sh
#
# Asserts:
#   - Signed request → 200 + status answered + citations non-empty
#   - Unsigned request → rejected (401)  — edge-enforcement exit criterion

URL="${TARGET_URL:-https://docs.jakemorganlabs.dev/query}"
HEALTH_URL="${HEALTH_URL:-https://docs.jakemorganlabs.dev/health}"
SECRET="${HMAC_SECRET:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
ERRORS=0

if [[ -z "$SECRET" ]]; then
  echo "ERROR: set HMAC_SECRET environment variable"
  exit 1
fi

echo "[smoke] Target: $URL"

# --- 1. Signed request should succeed ---
BODY='{"question":"What is the maximum permanent link length?"}'
TIMESTAMP=$(date +%s)
PAYLOAD="${TIMESTAMP}${BODY}"
SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

echo "[smoke] Firing signed request..."
SIGNED_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "X-Signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "$URL")

HTTP_CODE=$(echo "$SIGNED_RESPONSE" | tail -n 1)
RESPONSE_BODY=$(echo "$SIGNED_RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" != "200" ]]; then
  echo -e "${RED}[smoke] FAIL signed: HTTP $HTTP_CODE${NC}"
  ERRORS=$((ERRORS + 1))
else
  CITATION_COUNT=$(echo "$RESPONSE_BODY" | jq '.citations | length' 2>/dev/null || echo "0")
  if [[ "$CITATION_COUNT" -ge 1 ]]; then
    echo -e "${GREEN}[smoke] PASS signed: 200 + $CITATION_COUNT citation(s)${NC}"
  else
    echo -e "${RED}[smoke] FAIL signed: 200 but citations array empty${NC}"
    ERRORS=$((ERRORS + 1))
  fi
fi

# --- 2. Unsigned request should be rejected ---
echo "[smoke] Firing unsigned request..."
UNSIGNED_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "$URL")

if [[ "$UNSIGNED_RESPONSE" == "401" ]]; then
  echo -e "${GREEN}[smoke] PASS unsigned: rejected with 401${NC}"
else
  echo -e "${RED}[smoke] FAIL unsigned: expected 401, got $UNSIGNED_RESPONSE${NC}"
  ERRORS=$((ERRORS + 1))
fi

# --- 3. Health check should return 200 without auth (no model call) ---
echo "[smoke] Firing health check..."
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL")
if [[ "$HEALTH_CODE" == "200" ]]; then
  echo -e "${GREEN}[smoke] PASS health: 200${NC}"
else
  echo -e "${RED}[smoke] FAIL health: expected 200, got $HEALTH_CODE${NC}"
  ERRORS=$((ERRORS + 1))
fi

if [[ "$ERRORS" -eq 0 ]]; then
  echo -e "${GREEN}[smoke] ALL PASSED${NC}"
  exit 0
else
  echo -e "${RED}[smoke] FAILED with $ERRORS error(s)${NC}"
  exit 1
fi
