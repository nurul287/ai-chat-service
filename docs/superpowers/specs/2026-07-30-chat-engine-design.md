# Chat Engine — Sprint 2 Design

Status: draft. Each section below was approved conversationally during
brainstorming; this consolidated write-up itself is awaiting your review
before moving to an implementation plan.

## Context

Sprint 1 shipped and is deployed: tenant auth, document ingestion, and
tenant-scoped hybrid retrieval, all live at
[github.com/nurul287/ai-chat-service](https://github.com/nurul287/ai-chat-service).
This is Sprint 2 per the roadmap — a real streaming conversation over SSE
that calls the existing `retrieve()` as a tool and cites what it finds.

Roadmap exit gate for this sprint: *"Reranking eval shows ≥ parity vs. plain
hybrid; conversation history + token metrics recorded."*

## Decisions made during brainstorming

These were genuinely open and resolved with the user before any design work
started on top of them:

- **Conversations are scoped by `(tenant_id, external_user_id)`, not just
  tenant.** A tenant's own backend passes its own end-user identifier with
  every request — mirrors how `externalId` already works for documents. One
  external user can have many conversation threads (omit `conversationId` to
  start a new one).
- **Retention/cleanup is deferred to Sprint 6**, alongside rate limits and
  quotas. Conversations and messages are kept indefinitely in this sprint —
  no automatic deletion. The schema needs no special accommodation for this
  now (`created_at`/`updated_at` are enough for a future cleanup job).
- **Model/provider: OpenRouter, not direct Anthropic, as the production
  default.** This was an explicit, informed choice made against advice:
  direct Claude has a track record here (Aurevo's own eval-gated chat was
  built against it) and OpenRouter adds a hop plus zero cost benefit for
  Claude specifically. The user chose OpenRouter anyway, primarily for its
  free-tier models. Because free models are known to rotate/get delisted
  without warning (7 endpoints pulled in a 9-day window observed during
  design), the model id is a plain config value (`CHAT_MODEL_ID`), never
  hardcoded, with a documented swap procedure.
  - Initial default: `deepseek/deepseek-r1:free`.
  - `CHAT_MODEL_PROVIDER` also supports `anthropic` as an alternate, since the
    AI SDK's provider abstraction makes this free to keep open — useful for
    local comparison, not the production path.
- **No client SDK this sprint** — deferred again (Sprint 1's docs had already
  flagged this as the natural point to revisit it). This sprint is already
  comparable in scope to Sprint 1; an SDK is a focused pass of its own, best
  done once the streaming contract has been proven under real use.
- **A conversation history read API is in scope**: `GET /v1/conversations`
  and `GET /v1/conversations/:id/messages`. Originally scoped as "storage
  only", the user asked whether preserved also means retrievable — it should,
  since a realistic integrator wants to show a returning customer their own
  past chat.

## Data model

Three new tables, all tenant-scoped by direct `tenant_id` column (not just via
a join) — the same invariant Sprint 1 established for `chunks`: a tenant-scoped
query must never depend on remembering to join through a parent row correctly.

```sql
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  external_user_id text not null,
  intent_summary text,             -- null until the 3rd user turn
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- No uniqueness on (tenant_id, external_user_id): one external user can have
-- many conversation threads over time.
create index idx_conversations_tenant_user on public.conversations (tenant_id, external_user_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
-- Only user/assistant turns — NOT intermediate tool-call/tool-result steps,
-- which are how a reply gets produced, not conversation content anyone
-- re-reads. Matches Aurevo's message-log shape.
create index idx_messages_conversation on public.messages (conversation_id, created_at);
create index idx_messages_tenant on public.messages (tenant_id);

create table public.chat_metrics (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  model_id text not null,
  latency_ms integer not null,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_credits numeric,
  tool_call_count integer not null default 0,
  retrieved_chunk_count integer not null default 0,
  created_at timestamptz not null default now()
);
-- Separate table, not columns bolted onto `messages` — keeps the
-- conversation log clean, matches Aurevo's own chat_metrics precedent.
-- Recorded only in this sprint; no viewing endpoint (Sprint 5 territory).
create index idx_chat_metrics_tenant on public.chat_metrics (tenant_id);
```

Every message is preserved in full, verbatim — `intent_summary` is an
*additional*, separate compression layer used only to bound what gets sent to
the model on each turn; it never replaces the underlying full log. Nothing in
this sprint deletes rows.

## API surface

```
POST /v1/chat                                — send a message, get an SSE stream back
GET  /v1/conversations?externalUserId=...    — list a user's conversation threads (paginated)
GET  /v1/conversations/:id/messages          — full message log for one conversation (paginated)
```

All three sit in the existing `/v1` scope, under the same Bearer-secret-key
`preHandler` as every other route — no new auth mechanism.

`externalUserId` is a **required** query param on the list endpoint, not
optional — listing every conversation across every end-user of a tenant in one
unscoped call is a different (admin/dashboard-shaped) feature nobody's asked
for; this endpoint only ever answers "this tenant's view of this one
end-user's threads." Both list endpoints default to `page=1&limit=20`
(matching `GET /v1/documents`'s precedent); `/messages` sorts **ascending** by
`created_at` (oldest first), since a chat log reads top-to-bottom — the
opposite of `/documents`' descending-by-`updatedAt`, which is worth stating
explicitly since it's an easy default to get backwards.

**`POST /v1/chat`:**

```json
// Request
{ "externalUserId": "customer-482", "conversationId": null, "message": "Do you have anything for a headache?" }
```

```
Response: 200, Content-Type: text/event-stream

event: token   data: {"text": "Para"}
event: token   data: {"text": "cetamol relieves..."}
event: sources data: {"documents": [{"externalId":"sku-1","title":"Paracetamol","metadata":{...}}]}
event: done    data: {"conversationId": "...", "messageId": "..."}
event: error   data: {"error": {"code": "rate_limited", "message": "..."}}
```

The `sources` event carries whatever `search_knowledge` actually retrieved —
generic, not "product cards", so a docs site can render links and a pharmacy
can render items from the same event shape. `done` always returns
`conversationId`, which is how a caller learns the new thread's id when they
omitted it.

**Conversation ownership check** (pre-flight, before any streaming starts): a
`conversationId` must match *both* the calling tenant *and* the
`externalUserId` in the request body — not tenant alone, or one external user
could read another's conversation by guessing an id. Any mismatch → `404`,
indistinguishable from "doesn't exist", matching Sprint 1's anti-probing
contract.

**When `conversationId` is omitted**, the row is created **eagerly, before the
model is ever called** — not only on success. This means even a request that
errors out on its very first turn (rate-limited, model delisted) still gets a
real `conversationId` back via the `error` event, so the caller can retry
against the same thread instead of silently starting a new one each time.

**Exactly one assistant `messages` row is written per chat turn** — the fully
concatenated text from every `text-delta` event across all steps of the
tool-use loop, written once the stream reaches `finish`. Intermediate steps
(a tool call, a tool result, partial deltas) are never persisted as separate
message rows; only the final synthesized reply is conversation content.

## Architecture

```
src/chat/
├── model.ts                    createOpenRouter({ apiKey }) → configured LanguageModel
├── tools/search-knowledge.ts   tool({ inputSchema: z.object({ query, topK? }), execute })
├── history.ts                  loads last ~6 turns + intent_summary → ModelMessage[]
├── intent-summary.ts           every 3rd user turn: summarize, update conversations.intent_summary
├── conversations.service.ts    createOrGetConversation, listConversations, listMessages
├── chat.service.ts             runChat(tenantId, externalUserId, conversationId?, message)
│                               → async generator of SSE-shaped events
├── chat.schema.ts              Zod request/response schemas
└── chat.routes.ts              POST /v1/chat, GET /v1/conversations[/:id/messages]
```

**Tool-use loop** (`chat.service.ts`):

```ts
const result = streamText({
  model: chatModel,
  messages: [...history, { role: "user", content: message }],
  tools: { search_knowledge: searchKnowledgeTool(tenantId) },
  stopWhen: [hasToolCall("search_knowledge"), isStepCount(4)],
  usage: { include: true },
});
```

`search_knowledge`'s `execute` closes over `tenantId` from the authenticated
request — never from tool input, same invariant as every repository function
since Sprint 1. `stopWhen` bounds the loop at 4 steps.

**Streaming integration:** `@fastify/sse` (same family as the `@fastify/helmet`
/ `@fastify/cors` / `@fastify/swagger` plugins already in use). A route
declares `{ sse: 'only' }`; `reply.sse.send(source)` accepts an async
generator directly — exactly the shape produced by adapting
`result.fullStream` (text-delta / tool-call / tool-result / finish events)
into `{event, data}` objects. The plugin handles SSE headers, backpressure,
and connection lifecycle; the adapter code is the only new logic.

Considered and rejected: hand-rolling SSE on `reply.raw` (reinvents what the
plugin already does correctly) and a custom Transform stream (no advantage
over the plugin here).

## History management

```ts
async function buildContext(conversationId: string): Promise<ModelMessage[]> {
  const recent = await getLastNMessages(conversationId, 6);
  const summary = await getIntentSummary(conversationId);
  return [
    ...(summary ? [{ role: "system", content: `Earlier context: ${summary}` }] : []),
    ...recent,
  ];
}
```

Every 3rd user turn, `intent-summary.ts` fires a summarization call through
the **same OpenRouter provider and model** as the main chat — not a separate
config, since splitting them isn't earning its keep while both are free.
Written fire-and-forget to `conversations.intent_summary`, same
non-blocking pattern as `last_used_at` in Sprint 1: never delays or fails the
user's actual reply.

This is a proven pattern ported directly from Aurevo — it bounds token cost as
a conversation grows, so turn 50 costs roughly what turn 6 costs.

## Reranking + eval harness

This extends Sprint 1's existing `retrieve()` — adding a third, optional
`opts` parameter with a default, so it's backward compatible. `POST
/v1/search` (Sprint 1's route) keeps calling it exactly as before and is
unaffected; only the new `search_knowledge` tool passes `{ mode: "hybrid+rerank" }`.

```ts
export async function retrieve(
  tenantId: string, query: string, topK = 5,
  opts: { mode?: "hybrid" | "hybrid+rerank" } = {},
): Promise<RetrievedChunk[]> {
  const fused = await hybridSearch(tenantId, query, CANDIDATE_POOL);
  if (opts.mode !== "hybrid+rerank") return fused.slice(0, topK);
  try {
    return await rerank(query, fused, topK); // Voyage rerank-2.5-lite
  } catch {
    return fused.slice(0, topK); // degrade to fusion order, never a hard error
  }
}
```

Same fallback discipline as Aurevo: a rerank outage degrades silently to
hybrid, never surfaces as a chat-facing error.

**Eval harness needs new content.** Aurevo's eval is gated against its real
product catalog; this service has no real tenant content yet, and the reason
to re-gate reranking here at all is checking whether it generalizes *beyond* a
catalog. Build a synthetic golden set spanning **two distinctly different
domains**:
1. Extend the pharmacy examples already in `docs/`/`examples/` (Paracetamol,
   Loratadine, bandages).
2. Add a second, deliberately different domain — FAQ-style docs for a
   fictional software product.

Roughly 15–25 query/expected-document pairs total, in Aurevo's proven golden
JSON format. `pnpm eval:retrieval` — manual script, real Voyage API calls,
never CI, matching Sprint 1's established convention.

**Exit gate:** `hybrid+rerank` must score ≥ `hybrid` alone (precision, recall,
MRR) across **both** domains, not just parity on one — a result that only
holds for pharmacy-shaped content wouldn't actually prove genericity.

## Metrics

Fire-and-forget on the stream's `finish` event:

```ts
void recordChatMetrics({
  conversationId, messageId, tenantId,
  modelId: config.CHAT_MODEL_ID,
  latencyMs, promptTokens, completionTokens, totalTokens,
  costCredits, toolCallCount, retrievedChunkCount,
}).catch(() => {});
```

`costCredits` and token counts come from OpenRouter's own usage accounting
(`usage: { include: true }` on the model). Recorded only — no viewing
endpoint this sprint (Sprint 5 dashboard territory); this satisfies the
roadmap's exit gate wording ("recorded", not "exposed").

## Error handling

Once SSE headers are sent, the HTTP status can no longer change — so there
are two genuinely different error paths, not one:

| When | Surface |
|---|---|
| Before streaming starts (bad body, unknown/foreign `conversationId`) | Normal JSON `400`/`404`, exactly like every Sprint 1 route |
| After streaming starts (OpenRouter rate-limited, model delisted, any mid-stream failure) | An `error` SSE event, then the stream closes cleanly |

`docs/errors.md` gets a new section spelling this out explicitly, since a
caller's error handling needs both: check the initial HTTP status, and listen
for an `error` event type in the stream body.

## Testing

- Mock the AI SDK's model (same pattern as `lib/voyage` mocking in Sprint 1)
  — CI makes zero real OpenRouter/Voyage calls. A fake deterministic stream of
  text-delta/tool-call/tool-result/finish events drives the adapter.
- The stream→SSE adapter is a pure function (AI-SDK-event-list in,
  SSE-event-list out), unit-testable independent of Fastify.
- **Open verification item, not assumed:** whether `app.inject()` cleanly
  captures a `@fastify/sse` route's streamed body needs confirming with a
  real spike early in implementation. This is called out here rather than
  silently assumed, matching the standard this codebase has held to since
  Sprint 1 — if it doesn't work cleanly, the plan's first chat-route task
  needs to establish the actual testing mechanism before building on it.
- Isolation tests at Sprint 1's rigor: "never returns another tenant's
  conversation", "never returns another external user's conversation within
  the same tenant", "`search_knowledge` only ever searches the calling
  tenant's documents."
- Eval harness split exactly like Aurevo: the scoring math
  (precision/recall/MRR) is unit-tested; the actual run against real Voyage
  rerank + content stays a manual script, never CI.

## Config additions

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CHAT_MODEL_PROVIDER` | no | `openrouter` | `openrouter` \| `anthropic` |
| `CHAT_MODEL_ID` | no | `deepseek/deepseek-r1:free` | See delisting runbook below |
| `OPENROUTER_API_KEY` | conditional | — | Required only when `CHAT_MODEL_PROVIDER=openrouter` (the default) |
| `ANTHROPIC_API_KEY` | conditional | — | Required only when `CHAT_MODEL_PROVIDER=anthropic` |

Conditional, not unconditional — a deployment running `anthropic` mode for
local comparison shouldn't need an OpenRouter key it never uses. Validated
with a Zod `superRefine` on `config`, same style as the existing schema.

**Runbook: free model delisted.** If `CHAT_MODEL_ID` stops working (OpenRouter
periodically delists free endpoints without notice):
1. Check `openrouter.ai/models?supported_parameters=tools&free` for a current
   replacement with tool-calling support.
2. Update `CHAT_MODEL_ID`, redeploy. No code change needed — this is exactly
   why the model id is a config value, not a constant.

## Deferred, with the sprint that owns them

- **Retention/cleanup** → Sprint 6, alongside rate limits and quotas.
- **Client SDK** → revisit once the streaming contract has proven stable
  under real use.
- **Per-tenant model/provider choice** → not this sprint. Every tenant gets
  the same `CHAT_MODEL_ID` for now; the AI SDK's provider abstraction is what
  makes this addable later without a rewrite.
- **Viewing recorded metrics** → Sprint 5's tenant dashboard.

## Open questions carried into planning

None — all decisions above were resolved with the user during this
brainstorm. The one item flagged as unverified (`app.inject()` +
`@fastify/sse` interaction) is a first-task verification step for the
implementation plan, not an open design question.
