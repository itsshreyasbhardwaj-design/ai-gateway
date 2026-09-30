#!/usr/bin/env bash
#
# End-to-end smoke test against a running gateway.
#
#   AI_GATEWAY_API_KEY=aigw_... ./scripts/smoke.sh [BASE_URL]
#
# Exercises the demo flow from the README and fails loudly on any step, so it
# is usable as a deployment gate.
set -euo pipefail

BASE_URL="${1:-${AI_GATEWAY_URL:-http://localhost:8787}}"
KEY="${AI_GATEWAY_API_KEY:-}"

if [[ -z "$KEY" ]]; then
  echo "AI_GATEWAY_API_KEY is not set." >&2
  exit 78
fi

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1" >&2; exit 1; }

auth=(-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json')

echo "Smoke testing $BASE_URL"

curl -fsS "$BASE_URL/healthz" >/dev/null || fail "healthz"
pass "healthz"

curl -fsS "$BASE_URL/readyz" >/dev/null || fail "readyz (no providers registered?)"
pass "readyz"

models=$(curl -fsS "${auth[@]}" "$BASE_URL/v1/models") || fail "GET /v1/models"
count=$(printf '%s' "$models" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["data"]))')
[[ "$count" -gt 0 ]] || fail "no models available to this key"
pass "GET /v1/models ($count models)"

completion=$(curl -fsS "${auth[@]}" -X POST "$BASE_URL/v1/chat/completions" \
  -d '{"model":"gateway/auto","messages":[{"role":"user","content":"smoke test"}]}') || fail "chat completion"
request_id=$(printf '%s' "$completion" | python3 -c 'import sys,json; print(json.load(sys.stdin)["gateway"]["requestId"])')
pass "POST /v1/chat/completions ($request_id)"

stream=$(curl -fsS "${auth[@]}" -X POST "$BASE_URL/v1/chat/completions" \
  -d '{"model":"gateway/auto","messages":[{"role":"user","content":"stream"}],"stream":true}') || fail "streaming"
printf '%s' "$stream" | grep -q 'data: \[DONE\]' || fail "stream did not terminate with [DONE]"
printf '%s' "$stream" | grep -q '"gateway"' || fail "stream did not carry a routing receipt"
pass "streaming with terminal receipt"

trace=$(curl -fsS "${auth[@]}" "$BASE_URL/api/v1/requests/$request_id") || fail "request trace"
steps=$(printf '%s' "$trace" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["steps"]))')
[[ "$steps" -ge 8 ]] || fail "trace has only $steps steps"
pass "request trace ($steps steps)"

curl -fsS "${auth[@]}" "$BASE_URL/api/v1/usage?range=24h" >/dev/null || fail "usage"
pass "usage analytics"

curl -fsS "$BASE_URL/metrics" | grep -q aigw_requests_total || fail "metrics"
pass "prometheus metrics"

echo
echo "All checks passed."
