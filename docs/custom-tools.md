# Custom tools

A custom tool is your own HTTPS endpoint, registered once, that the chat
model can call mid-conversation for data ingestion can't cover — order
status, inventory, account lookups. It works alongside the built-in
`search_knowledge` tool in every chat turn.

## Register a tool

```bash
curl -X POST https://your-instance/v1/tools \
  -H "Authorization: Bearer sk_live_..." -H "Content-Type: application/json" \
  -d '{
    "name": "lookup_order",
    "description": "Look up an order'\''s status by order ID.",
    "inputSchema": {
      "type": "object",
      "properties": { "orderId": { "type": "string" } },
      "required": ["orderId"]
    },
    "endpointUrl": "https://your-api.example.com/webhooks/lookup-order"
  }'
```

The response includes an `hmacSecret` (`whsec_...`) — **store it now.** It is
never shown again, and it's what proves a request calling your endpoint
really came from this service.

`inputSchema` is standard JSON Schema (draft-07), describing the arguments
the model will pass. It must be an object schema (`"type": "object"` at the
root) — that's what a tool's parameters always are.

An optional `authHeader` sends one static header (commonly `Authorization`)
on every call, if your endpoint needs its own auth on top of signature
verification:

```json
{ "authHeader": { "name": "Authorization", "value": "Bearer your-internal-key" } }
```

## Verify the signature

Every call to your endpoint carries two headers:

| Header | Contents |
|---|---|
| `X-Webhook-Timestamp` | Unix seconds when the request was signed |
| `X-Webhook-Signature` | `hex(HMAC-SHA256(hmacSecret, "${timestamp}.${rawBody}"))` |

Verify it (Node.js):

```js
const crypto = require("node:crypto");

function verify(rawBody, timestamp, signature, hmacSecret) {
  const expected = crypto
    .createHmac("sha256", hmacSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const withinWindow = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300; // 5 minutes
  return withinWindow && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

**Reject anything outside a ±5 minute window** — that's your replay
protection. We're the caller here, not the verifier, so an old captured
request replayed later is only stopped by your own timestamp check.

The request body:

```json
{ "toolName": "lookup_order", "arguments": { "orderId": "12345" }, "conversationId": "..." }
```

Respond with `200` and a JSON body — whatever you return becomes the tool's
result, which the model can use in its reply.

## Degradation

If your endpoint doesn't respond within 5 seconds, or responds with a
non-2xx status, the chat turn does **not** hang or fail — the model is told
the tool is unavailable and continues (it may apologize, retry a different
approach, or fall back to `search_knowledge`). Design your endpoint to fail
fast rather than hang, so a genuine outage degrades quickly rather than
tying up your own infrastructure for the full 5 seconds per call.

## List and revoke

```bash
curl https://your-instance/v1/tools -H "Authorization: Bearer sk_live_..."
curl -X DELETE https://your-instance/v1/tools/lookup_order -H "Authorization: Bearer sk_live_..."
```

There is no update-in-place yet — to change a URL or rotate a secret, revoke
and register again under a new name.
