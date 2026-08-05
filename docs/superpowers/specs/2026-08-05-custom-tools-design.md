# Sprint 3: Custom Tools — Design

**Status:** Approved, ready for implementation planning.

## Goal

Let a tenant register their own HTTPS endpoint as a tool the chat model can call
mid-conversation for live data (order status, inventory levels, account
lookups — anything static ingestion can't cover). This is Sprint 3 of the
6-sprint roadmap (`docs/plans/roadmap.md`), depending on Sprint 2 (merged).

**Exit gate** (from the roadmap, unchanged): HMAC signature verified
end-to-end; a failing/slow tenant endpoint degrades gracefully instead of
hanging the chat.

## Non-goals (explicitly deferred)

- **Update/rotate-in-place for a registered tool.** A tenant who needs to
  change a URL or secret revokes and re-registers under a new name. Simplest
  possible surface for a first cut; add rotation later if it turns out to
  matter.
- **Caching of compiled tool definitions.** Every chat turn fetches and
  compiles this tenant's active tools fresh. No rate limits exist yet
  (Sprint 6), so this isn't a bottleneck worth the invalidation complexity.
- **Circuit breaker across turns/conversations.** A failing tenant endpoint
  degrades gracefully *within* the turn that called it (timeout → fallback
  result). Nothing tracks failures across turns or throttles future calls to
  a known-bad endpoint tenant-wide. Revisit if a real tenant's endpoint proves
  this is needed.
- **A per-tenant cap on the number of registered tools.** Quotas belong to
  Sprint 6 alongside rate limiting.

## Data model

New table `tenant_tools`, following the same tenant-scoping pattern as every
existing table (`tenant_id` FK, cascade delete, indexed):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, pk | |
| `tenant_id` | uuid, fk → `tenants.id` | cascade delete |
| `name` | text | the AI SDK tool name the model sees, e.g. `lookup_order` |
| `description` | text | shown to the model, same role as `search_knowledge`'s description |
| `input_schema` | jsonb | the tenant's raw JSON Schema (draft-07) for the tool's parameters |
| `endpoint_url` | text | the tenant's HTTPS URL we call |
| `hmac_secret_encrypted` | text | AES-256-GCM ciphertext — **not** hashed, because we must read the real secret back to sign each outgoing request |
| `auth_header_name` | text, nullable | e.g. `Authorization` |
| `auth_header_value_encrypted` | text, nullable | same encrypted-at-rest treatment as the HMAC secret |
| `revoked_at` | timestamptz, nullable | soft delete, matching `api_keys`'s existing pattern |
| `created_at` / `updated_at` | timestamptz | standard |

Constraints:
- A **partial unique index** on `(tenant_id, name) where revoked_at is null`,
  so a revoked name doesn't block re-registration under the same name, but
  two simultaneously-active tools can't collide. Verified against Drizzle's
  real API: plain `unique()` builds a table-level `UNIQUE` constraint with no
  `.where()` method — partial conditions require `uniqueIndex(name).on(tenantId, name).where(sql\`revoked_at is null\`)`,
  confirmed against the installed `drizzle-orm/pg-core/indexes.d.ts`, which
  is the builder this table actually needs.
- `name` is rejected at the application layer (not the DB) if it equals
  `search_knowledge` or any other built-in tool name — returns
  `invalid_request`.

### Reversible encryption is new

Every existing secret in this codebase (`api_keys.key_hash`) is one-way
hashed — verified by comparison, never read back. The HMAC secret and the
optional auth header value have the opposite requirement: we must decrypt
them to sign and authenticate outgoing requests. This needs a genuinely new
primitive: `src/lib/crypto.ts`, AES-256-GCM, keyed by a new
`TOOL_SECRETS_ENCRYPTION_KEY` env var (validated at boot via the existing
Zod config pattern, same as every other required variable). Stored format:
`iv:authTag:ciphertext`, base64-encoded segments. Own focused unit tests
(`src/lib/crypto.test.ts`): encrypt→decrypt round-trips to the original
plaintext, and the stored ciphertext is never equal to the plaintext.

## Registration API

Three new authenticated `/v1/tools` routes, same `sk_live_…` bearer auth as
every other route:

### `POST /v1/tools`

Body:
```json
{
  "name": "lookup_order",
  "description": "Look up an order's status by order ID.",
  "inputSchema": {
    "type": "object",
    "properties": { "orderId": { "type": "string" } },
    "required": ["orderId"]
  },
  "endpointUrl": "https://tenant.example.com/webhooks/lookup-order",
  "authHeader": { "name": "Authorization", "value": "Bearer tenant-internal-key" }
}
```
`authHeader` is optional. `inputSchema` is validated as well-formed JSON
Schema at request time — a malformed schema is rejected with
`invalid_request`, never discovered later at call time.

Response (**200**, secret shown exactly once, same pattern as
`issueApiKey`):
```json
{
  "id": "...",
  "name": "lookup_order",
  "description": "...",
  "inputSchema": { ... },
  "endpointUrl": "...",
  "hmacSecret": "whsec_...",
  "createdAt": "..."
}
```
`hmacSecret` never appears in any other response, ever.

### `GET /v1/tools`

Lists this tenant's non-revoked tools. Public fields only — `hmacSecret`,
`authHeader`'s value are never serialized here or anywhere else post-creation.

### `DELETE /v1/tools/:name`

Revokes (soft delete via `revoked_at`), addressed by `name` — consistent with
`DELETE /v1/documents/:externalId` addressing by the tenant's own identifier
rather than an internal uuid. A revoked tool is immediately excluded from the
next chat turn's tool set (Sprint 3's runtime fetches active tools fresh
every turn — see below — so this requires no cache invalidation).

