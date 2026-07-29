#!/usr/bin/env bash
#
# Every endpoint, as a copy-pasteable script.
#
#   API_KEY=sk_live_... ./examples/curl.sh
#
# Optionally override the host:
#   API_KEY=sk_live_... BASE_URL=https://your-service.example ./examples/curl.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"

if [[ -z "${API_KEY:-}" ]]; then
  echo "API_KEY is not set. Create a tenant first:" >&2
  echo '  pnpm create-tenant "Acme Pharmacy" acme-pharmacy' >&2
  exit 1
fi

auth=(-H "Authorization: Bearer ${API_KEY}")
json=(-H "Content-Type: application/json")

echo "== GET /health (no auth) =="
curl -sS "${BASE_URL}/health"
echo -e "\n"

echo "== PUT /v1/documents =="
curl -sS -X PUT "${BASE_URL}/v1/documents" "${auth[@]}" "${json[@]}" -d '{
  "externalId": "sku-1",
  "title": "Paracetamol",
  "content": "Paracetamol 500mg tablets. Relieves fever, headache and mild pain.",
  "metadata": { "category": "analgesics", "price": 4.5 }
}'
echo -e "\n"

echo "== GET /v1/documents =="
curl -sS "${BASE_URL}/v1/documents?page=1&limit=20" "${auth[@]}"
echo -e "\n"

echo "== POST /v1/search (semantic: no shared words with the document) =="
curl -sS -X POST "${BASE_URL}/v1/search" "${auth[@]}" "${json[@]}" \
  -d '{ "query": "reduce a high temperature", "topK": 5 }'
echo -e "\n"

echo "== DELETE /v1/documents/sku-1 =="
curl -sS -X DELETE "${BASE_URL}/v1/documents/sku-1" "${auth[@]}"
echo -e "\n"

echo "== DELETE again -> 404 not_found =="
curl -sS -X DELETE "${BASE_URL}/v1/documents/sku-1" "${auth[@]}"
echo -e "\n"

echo "== No key -> 401 unauthorized =="
curl -sS -X POST "${BASE_URL}/v1/search" "${json[@]}" -d '{ "query": "anything" }'
echo -e "\n"
