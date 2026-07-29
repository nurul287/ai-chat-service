# Standalone AI Chat Service — 6-Sprint Roadmap, Sprint 1 specced

## Context

Aurevo's RAG chatbot is the most sophisticated thing in the codebase — hybrid retrieval (pgvector + Postgres FTS + Reciprocal Rank Fusion + Voyage rerank, eval-gated to MRR 1.000), a real streaming tool-use loop against Claude, and non-trivial product-card matching against messy catalog titles. It only works for Aurevo, because it reaches directly into Aurevo's own tables.

The goal is to extract that capability into a **standalone multi-tenant SaaS** that any application can integrate with — an e-commerce store, a pharmacy, a docs site. The service is **domain-agnostic**: tenants feed it documents (catalog, inventory, policies, anything), and it retrieves against them by user query.

This was scoped during brainstorming and parked in `Aurevo.BE/docs/backlog.md`. Confirmed decisions:

- **Generic RAG, not commerce-specific.** The service stores "documents," never "products."
- **Live data via tenant-registered custom tools** (the SaaS-standard pattern — Chatbase custom actions, Intercom Fin, function calling generally): tenants register a tool with a JSON schema + HTTPS endpoint, and the service calls it mid-conversation with an HMAC-signed request. Static data goes through ingestion; live data goes through tenant tools. One mechanism, no fixed commerce contract.
- **New repo, new infra.** Supabase Postgres (pgvector) + Railway for the API, matching the deploy pattern proven on `aurevo-worker`.
- **Aurevo is not touched.** No migration until the service is proven standalone.

---

## Sprint roadmap

This is a multi-sprint project, not a single build. Each sprint is one plan document, ends in **demo-able software**, and has an explicit exit gate — nothing proceeds on "it compiles."

| Sprint | Theme | Demo-able outcome | Exit gate | Depends on |
|---|---|---|---|---|
| **1** | **Foundation, ingestion, retrieval** | `curl` a document in, `curl` a semantic search out, on a deployed service | Cross-tenant isolation proven by tests; CI green; deployed to Railway; quickstart followed end-to-end from a clean DB | — |
| **2** | **Chat engine** | A real streaming conversation over SSE that cites ingested documents | Reranking eval shows ≥ parity vs. plain hybrid; conversation history + token metrics recorded | 1 |
| **3** | **Custom tools** | The bot calls a tenant's own HTTPS endpoint mid-conversation for live data | HMAC signature verified end-to-end; a failing/slow tenant endpoint degrades gracefully instead of hanging the chat | 2 |
| **4** | **Embeddable widget** | A `<script>` tag on a blank HTML page produces a working chat bubble | Publishable key cannot read/write documents; domain allowlist actually blocks a disallowed origin | 2 |
| **5** | **Tenant dashboard** | Self-serve signup → create key → upload docs → see usage, no CLI | A new tenant onboards start-to-finish without you touching a terminal | 1 (can run parallel to 3/4) |
| **6** | **Launch hardening** | Public beta with a real external tenant | Per-tenant rate limits + quotas enforced; abuse/cost runaway impossible; docs published | 3, 4, 5 |
| **later** | **Aurevo migration** | Aurevo's widget pointed at the service, its local chat module deleted | Answer quality ≥ current Aurevo baseline on its existing eval set | 6 |

**Sizing, honestly.** Sprint 1 is 17 tasks; the rest are outlines, roughly ~8–12 tasks each, so the whole roadmap is on the order of 65 tasks. The "1–2 weeks" figure in `Aurevo.BE/docs/backlog.md` was written for a much thinner cut — API only, no widget, no dashboard, no custom tools — and is now stale; with the scope agreed here it's a multi-month effort at part-time pace. **Only Sprint 1 is specced task-by-task.** Each later sprint gets its own planning pass when it starts, informed by what the previous one taught us — planning Sprint 5 in detail today would be guessing.

**Sequencing rationale.** Sprints 1+2 alone are a legitimate developer-facing MVP: a working API a developer can integrate against. Sprint 4 is what makes it adoptable by non-developers, and Sprint 5 is what makes it self-serve. If the roadmap has to be cut short, stopping after Sprint 4 still leaves a sellable product with manual (CLI) onboarding.

**Documentation ships inside every sprint — it is never a later sprint.** For a developer-facing product the integration docs *are* the product surface: a developer who cannot integrate in ten minutes never discovers whether the retrieval is any good. So each sprint's exit gate includes "a developer who has never seen this repo can integrate the new capability from the docs alone." Concretely, no sprint is done until the OpenAPI spec covers its new endpoints, its guide page exists, and its runnable example works.

**Sprint 1's outcome:** a deployed service where you create a tenant, get an API key, push documents over HTTP, and search them — with tenant isolation enforced on every query and proven by tests, on a codebase with lint, structured logging, and CI already in place.