## HMAC signing scheme

Request body sent to the tenant's endpoint:
```json
{ "toolName": "lookup_order", "arguments": { "orderId": "12345" }, "conversationId": "..." }
```

Signing follows the Stripe/GitHub webhook convention:
- `signedPayload = "${unixTimestampSeconds}.${rawJsonBody}"`
- `signature = hex(HMAC-SHA256(hmacSecret, signedPayload))`
- Sent as two headers: `X-Webhook-Timestamp` and `X-Webhook-Signature`

We are the caller here, not the verifier, so replay protection is the
tenant's responsibility on their end — documented in `docs/custom-tools.md`
with a recommended ±5-minute acceptance window and a Node.js code sample
that verifies a signature correctly.

Timeout: **5 seconds** on the outbound call. On timeout or a non-2xx
response, the tool's result fed back to the model is a structured
"this tool is unavailable right now" message — the call never throws, and
the chat turn always reaches its `done` event.

## Runtime integration

`src/tools/tenant-tools.service.ts`:
```ts
listActiveTools(tenantId: string): Promise<TenantTool[]>
```
One query per chat turn for this tenant's non-revoked tools, decrypting
`hmacSecretEncrypted` / `authHeaderValueEncrypted` in memory only for the
lifetime of that turn — never persisted decrypted, never logged.

`src/chat/tools/custom-tool.ts`:
```ts
buildCustomTool(tenantTool: TenantTool, conversationId: string): DynamicTool
```
Uses the AI SDK's `jsonSchema()` helper (from `ai`, re-exported from
`@ai-sdk/provider-utils`) to wrap the tenant's raw JSON Schema directly as a
valid tool schema — **no JSON-Schema-to-Zod conversion library needed**,
confirmed against the installed package's real type declarations. Combined
with `dynamicTool()` (built for exactly this case: a tool whose input shape
isn't known until runtime):
```ts
dynamicTool({
  description: tenantTool.description,
  inputSchema: jsonSchema(tenantTool.inputSchema),
  execute: async (args) => callTenantEndpoint(tenantTool, args, conversationId),
})
```
`callTenantEndpoint` does the signing above and the 5s-timeout fetch,
returning either the tenant's JSON response or the structured "unavailable"
fallback — it never throws, matching `search_knowledge`'s existing contract.

`src/chat/chat.service.ts` changes minimally. Where it currently builds:
```ts
tools: { search_knowledge: searchKnowledgeTool(input.tenantId) }
```
it now does:
```ts
const customTools = await listActiveTools(input.tenantId);
const tools = {
  search_knowledge: searchKnowledgeTool(input.tenantId),
  ...Object.fromEntries(customTools.map((t) => [t.name, buildCustomTool(t, conversation.id)])),
};
```
`stopWhen: isStepCount(MAX_TOOL_LOOP_STEPS)` (fixed in Sprint 2) is unchanged
and already correctly generic — it doesn't care how many tools exist or
which one gets called, so Sprint 2's fix already covers Sprint 3's new tool
calls for free.

## Testing and isolation

Following this project's established pattern — every table/endpoint gets an
explicit cross-tenant test, not just a happy path:

- **Isolation**: tenant B's key never sees or can name-collide with tenant
  A's tools; `GET /v1/tools` returns only the calling tenant's rows.
- **Secret hygiene**: `GET /v1/tools` never serializes `hmacSecret` or the
  auth header value, at any point after creation.
- **Reserved name**: registering `search_knowledge` is rejected with
  `invalid_request`.
- **HMAC contract test**: a local test HTTP server captures the actual
  outgoing request our code sends; the test verifies the signature using
  nothing but the secret returned from registration, the timestamp header,
  and the raw body — proving a real third party could implement
  verification correctly from the docs alone. This is what makes the exit
  gate a proven fact rather than an assertion.
- **Graceful degradation**: a test tool pointed at a never-responding
  endpoint confirms the call resolves to the fallback within ~5s (never
  hangs), and the turn still reaches `done`; same for a non-2xx response.
- **Coexistence**: `search_knowledge` and a custom tool in the same turn,
  confirming `MAX_TOOL_LOOP_STEPS` still caps correctly and nothing in
  Sprint 2's existing suite regresses.
- **Crypto round-trip**: `src/lib/crypto.test.ts` — encrypt→decrypt returns
  the original plaintext; stored ciphertext is never equal to the plaintext.

## Documentation (ships with this sprint, not after)

- New `docs/custom-tools.md`: registration walkthrough, a JSON Schema
  example, and a Node.js code sample showing exactly how to verify the
  signature, including the recommended ±5-minute timestamp window.
- The three new routes get full OpenAPI schemas with `operationId`s, same as
  every existing route — the existing test asserting every `/v1` route
  appears in the generated spec covers these automatically.

## Open questions for the implementation plan

None — every decision above was confirmed during brainstorming. The
implementation plan should sequence: crypto lib → schema/migration →
registration service + routes → HMAC signing + outbound call → runtime
integration into `chat.service.ts` → docs.
