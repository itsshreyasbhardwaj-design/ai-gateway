#!/usr/bin/env bash
#
# The gateway's HTTP surface, with nothing between you and it.
set -euo pipefail

: "${AI_GATEWAY_API_KEY:?set AI_GATEWAY_API_KEY}"
BASE="${AI_GATEWAY_URL:-http://localhost:8787}"
auth=(-H "Authorization: Bearer $AI_GATEWAY_API_KEY" -H 'Content-Type: application/json')

echo '── models this key may use ─────────────────────────────────────────────'
curl -s "${auth[@]}" "$BASE/v1/models" | python3 -m json.tool | head -40

echo
echo '── a completion ────────────────────────────────────────────────────────'
# `gateway/auto` lets the router choose; a concrete "provider/model" pins it.
curl -s "${auth[@]}" -X POST "$BASE/v1/chat/completions" -d '{
  "model": "gateway/auto",
  "messages": [{"role": "user", "content": "Name three columnar storage formats."}]
}' | python3 -m json.tool

echo
echo '── the same request, streamed ──────────────────────────────────────────'
# The last data frame before [DONE] is the gateway routing receipt. Clients
# written against OpenAI ignore it; clients that want it get full detail.
curl -sN "${auth[@]}" -X POST "$BASE/v1/chat/completions" -d '{
  "model": "gateway/auto",
  "messages": [{"role": "user", "content": "Count to five."}],
  "stream": true
}'

echo
echo '── controlling the route ───────────────────────────────────────────────'
# Ask for the cheapest eligible model, with an explicit candidate list and
# fallback disabled for this one request.
curl -s "${auth[@]}" -X POST "$BASE/v1/chat/completions" -d '{
  "model": "gateway/cheapest",
  "messages": [{"role": "user", "content": "Hello"}],
  "gateway": {
    "strategy": "lowest_cost",
    "fallback": false,
    "tags": ["example"]
  }
}' | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin)["gateway"], indent=2))'

echo
echo '── a routing dry-run: contacts no provider, costs nothing ──────────────'
curl -s "${auth[@]}" -X POST "$BASE/api/v1/playground/route-test" -d '{
  "model": "gateway/auto",
  "prompt": "Explain this SQL query."
}' | python3 -m json.tool

echo
echo '── current rate-limit state ────────────────────────────────────────────'
curl -s "${auth[@]}" "$BASE/v1/limits" | python3 -m json.tool

echo
echo '── embeddings ──────────────────────────────────────────────────────────'
curl -s "${auth[@]}" -X POST "$BASE/v1/embeddings" -d '{
  "model": "mock/mock-embed",
  "input": ["first document", "second document"]
}' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["data"]), "vectors,", len(d["data"][0]["embedding"]), "dimensions")'