---

## Sprint 1 — detailed plan

The remainder of this document specs Sprint 1 only.

---

## Technology decisions

| Concern | Choice | Why |
|---|---|---|
| Runtime / language | Node 22, TypeScript (`strict`, `noUncheckedIndexedAccess`) | The retrieval code ports directly from Aurevo.BE. |
| **HTTP** | **Fastify 5** | ~3× Express throughput, though that's the least important reason — this workload is I/O-bound. The real wins: **pino is Fastify's built-in logger** and **request IDs are native** (`request.id`), which together absorb most of the observability task; native async error handling; a far better TypeScript story; and `fastify.inject()` for route tests with no real socket. Zod integrates via `fastify-type-provider-zod`. |
| **DB access** | **Drizzle ORM** (queries) + raw SQL migrations via Supabase CLI | Decisive reason: **native pgvector.** `vector({ dimensions: 1024 })` and `cosineDistance()` are first-class, and the `sql` template handles the generated `tsvector` FTS queries. Prisma has no native vector type — columns become `Unsupported(...)` and every similarity search falls back to `$queryRaw`, losing type safety on the single hottest path in the product. Aurevo already runs this exact combination (pgvector + HNSW + generated tsvector) in production. |
| Database | Supabase Postgres + pgvector | Proven in Aurevo. Auth/Storage available for the Plan 5 dashboard without adding infra. |
| Embeddings | Voyage AI `voyage-3` (1024-dim) | Same model Aurevo is eval-gated against; the client is a single `fetch` call, no SDK. |
| **LLM orchestration** | **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`) — **Plan 2** | TypeScript-native, light, first-class streaming and tool-calling. Its provider abstraction lets a tenant choose Claude / GPT / Gemini behind one interface — a SaaS need that the raw Anthropic SDK would force us to hand-build. |
| Validation | Zod (via `fastify-type-provider-zod`) | Schema drives both runtime validation and route handler types. |
| Tests | Vitest against real local Postgres | Aurevo's convention — no mocked data layer, so tenant-isolation tests exercise real SQL. External HTTP (Voyage) is mocked. |

**Explicitly rejected: LangChain.js / LangGraph.js.** It does support Node and has the largest ecosystem — but the tool-use loop is ~60 lines of proven, eval-gated code, and our retrieval is custom (tenant-scoped RRF fusion), so its retrievers would need subclassing. That means fighting the abstraction exactly where a multi-tenant service needs precise control over tenant scoping and per-request metrics, in exchange for a heavy dependency that churns between versions. Its document loaders (PDF/docx) and text splitters are genuinely good and can be adopted à la carte later without buying the framework.

---

## Approach

New repo `ai-chat-service` (working name; appears only in `package.json` and `README.md`).

**Reused from Aurevo.BE** (ported, then tenant-scoped):
- `src/lib/voyage.ts` — the Voyage embeddings client. Plan 1 drops the free-tier 429 backoff and the rerank call; both return in Plan 2.
- `src/app/modules/knowledge/knowledge.service.ts` — `rrfFuse()` copied essentially verbatim; `vectorSearch`/`keywordSearch` ported with a mandatory `tenant_id` filter and a join to `documents`.
- The `kb_chunks` schema shape informs `chunks`: `vector(1024)`, HNSW `vector_cosine_ops` index, generated `fts` tsvector with a GIN index.

**Key design decisions:**
- **Documents → chunks split.** Aurevo's `kb_chunks` is flat (one chunk per product) because product descriptions are short. A generic service ingests arbitrary-length documents, so it needs real chunking (`chunkText`, paragraph-first with overlap on hard splits).
- **Tenant id comes only from the authenticated API key** — never from a request body or query param. Every repository function takes `tenantId` as its first argument. This is the single most important correctness property in a multi-tenant service, asserted by tests at both the service and HTTP layers.
- **API keys are SHA-256 hashed**, never stored plaintext. SHA-256 rather than bcrypt/argon2 deliberately: a 256-bit random key has no dictionary surface, and this runs on every request where a slow KDF is pure latency tax.
- **Auth is a Fastify `preHandler` hook** registered on the `/v1` plugin scope, with `fastify.decorateRequest('tenant', null)` for the typed property — so tenant resolution is structurally impossible to forget on a `/v1` route.
- **Reranking deferred to Plan 2.** Eval-gated as strictly better on Aurevo's catalog, but there's no way to confirm it helps on generic non-catalog data without an eval harness — so it ships alongside one.

### Files created

```
ai-chat-service/
├── .github/workflows/ci.yml         lint → typecheck → test (Postgres service container)
├── supabase/migrations/
│   ├── 001_tenants_and_api_keys.sql
│   └── 002_documents_and_chunks.sql
├── docs/                            quickstart, concepts, authentication, errors, self-hosting
├── examples/                        curl.sh + a runnable Node integration example
├── eslint.config.js  .prettierrc
├── src/
│   ├── config/index.ts              Zod-validated env, fails loudly at boot
│   ├── db/{index,schema}.ts         Drizzle client + tenants/api_keys/documents/chunks
│   ├── plugins/
│   │   ├── auth.ts                  fastify-plugin: decorateRequest + preHandler
│   │   └── security.ts              @fastify/helmet + @fastify/cors
│   ├── auth/api-key.ts              generateApiKey / hashApiKey (pure)
│   ├── tenants/tenants.service.ts   createTenant / issueApiKey / verifyApiKey / revokeApiKey
│   ├── ingestion/chunk-text.ts      paragraph-aware chunking (pure)
│   ├── lib/voyage.ts                embedDocuments / embedQuery
│   ├── documents/                   service + schema + routes (Fastify plugin)
│   ├── retrieval/retrieve.ts        rrfFuse + tenant-scoped hybrid search
│   ├── scripts/create-tenant.ts     CLI to bootstrap a tenant + key
│   ├── app.ts                       buildApp() → FastifyInstance (testable, no listen)
│   └── server.ts                    boot, DB health check, graceful shutdown
├── railway.json
└── README.md
```

`app.ts` exports a `buildApp()` factory rather than a singleton — that's what makes `fastify.inject()` clean in tests and keeps `listen()` out of the test path entirely.

### API surface (Sprint 1)

All `/v1` routes require `Authorization: Bearer sk_live_…`.

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/v1/documents` | Create or replace a document (upsert on `externalId`) |
| `GET` | `/v1/documents` | List this tenant's documents |
| `DELETE` | `/v1/documents/:externalId` | Delete a document |
| `POST` | `/v1/search` | Hybrid search |
| `GET` | `/health` | Liveness probe, no auth |

