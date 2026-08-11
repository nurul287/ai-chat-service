# Quickstart

From nothing to a working semantic search in about ten minutes. Every step is
shown in both `curl` and Node `fetch`.

You will need the service running. If you are pointing at someone else's
deployment, skip to step 2 and use their base URL; if you are running it
yourself, see [self-hosting.md](self-hosting.md) first.

## 1. Get an API key

Keys are issued per tenant. From the service's repo:

```bash
pnpm create-tenant "Acme Pharmacy" acme-pharmacy
```

```
Tenant created: Acme Pharmacy (acme-pharmacy)
Tenant ID:      3f2b1c8e-...
API key:        sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Copy the key now.** It is stored only as a SHA-256 hash, so it is shown once
and can never be displayed again. A lost key must be revoked and reissued.

Everything below assumes:

```bash
export API_KEY=sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export BASE_URL=http://localhost:4000
```

## 2. Push your first document

`externalId` is **your** identifier — a SKU, a row id, a file path, whatever you
already use. Pushing the same `externalId` again replaces the document instead
of duplicating it, which is what makes a re-sync loop safe to run on a schedule.

```bash
curl -s -X PUT "$BASE_URL/v1/documents" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "sku-1",
    "title": "Paracetamol",
    "content": "Paracetamol 500mg tablets. Relieves fever, headache and mild pain.",
    "metadata": { "category": "analgesics", "price": 4.5 }
  }'
```

```js
const res = await fetch(`${BASE_URL}/v1/documents`, {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    externalId: "sku-1",
    title: "Paracetamol",
    content: "Paracetamol 500mg tablets. Relieves fever, headache and mild pain.",
    metadata: { category: "analgesics", price: 4.5 },
  }),
});
const { data } = await res.json();
console.log(data.externalId); // "sku-1"
```

The document is chunked and embedded before the call returns, so it is
searchable immediately — there is no indexing delay to poll for.

## 3. Search it

Use a query that shares **no words** with the document. That is the point: this
is semantic retrieval, not string matching.

```bash
curl -s -X POST "$BASE_URL/v1/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "query": "reduce a high temperature" }'
```

```js
const res = await fetch(`${BASE_URL}/v1/search`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: "reduce a high temperature" }),
});
const { data } = await res.json();
console.log(data[0].externalId); // "sku-1"
```

```json
{
  "data": [
    {
      "documentId": "…",
      "externalId": "sku-1",
      "title": "Paracetamol",
      "content": "Paracetamol 500mg tablets. Relieves fever, headache and mild pain.",
      "metadata": { "category": "analgesics", "price": 4.5 }
    }
  ]
}
```

Nothing in that query appears in the document — no "paracetamol", no "fever",
no "pain". The match comes from the vector leg. Add `"topK": 10` to the body to
ask for more results (default 5, maximum 20).

## 4. Have a conversation

`POST /v1/chat` streams a reply over Server-Sent Events, and can call
`search_knowledge` — the same retrieval you just used directly — mid-reply to
cite your documents.

```bash
curl -N -X POST "$BASE_URL/v1/chat" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId": "customer-482", "message": "Do you have anything for a headache?"}'
```

```
event: token
data: {"text":"Para"}

event: token
data: {"text":"cetamol should help."}

event: sources
data: {"documents":[{"externalId":"sku-1","title":"Paracetamol", ...}]}

event: done
data: {"conversationId":"...","messageId":"..."}
```

The stream carries five event types: `token`, `sources`, `tool_call`, `done`
and `error`. `tool_call` only shows up once you have registered a
[custom tool](custom-tools.md) and the model calls it — it carries that
tool's name, the arguments the model passed, and your endpoint's raw result.

The response has no `conversationId` in the request above — the `done` event
is how you learn the one that was created. Send it back on the next call to
continue the same thread:

```bash
curl -N -X POST "$BASE_URL/v1/chat" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId": "customer-482", "conversationId": "<from the done event>", "message": "How many should I take?"}'
```

See [`examples/node/chat.js`](../examples/node/chat.js) for consuming this
from Node with plain `fetch`, and [errors.md](errors.md) for what a mid-stream
failure looks like.

## 5. List and delete

```bash
curl -s "$BASE_URL/v1/documents?page=1&limit=20" -H "Authorization: Bearer $API_KEY"

curl -s -X DELETE "$BASE_URL/v1/documents/sku-1" -H "Authorization: Bearer $API_KEY"
```

Both are scoped to your tenant. Deleting an `externalId` you do not own returns
`404`, identical to deleting one that does not exist — see
[errors.md](errors.md) for why.

## What next

- [concepts.md](concepts.md) — what a document, a chunk, and hybrid retrieval
  actually are
- [authentication.md](authentication.md) — key handling, rotation, and the one
  rule you must not break
- [errors.md](errors.md) — the error contract
- `GET /docs` — the full browsable API reference for the instance you are
  talking to
- `GET /openapi.json` — the machine-readable spec, for generating a typed client
- [`examples/`](../examples/) — a copy-pasteable shell script and a runnable
  Node script
