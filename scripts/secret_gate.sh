#!/usr/bin/env bash
set -euo pipefail
#
# secret_gate.sh — scan tracked files for secrets before commit (S06).
#
# Fail conditions:
#   1. .env.production exists in working tree
#   2. Any tracked file contains HMAC_SECRET= followed by a non-placeholder value
#   3. Any tracked file contains well-known credential patterns (API keys, tokens, etc.)

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ERRORS=0

# 1. Block live production env file
echo "[gate] Checking for .env.production..."
if [[ -f .env.production ]]; then
  echo -e "${RED}FAIL: .env.production exists in working tree.${NC}"
  echo "       Remove it immediately; only .env.production.example may be committed."
  ERRORS=$((ERRORS + 1))
else
  echo "       OK — .env.production not present."
fi

# 2. Block HMAC_SECRET= with literal values in tracked files
echo "[gate] Scanning for HMAC_SECRET literals..."
MATCHES=$(git grep -n "HMAC_SECRET=" 2>/dev/null || true)
if [[ -n "${MATCHES}" ]]; then
  while IFS= read -r line; do
    # Skip commented-out lines and template lines
    if echo "$line" | grep -qE '^[^:]+:[0-9]+:#'; then continue; fi
    if echo "$line" | grep -qE '__REPLACE_ME__'; then continue; fi
    # Fail if it looks like a literal assignment, not just env var export
    if echo "$line" | grep -Eq 'HMAC_SECRET=["]?[^_"?{}$][^"]*["]?$'; then
      echo -e "${RED}FAIL: Literal HMAC_SECRET found in tracked file:${NC} $line"
      ERRORS=$((ERRORS + 1))
    fi
  done <<< "${MATCHES}"
fi

# 3. Block known secret patterns in tracked files
echo "[gate] Scanning for common secret patterns..."

PATTERN_1="sk-[a-zA-Z0-9]{20,}"              # OpenAI keys
PATTERN_2="AIza[0-9A-Za-z_-]{35,}"           # Google API keys
PATTERN_3="ghp_[a-zA-Z0-9]{36,}"            # GitHub PATs
PATTERN_4="dapi[a-zA-Z0-9]{32,}"             # DeepInfra / similar
PATTERN_5="Bearer [a-zA-Z0-9_-]{20,}"        # Inline bearer tokens
PATTERN_6="-----BEGIN .*PRIVATE KEY-----"

for pattern in "$PATTERN_1" "$PATTERN_2" "$PATTERN_3" "$PATTERN_4" "$PATTERN_5" "$PATTERN_6"; do
  MATCHES=$(git grep -n -E "${pattern}" 2>/dev/null || true)
  if [[ -n "${MATCHES}" ]]; then
    echo -e "${RED}FAIL: Potential secret pattern matched:${NC}"
    echo "${MATCHES}"
    ERRORS=$((ERRORS + 1))
  fi
done

# 4. Block credential references in workflow exports (if workflows/ exists)
if [[ -d workflows ]]; then
  echo "[gate] Checking workflow exports for inlined credentials..."
  WORKFLOW_MATCHES=$(git grep -n -E '"password"|"apiKey"|"token":\s*"[^$]' workflows/ 2>/dev/null || true)
  if [[ -n "$WORKFLOW_MATCHES" ]]; then
    echo -e "${RED}FAIL: Workflow exports may contain inlined credentials:${NC}"
    echo "$WORKFLOW_MATCHES"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Summary
if [[ "$ERRORS" -eq 0 ]]; then
  echo -e "${GREEN}[gate] PASS — no secrets detected in tracked files.${NC}"
  exit 0
else
  echo -e "${RED}[gate] FAIL — $ERRORS issue(s) found. Fix before committing.${NC}"
  exit 1
fi