### Task sequence (Sprint 1)

17 TDD tasks, each ending in a commit. Every task follows: write failing test → run it and confirm the failure → implement → run and confirm pass → commit.

| # | Task |
|---|---|
| 1 | Repo scaffold + Zod-validated config |
| 2 | DB connection + `tenants`/`api_keys` schema |
| 3 | API key generation and hashing |
| 4 | Tenant service + key verification |
| 5 | Auth plugin — `decorateRequest('tenant')` + `preHandler` hook |
| 6 | `documents`/`chunks` schema (pgvector + FTS) |
| 7 | Text chunking |
| 8 | Voyage embeddings client |
| 9 | Document ingestion service |
| 10 | Tenant-scoped hybrid retrieval |
| 11 | Routes for documents + search (Fastify plugin, tested via `inject()`) |
| 12 | `buildApp()` + server bootstrap, tenant CLI, deploy config |
| **13** | **ESLint + Prettier** — flat config, `pnpm lint` / `pnpm format`, lint failures block CI |
| **14** | **Observability + hardening** — configure Fastify's built-in pino (JSON prod / pretty dev / silent test), assert `request.id` propagates into log lines, register `@fastify/helmet` + `@fastify/cors`, and a `setErrorHandler` that logs with the request id instead of swallowing. Smaller than originally scoped, because Fastify supplies the logger and request ids natively. |
| **15** | **GitHub Actions CI** — lint → typecheck → test on every push/PR against a `postgres:16` service container with the `vector` extension and both migrations applied |
| **16** | **OpenAPI + live API reference** — `@fastify/swagger` + `@fastify/swagger-ui` driven off the existing Zod route schemas, served at `/docs` (browsable) and `/openapi.json` (machine-readable). A test asserts every `/v1` route appears in the generated spec, so a new endpoint cannot ship undocumented. |
| **17** | **Integration docs + runnable example** — `docs/` guides and `examples/`, detailed below. Verified by following the quickstart from scratch against a clean database. |

The existing detail doc at `Aurevo.BE/docs/superpowers/plans/2026-07-29-rag-chat-service-foundation.md` was written against Express + supertest. **Tasks 1, 5, 11, and 12 need rewriting for Fastify, and tasks 13–17 need adding, before execution.** Tasks 2, 3, 4, 6, 7, 8, 9, 10 are framework-agnostic and carry over unchanged. The doc should move into the new repo once it exists.

---

## Developer documentation (Tasks 16–17)

The audience is a developer who has never seen this repo and wants a working integration in ten minutes.

**Served by the service itself:**
- `GET /docs` — browsable Swagger UI
- `GET /openapi.json` — machine-readable spec, so consumers can generate their own typed clients or import into Postman/Insomnia

