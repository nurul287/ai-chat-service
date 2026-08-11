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

### Name rules

`name` is what the model sees and calls, so it has to be a valid identifier:

- must match `^[a-zA-Z_][a-zA-Z0-9_]*$` — letters, digits and underscores,
  never starting with a digit
- 1–64 characters
- `search_knowledge` is **reserved** for the built-in retrieval tool.
  Registering it is rejected with `invalid_request` rather than silently
  shadowing the built-in.

A name that breaks any of these comes back as `invalid_request` at
registration time, not as a surprise mid-conversation.

### Endpoint URL rules

`endpointUrl` must be **`https://`** on a **publicly reachable host**. This
service calls your endpoint server-side, so a URL pointing inward would let a
registered tool reach infrastructure the caller could not otherwise touch.
These are rejected with `invalid_request`:

- any scheme other than `https:` (including plain `http://`)
- loopback (`127.0.0.0/8`, `::1`, `localhost`)
- link-local (`169.254.0.0/16` — the cloud metadata endpoint — and `fe80::/10`)
- private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`)
- hostnames ending in `.internal` or `.local`

The check reads the literal host in the URL; it does not resolve DNS.

### One static auth header

An optional `authHeader` sends one static header (commonly `Authorization`)
on every call, if your endpoint needs its own auth on top of signature
verification:

```json
{ "authHeader": { "name": "Authorization", "value": "Bearer your-internal-key" } }
```

`Content-Type`, `X-Webhook-Timestamp` and `X-Webhook-Signature` are rejected
as header names — this service sets all three on every call, and letting one
be overridden would silently break the very signature you are meant to
verify.

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
  const expected = Buffer.from(
    crypto.createHmac("sha256", hmacSecret).update(`${timestamp}.${rawBody}`).digest("hex"),
  );
  const received = Buffer.from(String(signature ?? ""));

  const withinWindow = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300; // 5 minutes
  // timingSafeEqual THROWS on differing lengths rather than returning false,
  // so the length check has to come first — a truncated or absent signature
  // header would otherwise crash this function instead of rejecting.
  return (
    withinWindow &&
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
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

Responses larger than **1MB** are rejected and treated as a failed call (see
[Degradation](#degradation)). A tool result is meant to be a small payload
the model can reason about, not a bulk export.

## Your tool's result is visible to the chat client

**Whatever JSON your endpoint returns is streamed to whoever is viewing that
conversation.** It is not kept server-side and it is not summarised first —
it goes out on the wire as a `tool_call` SSE event, alongside the tool's name
and the arguments the model passed:

```
event: tool_call
data: {"toolName":"lookup_order","arguments":{"orderId":"12345"},"result":{"status":"shipped"}}
```

This is the same transparency principle as `search_knowledge`, whose
retrieved documents go back as a `sources` event: a client should be able to
show *why* the assistant said what it said, without re-querying and without
trusting the model's paraphrase of its own tool call.

The practical consequence: **treat your endpoint's response body as
user-visible.** Return the fields the model needs to answer, and nothing
more. Internal ids, cost prices, other customers' data, PII beyond what the
end user is entitled to see — leave it out of the response rather than
relying on the model not to repeat it, because the raw JSON reaches the
client whether the model mentions it or not.

## Degradation

If your endpoint doesn't respond within 5 seconds, responds with a non-2xx
status, or returns an oversized body, the chat turn does **not** hang or
fail — the model is told
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