Both are generated from the Zod route schemas, not hand-maintained. That's the point of `fastify-type-provider-zod`: one schema drives request validation, handler types, and the published reference, so they cannot drift apart.

**Written guides in `docs/`:**

| File | Contents |
|---|---|
| `quickstart.md` | The ten-minute path: get a key → `PUT` your first document → `POST` a search → what to do next. Each step shown in curl **and** Node `fetch`. |
| `concepts.md` | Tenant, document, chunk, retrieval. Explains that `externalId` is *your* id (so re-pushing replaces rather than duplicates), and that chunking is internal — callers never manage chunks. |
| `authentication.md` | Secret keys (`sk_live_…`, server-side only, full access), how to rotate and revoke, and an explicit warning never to ship a secret key to a browser. Publishable keys get added here in Sprint 4. |
| `errors.md` | The error contract table — `unauthorized`, `invalid_request`, `not_found`, `internal_error`, with the HTTP status and response shape for each. |
| `self-hosting.md` | Env vars, migrations, Railway deploy — for anyone running their own instance. |

**Runnable examples in `examples/`:**
- `examples/curl.sh` — every endpoint as a copy-pasteable shell script
- `examples/node/` — a minimal standalone Node script (ingest a few documents, run a search, print results) with its own README

An example that actually runs is worth more than prose, and it doubles as a smoke test: if the example breaks, an integration path broke.

**The error response shape is a public API contract from day one.** Every failure returns `{ "error": { "code": "...", "message": "..." } }` with a stable, documented `code`. Changing a code later is a breaking change for every consumer, so `errors.md` is written in Sprint 1 rather than retrofitted.

**Deliberately not in Sprint 1:** an official client SDK. The API is four REST endpoints — `fetch` is genuinely fine, and `/openapi.json` lets anyone generate a typed client today. A hand-written SDK is worth revisiting once the chat endpoint (Sprint 2) makes SSE streaming the awkward part of integration, which is where an SDK actually earns its maintenance cost. A public docs site (Mintlify/Docusaurus) belongs to Sprint 6 alongside launch.

---

## Verification

**Automated** — `pnpm lint`, `pnpm build` (tsc clean), and `pnpm test` all green; CI green on first push. The isolation tests matter most:
- `retrieve.test.ts` — "never returns another tenant's chunks"
- `documents.service.test.ts` — "refuses to delete another tenant's document", "keeps two tenants' same-externalId documents separate"
- `documents.routes.test.ts` — "returns 404 for another tenant's document", "lists only the calling tenant's documents" (both via `app.inject()`)

**Manual end-to-end**, against a locally running service:

```bash
pnpm db:start && pnpm db:reset
pnpm create-tenant "Acme Pharmacy" acme-pharmacy   # prints the API key once
pnpm dev
```

```bash
curl -s http://localhost:4000/health
# → {"status":"ok"}

curl -s -X PUT http://localhost:4000/v1/documents \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"externalId":"sku-1","title":"Paracetamol","content":"Paracetamol 500mg relieves fever and mild pain."}'

curl -s -X POST http://localhost:4000/v1/search \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"query":"something for a fever"}'
# → data[0].externalId === "sku-1"
```

The search case is the real proof: the query shares no keyword with the stored title, so a hit demonstrates the vector leg genuinely works rather than FTS alone.

**Cross-tenant spot check** — create a second tenant, issue its key, confirm searching with it returns `[]` for the first tenant's content.

**Observability check** — confirm each request logs a line carrying `reqId`, and that `NODE_ENV=production pnpm start` emits JSON rather than pretty-printed output.

**Documentation check** — the one that catches drift:
1. `GET /docs` renders and lists all five routes; `GET /openapi.json` returns a valid spec (paste into an OpenAPI validator).
2. Wipe the database (`pnpm db:reset`), then follow `docs/quickstart.md` **verbatim, without consulting the source**, and confirm it ends in a successful search. Anything you had to know that isn't written down is a doc bug.
3. `node examples/node/index.js` runs green against a fresh tenant.

---

## Deferred, with the sprint that owns them

- **Reranking + eval harness** → Sprint 2. Gates any retrieval-quality change the way Aurevo's eval gates its own.
- **Rate limiting and per-tenant quotas** → Sprint 6, and this is a hard gate before any external tenant touches it. `@fastify/rate-limit` is the natural fit. Until then the service is single-tenant-by-trust.
- **Embedding-model migration.** `vector(1024)` is pinned to `voyage-3`; changing models later needs a migration plus a full re-embed. Worth designing a versioned-embeddings story before the first paying tenant — flagging it now because retrofitting it after real tenant data exists is materially harder.
- **Billing / metering.** Not scoped anywhere yet. If this is going to be sold rather than self-hosted, it needs a sprint of its own; usage metrics land in Sprint 5, which is the natural foundation for it.
