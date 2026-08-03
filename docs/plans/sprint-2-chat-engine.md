# Chat Engine — Sprint 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real streaming chat endpoint over SSE that calls Sprint 1's `retrieve()` as a tool, cites what it finds, remembers conversation history per (tenant, external user), and records token/cost metrics — with a reranking pass proven to help on generic (non-catalog) content via a new eval harness.

**Architecture:** A `POST /v1/chat` route runs an AI-SDK tool-use loop against a configurable model (OpenRouter by default, Anthropic as an alternate), streaming the reply over Server-Sent Events via `@fastify/sse`. The loop's one built-in tool, `search_knowledge`, wraps Sprint 1's `retrieve()` — extended (backward compatibly) with an optional reranking pass using Voyage `rerank-2.5-lite` via the official `@ai-sdk/voyage` provider. Conversation history is a sliding window of recent messages plus a rolling intent summary, refreshed every third user turn. Everything is tenant-scoped by the same invariant established in Sprint 1: `tenantId` comes only from the authenticated API key, never from a request body, tool input, or path segment.

**Tech Stack:** `ai@7.0.48` (Vercel AI SDK v7), `@openrouter/ai-sdk-provider@3.0.0`, `@ai-sdk/anthropic@4.0.27`, `@ai-sdk/voyage@2.0.18`, `@fastify/sse@0.6.0` — added to Sprint 1's existing Fastify 5 / Drizzle / Zod / Vitest stack.

## Provenance

This plan implements the design approved in
[`docs/superpowers/specs/2026-07-30-chat-engine-design.md`](../superpowers/specs/2026-07-30-chat-engine-design.md).
Every architectural decision recorded there (conversation scoping, OpenRouter
as production default with a swappable model id, deferred retention/SDK/
per-tenant model choice, the eager-conversation-creation and one-row-per-turn
rules, the pre-stream-vs-mid-stream error split) is treated as settled here —
this plan is about *how*, not *whether*.

**API surface grounding.** The design doc's pseudocode used illustrative event
names. Before writing this plan, the actual installed packages
(`ai@7.0.48`, `@openrouter/ai-sdk-provider@3.0.0`, `@ai-sdk/voyage@2.0.18`)
were inspected directly — real `.d.ts` files, not documentation that may lag
a fast-moving library. Two things changed from the design sketch as a result:

1. **Reranking uses `@ai-sdk/voyage`** (Vercel's own official Voyage provider,
   published by the same maintainers as `ai` itself) rather than a hand-rolled
   `fetch` call, via the AI SDK's own `rerank()` function. This is a strict
   improvement on the design's sketch, not a deviation from its intent.
2. **Stream event field names are the real, current v7 ones**:
   `text-delta` has `.text`; `tool-result` has `.toolName` and `.output`;
   `finish` has `.totalUsage` (with `.inputTokens`/`.outputTokens`/
   `.totalTokens`, not the older `promptTokens`/`completionTokens` naming);
   `error` has `.error: unknown`. OpenRouter's own cost accounting attaches
   separately, at `chunk.providerMetadata?.openrouter?.usage` — confirmed by
   reading `@openrouter/ai-sdk-provider`'s real exported
   `OpenRouterUsageAccounting` type, which does use `promptTokens` /
   `completionTokens` / `totalTokens` / `cost` (OpenRouter's own field names
   differ from the AI SDK's generic ones — both are used in this plan,
   mapped explicitly where they meet).

## Global Constraints

Everything from Sprint 1's Global Constraints still applies. Additions for
this sprint:

- **`tenantId` comes only from the authenticated API key** — never from a
  request body, query param, tool input, or path segment. `search_knowledge`'s
  `execute` closes over `tenantId` from the route handler; it is never a tool
  parameter the model can supply.
- **A `conversationId` must match both `tenant_id` and `external_user_id`** on
  every read — not tenant alone. Mismatch on either → `404`, indistinguishable
  from "doesn't exist," matching Sprint 1's anti-probing contract.
- **`retrieve()` is extended, not replaced.** Its new third parameter is
  optional with a default; Sprint 1's `POST /v1/search` route and its existing
  tests must keep passing completely unmodified.
- **External HTTP is mocked in every test**, same as Sprint 1: Voyage
  (embeddings + rerank) and the chat model (OpenRouter/Anthropic) are never
  called for real outside the manual eval script and manual verification
  steps.
- **Tests run against real local Postgres** (`127.0.0.1:55322`, established in
  Sprint 1), `fileParallelism: false`.
- Conventional commit messages. Commit at the end of every task.

---

### Task 1: `conversations`, `messages`, `chat_metrics` schema

**Files:**
- Create: `supabase/migrations/003_conversations_messages_metrics.sql`
- Modify: `src/db/schema.ts`
- Test: `src/db/chat-schema.test.ts`

**Interfaces:**
- Consumes: `tenants` from Sprint 1.
- Produces: table objects `conversations`, `messages`, `chatMetrics`; row types
  `Conversation = typeof conversations.$inferSelect`,
  `Message = typeof messages.$inferSelect`,
  `ChatMetric = typeof chatMetrics.$inferSelect`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/003_conversations_messages_metrics.sql`:

```sql
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  external_user_id text not null,
  intent_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_conversations_tenant_user on public.conversations (tenant_id, external_user_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

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

create index idx_chat_metrics_tenant on public.chat_metrics (tenant_id);
```

- [ ] **Step 2: Apply the migration**

Run: `pnpm db:reset`
Expected: applies migrations 001, 002, 003 with no errors.

- [ ] **Step 3: Write the failing test**

Create `src/db/chat-schema.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { chatMetrics, conversations, messages, tenants } from "./schema";

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

describe("conversations, messages, chat_metrics schema", () => {
  it("allows many conversations for the same (tenant, external_user_id)", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    await db.insert(conversations).values({ tenantId: tenant!.id, externalUserId: "u1" });
    await db.insert(conversations).values({ tenantId: tenant!.id, externalUserId: "u1" });

    const rows = await db.select().from(conversations);
    expect(rows).toHaveLength(2);
  });

  it("cascades message deletion when its conversation is deleted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();
    await db.insert(messages).values({
      conversationId: conv!.id,
      tenantId: tenant!.id,
      role: "user",
      content: "hi",
    });

    await db.delete(conversations).where(eq(conversations.id, conv!.id));

    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("rejects a message role outside user/assistant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();

    await expect(
      db.insert(messages).values({
        conversationId: conv!.id,
        tenantId: tenant!.id,
        // @ts-expect-error -- deliberately invalid role for this test
        role: "system",
        content: "x",
      }),
    ).rejects.toThrow();
  });

  it("cascades chat_metrics deletion when its message is deleted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, tenantId: tenant!.id, role: "assistant", content: "hi" })
      .returning();
    await db.insert(chatMetrics).values({
      conversationId: conv!.id,
      messageId: msg!.id,
      tenantId: tenant!.id,
      modelId: "deepseek/deepseek-r1:free",
      latencyMs: 500,
    });

    await db.delete(messages).where(eq(messages.id, msg!.id));

    expect(await db.select().from(chatMetrics)).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test src/db/chat-schema.test.ts`
Expected: FAIL — `conversations`/`messages`/`chatMetrics` not exported from `./schema`.

- [ ] **Step 5: Add the tables to the Drizzle schema**

Append to `src/db/schema.ts` (merge new imports into the existing
`drizzle-orm/pg-core` import line rather than adding a second one):

```ts
import { numeric } from "drizzle-orm/pg-core";

export const conversations = pgTable(
  "conversations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    intentSummary: text("intent_summary"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_conversations_tenant_user").on(table.tenantId, table.externalUserId)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: text().notNull().$type<"user" | "assistant">(),
    content: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_messages_conversation").on(table.conversationId, table.createdAt),
    index("idx_messages_tenant").on(table.tenantId),
  ],
);

export const chatMetrics = pgTable(
  "chat_metrics",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    costCredits: numeric("cost_credits"),
    toolCallCount: integer("tool_call_count").default(0).notNull(),
    retrievedChunkCount: integer("retrieved_chunk_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_chat_metrics_tenant").on(table.tenantId)],
);

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ChatMetric = typeof chatMetrics.$inferSelect;
```

The `role` column's `.$type<"user" | "assistant">()` gives Drizzle's TypeScript
side the narrow union; the SQL `check` constraint is what actually enforces it
at the database level (Drizzle's `$type` is a compile-time assertion only).

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test src/db/chat-schema.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Confirm Sprint 1 is untouched**

Run: `pnpm test`
Expected: all Sprint 1 suites still pass unmodified — this task only adds tables.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/003_conversations_messages_metrics.sql src/db/
git commit -m "feat(db): add conversations, messages and chat_metrics schema"
```

---

### Task 2: Chat model configuration

**Files:**
- Modify: `src/config/index.ts`
- Test: `src/config/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `config.CHAT_MODEL_PROVIDER: "openrouter" | "anthropic"`,
  `config.CHAT_MODEL_ID: string`, `config.OPENROUTER_API_KEY: string | undefined`,
  `config.ANTHROPIC_API_KEY: string | undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `src/config/config.test.ts`:

```ts
describe("chat model config", () => {
  it("defaults to openrouter with the free deepseek model", () => {
    const config = parseConfig({ ...valid, OPENROUTER_API_KEY: "or-test-key" });
    expect(config.CHAT_MODEL_PROVIDER).toBe("openrouter");
    expect(config.CHAT_MODEL_ID).toBe("deepseek/deepseek-r1:free");
  });

  it("requires OPENROUTER_API_KEY when the provider is openrouter", () => {
    expect(() => parseConfig({ ...valid, CHAT_MODEL_PROVIDER: "openrouter" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it("does not require OPENROUTER_API_KEY when the provider is anthropic", () => {
    const config = parseConfig({
      ...valid,
      CHAT_MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(config.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("requires ANTHROPIC_API_KEY when the provider is anthropic", () => {
    expect(() =>
      parseConfig({ ...valid, CHAT_MODEL_PROVIDER: "anthropic", OPENROUTER_API_KEY: "or-key" }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rejects an unknown CHAT_MODEL_PROVIDER", () => {
    expect(() =>
      parseConfig({ ...valid, CHAT_MODEL_PROVIDER: "openai", OPENROUTER_API_KEY: "or-key" }),
    ).toThrow(/CHAT_MODEL_PROVIDER/);
  });
});
```

Note: every other existing test in this file calls `parseConfig(valid)` without
an `OPENROUTER_API_KEY` — those will start failing once this task's
`superRefine` is added, since `CHAT_MODEL_PROVIDER` defaults to `openrouter`.
Fix this in Step 3 by adding `OPENROUTER_API_KEY: "or-test-key"` to the shared
`valid` fixture object at the top of the file, so every pre-existing test
keeps passing unmodified in behavior (they were never testing chat config).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/config/config.test.ts`
Expected: FAIL — new assertions fail (`CHAT_MODEL_PROVIDER` is `undefined`),
and every pre-existing test in the file also now fails once you add the
`superRefine` in the next step, because `valid` lacks `OPENROUTER_API_KEY`.
This is expected — Step 3 fixes both at once.

- [ ] **Step 3: Update the shared fixture and implement the schema**

In `src/config/config.test.ts`, add to the `valid` object:

```ts
const valid = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
  VOYAGE_API_KEY: "pa-test-key",
  VOYAGE_EMBEDDING_MODEL: "voyage-3",
  PORT: "4000",
  NODE_ENV: "test",
  OPENROUTER_API_KEY: "or-test-key",
};
```

In `src/config/index.ts`, add to `configSchema` and wrap it with a
`superRefine`:

```ts
const baseConfigSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  VOYAGE_API_KEY: z.string().min(1, "VOYAGE_API_KEY is required"),
  VOYAGE_EMBEDDING_MODEL: z.string().default("voyage-3"),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PUBLIC_URL: z
    .string()
    .optional()
    .transform((value) => (value && !/^https?:\/\//.test(value) ? `https://${value}` : value))
    .pipe(z.string().url().optional()),
  CHAT_MODEL_PROVIDER: z.enum(["openrouter", "anthropic"]).default("openrouter"),
  CHAT_MODEL_ID: z.string().default("deepseek/deepseek-r1:free"),
  OPENROUTER_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
});

const configSchema = baseConfigSchema.superRefine((data, ctx) => {
  if (data.CHAT_MODEL_PROVIDER === "openrouter" && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["OPENROUTER_API_KEY"],
      message: "OPENROUTER_API_KEY is required when CHAT_MODEL_PROVIDER is openrouter",
    });
  }
  if (data.CHAT_MODEL_PROVIDER === "anthropic" && !data.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["ANTHROPIC_API_KEY"],
      message: "ANTHROPIC_API_KEY is required when CHAT_MODEL_PROVIDER is anthropic",
    });
  }
});
```

`superRefine` runs after every field-level check has already passed, so a
missing `DATABASE_URL` is still reported before this cross-field check ever
runs — the existing "throws a readable error naming the missing variable"
test is unaffected.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/config/config.test.ts`
Expected: PASS — 13 tests (8 pre-existing + 5 new).

- [ ] **Step 5: Update `.env.example`**

Append to `.env.example`:

```
# Chat engine (Sprint 2)
CHAT_MODEL_PROVIDER=openrouter
CHAT_MODEL_ID=deepseek/deepseek-r1:free
OPENROUTER_API_KEY=
# ANTHROPIC_API_KEY=   # only needed if CHAT_MODEL_PROVIDER=anthropic
```

- [ ] **Step 6: Add your own local OpenRouter key**

Get a key from https://openrouter.ai/keys and add it to `.env` (not
`.env.example` — that file is committed). This is required for every task
from here on that exercises the real chat model in manual verification.

- [ ] **Step 7: Commit**

```bash
git add src/config/ .env.example
git commit -m "feat(config): add chat model provider configuration"
```

---

### Task 3: Voyage reranking

**Files:**
- Modify: `src/lib/voyage.ts`
- Test: `src/lib/voyage.test.ts`

**Interfaces:**
- Consumes: `config.VOYAGE_API_KEY`.
- Produces: `rerank(query: string, texts: string[], topN: number): Promise<number[]>`
  — returns the **original indices** of `texts`, reordered by relevance and
  truncated to `topN`. E.g. for `texts = ["a", "b", "c"]`, a result of
  `[2, 0]` means `texts[2]` is most relevant, then `texts[0]`, and `topN` was 2.

Returning indices rather than the reranked texts themselves keeps this
function generic — `retrieve()` (Task 4) has richer `Candidate` objects it
needs to reorder, not just their text, and index-based reassembly means this
function does not need to know anything about that shape.

- [ ] **Step 1: Install `@ai-sdk/voyage`**

```bash
pnpm add @ai-sdk/voyage@2.0.18 ai@7.0.48
```

`ai` is installed here (rather than in a later task) because `rerank()` is
exported from the `ai` package itself, not from `@ai-sdk/voyage` — the Voyage
package only provides the `RerankingModel` that `ai`'s `rerank()` calls.

- [ ] **Step 2: Write the failing test**

Append to `src/lib/voyage.test.ts`:

```ts
vi.mock("@ai-sdk/voyage", () => ({
  createVoyage: vi.fn(() => ({
    reranking: vi.fn(() => ({ modelId: "rerank-2.5-lite" })),
  })),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    rerank: vi.fn(),
  };
});

describe("rerank", () => {
  it("returns original indices ordered by relevance, truncated to topN", async () => {
    const { rerank: mockRerank } = await import("ai");
    vi.mocked(mockRerank).mockResolvedValue({
      ranking: [
        { originalIndex: 2, score: 0.9, document: "c" },
        { originalIndex: 0, score: 0.7, document: "a" },
        { originalIndex: 1, score: 0.5, document: "b" },
      ],
    } as never);

    const { rerank } = await import("./voyage");
    const result = await rerank("query", ["a", "b", "c"], 2);

    expect(result).toEqual([2, 0]);
  });

  it("propagates a rerank API failure so callers can decide how to degrade", async () => {
    const { rerank: mockRerank } = await import("ai");
    vi.mocked(mockRerank).mockRejectedValue(new Error("Voyage rerank request failed (500)"));

    const { rerank } = await import("./voyage");

    await expect(rerank("query", ["a", "b"], 1)).rejects.toThrow(/500/);
  });
});
```

Add `import { describe, expect, it, vi } from "vitest";` to the top imports if
not already present (it already is, from Task 8 of Sprint 1).

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/lib/voyage.test.ts`
Expected: FAIL — `rerank` is not exported from `./voyage`.

- [ ] **Step 4: Implement reranking**

Add to `src/lib/voyage.ts`:

```ts
import { createVoyage } from "@ai-sdk/voyage";
import { rerank as aiRerank } from "ai";

const voyage = createVoyage({ apiKey: config.VOYAGE_API_KEY });

/**
 * Returns the original indices of `texts`, reordered by relevance to `query`
 * and truncated to `topN`. Index-based rather than returning reranked text
 * directly, so a caller with richer objects (see retrieve.ts) can reorder its
 * own array without this function needing to know that shape.
 *
 * Throws on failure rather than swallowing it — the caller decides whether
 * and how to degrade (retrieve() falls back to fusion order; this function
 * itself stays a thin, honest wrapper).
 */
export async function rerank(query: string, texts: string[], topN: number): Promise<number[]> {
  const { ranking } = await aiRerank({
    model: voyage.reranking("rerank-2.5-lite"),
    query,
    documents: texts,
    topN,
  });
  return ranking.map((r) => r.originalIndex);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/lib/voyage.test.ts`
Expected: PASS — 7 tests (5 pre-existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/voyage.ts src/lib/voyage.test.ts
git commit -m "feat(lib): add Voyage reranking via the official AI SDK provider"
```

---

### Task 4: Extend `retrieve()` with reranking

**Files:**
- Modify: `src/retrieval/retrieve.ts`
- Test: `src/retrieval/retrieve.test.ts`

**Interfaces:**
- Consumes: `rerank` from Task 3.
- Produces: `retrieve(tenantId, query, topK?, opts?: { mode?: "hybrid" | "hybrid+rerank" })`
  — the third parameter is new and optional; every existing call site
  (Sprint 1's `POST /v1/search`) is unaffected.

- [ ] **Step 1: Write the failing tests**

Append to `src/retrieval/retrieve.test.ts`. Mock `rerank` alongside the
existing `embedDocuments`/`embedQuery` mock:

```ts
vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  ),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
  rerank: vi.fn(),
}));
```

(This replaces the existing `vi.mock("../lib/voyage", ...)` block at the top
of the file — merge `rerank` into it rather than adding a second mock.)

```ts
describe("retrieve with reranking", () => {
  it("defaults to plain hybrid mode when opts is omitted", async () => {
    const { rerank } = await import("../lib/voyage");
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "Paracetamol relieves fever." });

    await retrieve(tenant.id, "fever", 3);

    expect(rerank).not.toHaveBeenCalled();
  });

  it("calls rerank when mode is hybrid+rerank", async () => {
    const { rerank } = await import("../lib/voyage");
    vi.mocked(rerank).mockResolvedValue([0]);
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "Paracetamol relieves fever." });

    const results = await retrieve(tenant.id, "fever", 3, { mode: "hybrid+rerank" });

    expect(rerank).toHaveBeenCalledOnce();
    expect(results[0]!.externalId).toBe("sku-1");
  });

  it("degrades to fusion order when rerank throws", async () => {
    const { rerank } = await import("../lib/voyage");
    vi.mocked(rerank).mockRejectedValue(new Error("Voyage rerank request failed (500)"));
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "Paracetamol relieves fever." });

    const results = await retrieve(tenant.id, "fever", 3, { mode: "hybrid+rerank" });

    expect(results).toHaveLength(1);
    expect(results[0]!.externalId).toBe("sku-1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/retrieval/retrieve.test.ts`
Expected: FAIL — `retrieve` does not accept a third argument yet (TypeScript)
or `rerank` is never called (runtime).

- [ ] **Step 3: Implement the extension**

Modify `src/retrieval/retrieve.ts`. Change the `retrieve` export:

```ts
import { embedQuery, rerank } from "../lib/voyage";

export type RetrieveOptions = {
  mode?: "hybrid" | "hybrid+rerank";
};

export async function retrieve(
  tenantId: string,
  query: string,
  topK = 5,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const embedding = await embedQuery(query);

  const [vectorHits, keywordHits] = await Promise.all([
    vectorSearch(tenantId, embedding, CANDIDATE_POOL),
    keywordSearch(tenantId, query, CANDIDATE_POOL),
  ]);

  const fused = rrfFuse([vectorHits, keywordHits]);

  if (opts.mode !== "hybrid+rerank") {
    return fused.slice(0, topK).map(({ id: _id, ...chunk }) => chunk);
  }

  try {
    const order = await rerank(
      query,
      fused.map((c) => c.content),
      topK,
    );
    return order.map((i) => fused[i]!).map(({ id: _id, ...chunk }) => chunk);
  } catch {
    // Degrade to fusion order — a rerank outage must never break search.
    return fused.slice(0, topK).map(({ id: _id, ...chunk }) => chunk);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/retrieval/retrieve.test.ts`
Expected: PASS — 10 tests (7 pre-existing + 3 new).

- [ ] **Step 5: Confirm Sprint 1's search route is unaffected**

Run: `pnpm test src/documents/documents.routes.test.ts`
Expected: PASS — unmodified, since `POST /v1/search` never passes the new
`opts` parameter and the default (`mode` undefined) behaves exactly as before.

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/
git commit -m "feat(retrieval): add optional reranking pass to retrieve()"
```

---

### Task 5: Chat model provider

**Files:**
- Create: `src/chat/model.ts`
- Test: `src/chat/model.test.ts`

**Interfaces:**
- Consumes: `config.CHAT_MODEL_PROVIDER`, `config.CHAT_MODEL_ID`,
  `config.OPENROUTER_API_KEY`, `config.ANTHROPIC_API_KEY`.
- Produces: `chatModel: LanguageModel` (from `ai`), selected once at import
  time based on config — matching how `src/db/index.ts` builds its client
  once from config, not per-request.

- [ ] **Step 1: Install the provider packages**

```bash
pnpm add @openrouter/ai-sdk-provider@3.0.0 @ai-sdk/anthropic@4.0.27
```

- [ ] **Step 2: Write the failing test**

Create `src/chat/model.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    CHAT_MODEL_PROVIDER: "openrouter",
    CHAT_MODEL_ID: "deepseek/deepseek-r1:free",
    OPENROUTER_API_KEY: "or-test-key",
    ANTHROPIC_API_KEY: undefined,
  },
}));

describe("chat model selection", () => {
  it("builds an OpenRouter model when CHAT_MODEL_PROVIDER is openrouter", async () => {
    const { chatModel } = await import("./model");
    expect(chatModel.modelId).toBe("deepseek/deepseek-r1:free");
    expect(chatModel.provider).toContain("openrouter");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/chat/model.test.ts`
Expected: FAIL — cannot resolve `./model`.

- [ ] **Step 4: Implement model selection**

Create `src/chat/model.ts`:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { config } from "../config";

/**
 * Selected once at import time from config, not per-request — matching how
 * src/db/index.ts builds its client once. CHAT_MODEL_ID stays a plain string
 * rather than a constant specifically because OpenRouter's free-tier models
 * are known to rotate and get delisted without warning; swapping it is meant
 * to be a one-line config change, never a code change. See
 * docs/self-hosting.md for the swap runbook.
 */
function buildChatModel(): LanguageModel {
  if (config.CHAT_MODEL_PROVIDER === "anthropic") {
    const anthropic = createAnthropic({ apiKey: config.ANTHROPIC_API_KEY });
    return anthropic(config.CHAT_MODEL_ID);
  }

  const openrouter = createOpenRouter({ apiKey: config.OPENROUTER_API_KEY });
  return openrouter(config.CHAT_MODEL_ID);
}

export const chatModel = buildChatModel();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/chat/model.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/chat/model.ts src/chat/model.test.ts
git commit -m "feat(chat): add configurable model provider selection"
```

---

### Task 6: `search_knowledge` tool

**Files:**
- Create: `src/chat/tools/search-knowledge.ts`
- Test: `src/chat/tools/search-knowledge.test.ts`

**Interfaces:**
- Consumes: `retrieve` from Task 4.
- Produces: `searchKnowledgeTool(tenantId: string): Tool` — a factory, not a
  singleton, because `tenantId` is a per-request value that must be closed
  over at call time, never accepted as a tool parameter the model could
  supply.

- [ ] **Step 1: Write the failing test**

Create `src/chat/tools/search-knowledge.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../retrieval/retrieve", () => ({
  retrieve: vi.fn(),
}));

describe("searchKnowledgeTool", () => {
  it("calls retrieve with the closed-over tenantId, hybrid+rerank mode, and the model's query", async () => {
    const { retrieve } = await import("../../retrieval/retrieve");
    vi.mocked(retrieve).mockResolvedValue([
      { documentId: "d1", externalId: "sku-1", title: "Paracetamol", content: "...", metadata: {} },
    ]);

    const { searchKnowledgeTool } = await import("./search-knowledge");
    const tool = searchKnowledgeTool("tenant-a");
    const result = await tool.execute!({ query: "fever" }, {} as never);

    expect(retrieve).toHaveBeenCalledWith("tenant-a", "fever", 5, { mode: "hybrid+rerank" });
    expect(result).toHaveLength(1);
  });

  it("respects an explicit topK from the model, capped at 10", async () => {
    const { retrieve } = await import("../../retrieval/retrieve");
    vi.mocked(retrieve).mockResolvedValue([]);

    const { searchKnowledgeTool } = await import("./search-knowledge");
    const tool = searchKnowledgeTool("tenant-a");
    await tool.execute!({ query: "fever", topK: 8 }, {} as never);

    expect(retrieve).toHaveBeenCalledWith("tenant-a", "fever", 8, { mode: "hybrid+rerank" });
  });

  it("never accepts tenantId as a tool parameter — the schema has no such field", async () => {
    const { searchKnowledgeTool } = await import("./search-knowledge");
    const tool = searchKnowledgeTool("tenant-a");

    const shape = (tool.inputSchema as { shape: Record<string, unknown> }).shape;
    expect(shape).not.toHaveProperty("tenantId");
    expect(Object.keys(shape)).toEqual(["query", "topK"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/chat/tools/search-knowledge.test.ts`
Expected: FAIL — cannot resolve `./search-knowledge`.

- [ ] **Step 3: Implement the tool**

Create `src/chat/tools/search-knowledge.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import { retrieve } from "../../retrieval/retrieve";

const inputSchema = z.object({
  query: z.string().min(1).describe("What to search for in the tenant's knowledge base."),
  topK: z
    .number()
    .int()
    .positive()
    .max(10)
    .optional()
    .describe("How many results to return. Defaults to 5."),
});

/**
 * A factory, not a singleton: `tenantId` is closed over at call time from the
 * authenticated request, never a field on `inputSchema` the model could set
 * itself — the same invariant every repository function has held since
 * Sprint 1.
 */
export function searchKnowledgeTool(tenantId: string) {
  return tool({
    description:
      "Search this tenant's knowledge base for documents relevant to a query. Always cite what you find.",
    inputSchema,
    execute: async ({ query, topK }) => retrieve(tenantId, query, topK ?? 5, { mode: "hybrid+rerank" }),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/chat/tools/search-knowledge.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chat/tools/
git commit -m "feat(chat): add search_knowledge tool wrapping retrieve()"
```

---

### Task 7: Stream adapter

**Files:**
- Create: `src/chat/stream-adapter.ts`
- Test: `src/chat/stream-adapter.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — deliberately a pure function,
  testable with fake AI SDK events and no Fastify, no DB, no network.
- Produces: `adaptStream(source: AsyncIterable<TextStreamPart<ToolSet>>): AsyncGenerator<ChatStreamEvent>`
  and the `ChatStreamEvent` type.

This is one layer of translation: AI SDK's rich, many-variant event stream in,
a small domain-specific event set out. `chat.service.ts` (Task 13) is the next
layer — it adds IDs, persists messages, and produces the final wire-format SSE
events. Keeping this layer pure and separate is what makes it testable without
Fastify, a real model, or a real database.

- [ ] **Step 1: Write the failing test**

Create `src/chat/stream-adapter.test.ts`. The fake source is a plain async
generator yielding objects shaped exactly like the real `TextStreamPart`
variants this adapter cares about — confirmed against the installed `ai@7.0.48`
package's own type definitions, not assumed.

```ts
import { describe, expect, it } from "vitest";
import { adaptStream } from "./stream-adapter";

async function* fakeStream(parts: unknown[]) {
  for (const part of parts) yield part;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("adaptStream", () => {
  it("emits a token event per text-delta", async () => {
    const events = await collect(
      adaptStream(fakeStream([{ type: "text-delta", id: "1", text: "Para" }]) as never),
    );
    expect(events).toEqual([{ type: "token", text: "Para" }]);
  });

  it("emits a sources event for a search_knowledge tool-result", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "search_knowledge",
            input: { query: "fever" },
            output: [{ externalId: "sku-1" }],
          },
        ]) as never,
      ),
    );
    expect(events).toEqual([{ type: "sources", documents: [{ externalId: "sku-1" }] }]);
  });

  it("ignores tool-results from any tool other than search_knowledge", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([
          { type: "tool-result", toolCallId: "c1", toolName: "some_other_tool", input: {}, output: {} },
        ]) as never,
      ),
    );
    expect(events).toEqual([]);
  });

  it("emits a finish event carrying totalUsage", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          },
        ]) as never,
      ),
    );
    expect(events).toEqual([
      { type: "finish", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
    ]);
  });

  it("emits an error event, mapping to internal_error by default", async () => {
    const events = await collect(
      adaptStream(fakeStream([{ type: "error", error: new Error("boom") }]) as never),
    );
    expect(events).toEqual([{ type: "error", code: "internal_error", message: "boom" }]);
  });

  it("passes through multiple text-deltas across steps in order", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([
          { type: "text-delta", id: "1", text: "Para" },
          { type: "text-delta", id: "1", text: "cetamol" },
        ]) as never,
      ),
    );
    expect(events.map((e) => (e.type === "token" ? e.text : null))).toEqual(["Para", "cetamol"]);
  });

  it("ignores event types it does not need to surface (start, start-step, finish-step)", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([{ type: "start" }, { type: "start-step" }, { type: "finish-step" }]) as never,
      ),
    );
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/chat/stream-adapter.test.ts`
Expected: FAIL — cannot resolve `./stream-adapter`.

- [ ] **Step 3: Implement the adapter**

Create `src/chat/stream-adapter.ts`:

```ts
import type { TextStreamPart, ToolSet } from "ai";
import type { RetrievedChunk } from "../retrieval/retrieve";

export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "sources"; documents: RetrievedChunk[] }
  | {
      type: "finish";
      usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    }
  | { type: "error"; code: "internal_error"; message: string };

/**
 * Translates the AI SDK's rich TextStreamPart union into the small set of
 * events this service actually surfaces. Deliberately pure — no Fastify, no
 * database, no network — so it is testable with a fake source stream alone.
 *
 * Only `search_knowledge`'s tool-result becomes a `sources` event: this is
 * the ONLY tool this loop has in Sprint 2 (Sprint 3 adds tenant-registered
 * custom tools), and a result from any other tool name is silently ignored
 * rather than surfaced, since there is nothing else registered to produce one
 * yet.
 */
export async function* adaptStream(
  source: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncGenerator<ChatStreamEvent> {
  for await (const part of source) {
    switch (part.type) {
      case "text-delta":
        yield { type: "token", text: part.text };
        break;
      case "tool-result":
        if (part.toolName === "search_knowledge") {
          yield { type: "sources", documents: part.output as RetrievedChunk[] };
        }
        break;
      case "finish":
        yield {
          type: "finish",
          usage: {
            inputTokens: part.totalUsage.inputTokens ?? undefined,
            outputTokens: part.totalUsage.outputTokens ?? undefined,
            totalTokens: part.totalUsage.totalTokens ?? undefined,
          },
        };
        break;
      case "error":
        yield {
          type: "error",
          code: "internal_error",
          message: part.error instanceof Error ? part.error.message : String(part.error),
        };
        break;
      default:
        // start, start-step, finish-step, tool-call, reasoning-*, source,
        // file, tool-input-*, tool-error, raw, abort — none are surfaced to
        // the client in Sprint 2. tool-error specifically: search_knowledge's
        // execute() never throws (retrieve() already degrades internally on
        // its own failures), so a tool-error here would indicate a genuine
        // bug, not a normal degrade path — worth revisiting if Sprint 3's
        // tenant-registered tools can fail in ways that should reach the client.
        break;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/chat/stream-adapter.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chat/stream-adapter.ts src/chat/stream-adapter.test.ts
git commit -m "feat(chat): add pure AI-SDK-event to domain-event stream adapter"
```

---

### Task 8: Conversations service

**Files:**
- Create: `src/chat/conversations.service.ts`
- Test: `src/chat/conversations.service.test.ts`

**Interfaces:**
- Consumes: `db`, `conversations`, `messages`, `Conversation`, `Message` from
  Task 1.
- Produces:
  - `createConversation(tenantId, externalUserId): Promise<Conversation>`
  - `getConversation(tenantId, externalUserId, conversationId): Promise<Conversation | null>`
    — returns `null` on any mismatch (wrong tenant, wrong external user, or
    genuinely nonexistent), never distinguishing which.
  - `listConversations(tenantId, externalUserId, page, limit): Promise<{ data: Conversation[]; total: number }>`
  - `listMessages(conversationId, page, limit): Promise<{ data: Message[]; total: number }>`
    — ascending by `createdAt`.
  - `appendMessage(conversationId, tenantId, role, content): Promise<Message>`
  - `getRecentMessages(conversationId, limit): Promise<Message[]>` — ascending
    order (oldest of the window first), for building model context.
  - `getIntentSummary(conversationId): Promise<string | null>`
  - `updateIntentSummary(conversationId, summary): Promise<void>`
  - `countUserMessages(conversationId): Promise<number>` — used by
    `chat.service.ts` (Task 13) to know when the 3rd-user-turn summary
    trigger fires; kept here rather than as a raw query in the orchestrator,
    matching the rest of this service owning all of its own queries.
  - `getConversationByIdForTenant(tenantId, conversationId): Promise<Conversation | null>`
    — **tenant-only** ownership, distinct from `getConversation`'s three-way
    check. `GET /v1/conversations/:id/messages` (Task 15) has no
    `externalUserId` in its path or query — only `POST /v1/chat`'s body
    carries one, because only that request claims to act as a specific
    external user. This function is what `listMessages` must be verified
    against before Task 15's routes ever call it: without a tenant-scoped
    check in front of it, `listMessages(conversationId, ...)` alone would let
    any tenant read any other tenant's messages by guessing a conversation
    id — exactly the class of leak Sprint 1 was built to prevent.

- [ ] **Step 1: Write the failing test**

Create `src/chat/conversations.service.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { chatMetrics, conversations, messages, tenants } from "../db/schema";
import {
  appendMessage,
  countUserMessages,
  createConversation,
  getConversation,
  getConversationByIdForTenant,
  getIntentSummary,
  getRecentMessages,
  listConversations,
  listMessages,
  updateIntentSummary,
} from "./conversations.service";

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(tenants);
}

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(tenants).values({ name: slug, slug }).returning();
  return tenant!;
}

beforeEach(clean);
afterAll(clean);

describe("createConversation / getConversation", () => {
  it("creates and then retrieves a conversation for the same tenant + external user", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    const found = await getConversation(tenant.id, "customer-482", conv.id);
    expect(found?.id).toBe(conv.id);
  });

  it("returns null for another tenant's conversation", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    const conv = await createConversation(a.id, "customer-482");

    expect(await getConversation(b.id, "customer-482", conv.id)).toBeNull();
  });

  it("returns null for another external user's conversation within the same tenant", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    expect(await getConversation(tenant.id, "customer-999", conv.id)).toBeNull();
  });

  it("returns null for a genuinely nonexistent id, indistinguishable from the above", async () => {
    const tenant = await makeTenant("acme");
    expect(await getConversation(tenant.id, "customer-482", crypto.randomUUID())).toBeNull();
  });

  it("allows many conversations for the same (tenant, externalUserId)", async () => {
    const tenant = await makeTenant("acme");
    await createConversation(tenant.id, "customer-482");
    await createConversation(tenant.id, "customer-482");

    const { total } = await listConversations(tenant.id, "customer-482", 1, 20);
    expect(total).toBe(2);
  });
});

describe("listConversations", () => {
  it("returns only the given tenant + external user's threads", async () => {
    const tenant = await makeTenant("acme");
    await createConversation(tenant.id, "customer-482");
    await createConversation(tenant.id, "customer-999");

    const { data, total } = await listConversations(tenant.id, "customer-482", 1, 20);
    expect(total).toBe(1);
    expect(data[0]!.externalUserId).toBe("customer-482");
  });
});

describe("messages", () => {
  it("appendMessage writes a row with the given role and content", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    const msg = await appendMessage(conv.id, tenant.id, "user", "Do you have anything for a headache?");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Do you have anything for a headache?");
  });

  it("listMessages returns ascending order (oldest first)", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");
    await appendMessage(conv.id, tenant.id, "user", "first");
    await appendMessage(conv.id, tenant.id, "assistant", "second");

    const { data } = await listMessages(conv.id, 1, 20);
    expect(data.map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("getRecentMessages returns at most `limit` messages, oldest-of-the-window first", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");
    for (let i = 0; i < 5; i++) {
      await appendMessage(conv.id, tenant.id, "user", `turn-${i}`);
    }

    const recent = await getRecentMessages(conv.id, 3);
    expect(recent.map((m) => m.content)).toEqual(["turn-2", "turn-3", "turn-4"]);
  });
});

describe("countUserMessages", () => {
  it("counts only user-role messages, not assistant replies", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");
    await appendMessage(conv.id, tenant.id, "user", "first");
    await appendMessage(conv.id, tenant.id, "assistant", "reply");
    await appendMessage(conv.id, tenant.id, "user", "second");

    expect(await countUserMessages(conv.id)).toBe(2);
  });
});

describe("getConversationByIdForTenant", () => {
  it("returns the conversation for the owning tenant, regardless of external user", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    const found = await getConversationByIdForTenant(tenant.id, conv.id);
    expect(found?.id).toBe(conv.id);
  });

  it("returns null for another tenant's conversation", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    const conv = await createConversation(a.id, "customer-482");

    expect(await getConversationByIdForTenant(b.id, conv.id)).toBeNull();
  });

  it("returns null for a genuinely nonexistent id, indistinguishable from the above", async () => {
    const tenant = await makeTenant("acme");
    expect(await getConversationByIdForTenant(tenant.id, crypto.randomUUID())).toBeNull();
  });
});

describe("intent summary", () => {
  it("is null until explicitly set", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    expect(await getIntentSummary(conv.id)).toBeNull();
  });

  it("updateIntentSummary sets it, and getIntentSummary reads it back", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    await updateIntentSummary(conv.id, "Customer is asking about headache remedies.");

    expect(await getIntentSummary(conv.id)).toBe("Customer is asking about headache remedies.");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/chat/conversations.service.test.ts`
Expected: FAIL — cannot resolve `./conversations.service`.

- [ ] **Step 3: Implement the service**

Create `src/chat/conversations.service.ts`:

```ts
import { and, asc, count, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { conversations, messages, type Conversation, type Message } from "../db/schema";

export async function createConversation(
  tenantId: string,
  externalUserId: string,
): Promise<Conversation> {
  const [conv] = await db.insert(conversations).values({ tenantId, externalUserId }).returning();
  return conv!;
}

/**
 * Returns null on ANY mismatch — wrong tenant, wrong external user, or a
 * genuinely nonexistent id — never distinguishing which. Matching Sprint 1's
 * anti-probing contract: a caller must not be able to tell "not yours" from
 * "doesn't exist".
 */
export async function getConversation(
  tenantId: string,
  externalUserId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.tenantId, tenantId),
        eq(conversations.externalUserId, externalUserId),
      ),
    );
  return conv ?? null;
}

export async function listConversations(
  tenantId: string,
  externalUserId: string,
  page: number,
  limit: number,
): Promise<{ data: Conversation[]; total: number }> {
  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.externalUserId, externalUserId)))
      .orderBy(desc(conversations.updatedAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ total: count() })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.externalUserId, externalUserId))),
  ]);

  return { data: rows, total: Number(totals!.total) };
}

export async function appendMessage(
  conversationId: string,
  tenantId: string,
  role: "user" | "assistant",
  content: string,
): Promise<Message> {
  const [msg] = await db.insert(messages).values({ conversationId, tenantId, role, content }).returning();
  return msg!;
}

/**
 * Ascending by createdAt — a chat log reads top-to-bottom. This is the
 * opposite default from Sprint 1's listDocuments (descending by updatedAt),
 * which is worth remembering rather than copying that precedent blindly.
 */
export async function listMessages(
  conversationId: string,
  page: number,
  limit: number,
): Promise<{ data: Message[]; total: number }> {
  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: count() }).from(messages).where(eq(messages.conversationId, conversationId)),
  ]);

  return { data: rows, total: Number(totals!.total) };
}

/** The last `limit` messages, returned oldest-of-the-window first — ready to
 *  append directly after a system/summary message when building model context. */
export async function getRecentMessages(conversationId: string, limit: number): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function getIntentSummary(conversationId: string): Promise<string | null> {
  const [conv] = await db
    .select({ intentSummary: conversations.intentSummary })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return conv?.intentSummary ?? null;
}

export async function updateIntentSummary(conversationId: string, summary: string): Promise<void> {
  await db
    .update(conversations)
    .set({ intentSummary: summary, updatedAt: new Date().toISOString() })
    .where(eq(conversations.id, conversationId));
}

export async function countUserMessages(conversationId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")));
  return Number(row!.total);
}

/**
 * Tenant-only ownership check, distinct from getConversation's three-way
 * check. GET /v1/conversations/:id/messages has no externalUserId in its
 * path — only POST /v1/chat's body carries one, since only that request
 * claims to act as a specific external user. Without this check in front of
 * listMessages, any tenant could read any other tenant's messages by
 * guessing a conversation id.
 */
export async function getConversationByIdForTenant(
  tenantId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
  return conv ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/chat/conversations.service.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chat/conversations.service.ts src/chat/conversations.service.test.ts
git commit -m "feat(chat): add tenant-and-external-user-scoped conversations service"
```

---

### Task 9: Intent summary

**Files:**
- Create: `src/chat/intent-summary.ts`
- Test: `src/chat/intent-summary.test.ts`

**Interfaces:**
- Consumes: `chatModel` from Task 5, `getRecentMessages`/`updateIntentSummary`
  from Task 8.
- Produces: `maybeRefreshIntentSummary(conversationId: string, userTurnCount: number): void`
  — fire-and-forget, matching `verifyApiKey`'s `last_used_at` pattern from
  Sprint 1: never awaited by the caller, never allowed to fail or delay the
  actual chat reply.

- [ ] **Step 1: Write the failing test**

Create `src/chat/intent-summary.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
vi.mock("./model", () => ({ chatModel: { modelId: "fake" } }));
vi.mock("./conversations.service", () => ({
  getRecentMessages: vi.fn(async () => [
    { role: "user", content: "Do you have anything for a headache?" },
    { role: "assistant", content: "Paracetamol should help." },
  ]),
  updateIntentSummary: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("maybeRefreshIntentSummary", () => {
  it("does nothing when the turn count is not a multiple of 3", async () => {
    const { generateText } = await import("ai");
    const { maybeRefreshIntentSummary } = await import("./intent-summary");

    maybeRefreshIntentSummary("conv-1", 2);
    await vi.waitFor(() => expect(generateText).not.toHaveBeenCalled());
  });

  it("fires a summarization call on every 3rd user turn", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValue({ text: "Customer asked about headache relief." } as never);
    const { updateIntentSummary } = await import("./conversations.service");
    const { maybeRefreshIntentSummary } = await import("./intent-summary");

    maybeRefreshIntentSummary("conv-1", 3);

    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(updateIntentSummary).toHaveBeenCalledWith("conv-1", "Customer asked about headache relief."),
    );
  });

  it("never throws even when the summarization call fails", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockRejectedValue(new Error("rate limited"));
    const { maybeRefreshIntentSummary } = await import("./intent-summary");

    expect(() => maybeRefreshIntentSummary("conv-1", 6)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/chat/intent-summary.test.ts`
Expected: FAIL — cannot resolve `./intent-summary`.

- [ ] **Step 3: Implement it**

Create `src/chat/intent-summary.ts`:

```ts
import { generateText } from "ai";
import { getRecentMessages, updateIntentSummary } from "./conversations.service";
import { chatModel } from "./model";

const SUMMARY_TURN_INTERVAL = 3;
const SUMMARY_WINDOW = 12;

/**
 * Fire-and-forget, same discipline as verifyApiKey's last_used_at write in
 * Sprint 1: never awaited by the caller, never allowed to fail or delay the
 * actual chat reply. Runs through the SAME chat model/provider as the main
 * conversation — not a separate config — since splitting them isn't earning
 * its keep while both are free (see the design spec's rationale).
 */
export function maybeRefreshIntentSummary(conversationId: string, userTurnCount: number): void {
  if (userTurnCount % SUMMARY_TURN_INTERVAL !== 0) return;

  void refresh(conversationId).catch(() => {});
}

async function refresh(conversationId: string): Promise<void> {
  const recent = await getRecentMessages(conversationId, SUMMARY_WINDOW);
  const transcript = recent.map((m) => `${m.role}: ${m.content}`).join("\n");

  const { text } = await generateText({
    model: chatModel,
    prompt: `Summarize the customer's intent and key facts from this conversation in one or two short sentences, for use as context in later turns:\n\n${transcript}`,
  });

  await updateIntentSummary(conversationId, text.trim());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/chat/intent-summary.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chat/intent-summary.ts src/chat/intent-summary.test.ts
git commit -m "feat(chat): add fire-and-forget rolling intent summarization"
```

---

### Task 10: History builder

**Files:**
- Create: `src/chat/history.ts`
- Test: `src/chat/history.test.ts`

**Interfaces:**
- Consumes: `getRecentMessages`, `getIntentSummary` from Task 8.
- Produces: `buildContext(conversationId: string): Promise<ModelMessage[]>`
  (`ModelMessage` from `ai`).

- [ ] **Step 1: Write the failing test**

Create `src/chat/history.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("./conversations.service", () => ({
  getRecentMessages: vi.fn(),
  getIntentSummary: vi.fn(),
}));

describe("buildContext", () => {
  it("returns just the recent messages when there is no summary yet", async () => {
    const { getRecentMessages, getIntentSummary } = await import("./conversations.service");
    vi.mocked(getRecentMessages).mockResolvedValue([
      { role: "user", content: "hi" } as never,
    ]);
    vi.mocked(getIntentSummary).mockResolvedValue(null);

    const { buildContext } = await import("./history");
    const context = await buildContext("conv-1");

    expect(context).toEqual([{ role: "user", content: "hi" }]);
  });

  it("prepends a system message with the summary when one exists", async () => {
    const { getRecentMessages, getIntentSummary } = await import("./conversations.service");
    vi.mocked(getRecentMessages).mockResolvedValue([{ role: "user", content: "hi" } as never]);
    vi.mocked(getIntentSummary).mockResolvedValue("Customer previously asked about headaches.");

    const { buildContext } = await import("./history");
    const context = await buildContext("conv-1");

    expect(context[0]).toEqual({
      role: "system",
      content: "Earlier context: Customer previously asked about headaches.",
    });
    expect(context[1]).toEqual({ role: "user", content: "hi" });
  });

  it("fetches at most the last 6 messages", async () => {
    const { getRecentMessages, getIntentSummary } = await import("./conversations.service");
    vi.mocked(getRecentMessages).mockResolvedValue([]);
    vi.mocked(getIntentSummary).mockResolvedValue(null);

    const { buildContext } = await import("./history");
    await buildContext("conv-1");

    expect(getRecentMessages).toHaveBeenCalledWith("conv-1", 6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/chat/history.test.ts`
Expected: FAIL — cannot resolve `./history`.

- [ ] **Step 3: Implement it**

Create `src/chat/history.ts`:

```ts
import type { ModelMessage } from "ai";
import { getIntentSummary, getRecentMessages } from "./conversations.service";

const HISTORY_WINDOW = 6;

/**
 * A sliding window of recent turns plus a rolling summary, not the full
 * transcript — bounds token cost as a conversation grows, so turn 50 costs
 * roughly what turn 6 costs. Every message is still preserved in full in the
 * database (see conversations.service) — this is only what gets SENT to the
 * model on each call, never what gets stored.
 */
export async function buildContext(conversationId: string): Promise<ModelMessage[]> {
  const [recent, summary] = await Promise.all([
    getRecentMessages(conversationId, HISTORY_WINDOW),
    getIntentSummary(conversationId),
  ]);

  const recentMessages: ModelMessage[] = recent.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (!summary) return recentMessages;

  return [{ role: "system", content: `Earlier context: ${summary}` }, ...recentMessages];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/chat/history.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chat/history.ts src/chat/history.test.ts
git commit -m "feat(chat): add sliding-window history builder"
```

---

### Task 11: Chat metrics service

**Files:**
- Create: `src/chat/chat-metrics.service.ts`
- Test: `src/chat/chat-metrics.service.test.ts`

**Interfaces:**
- Consumes: `db`, `chatMetrics` from Task 1.
- Produces: `recordChatMetrics(input: RecordChatMetricsInput): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/chat/chat-metrics.service.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chatMetrics, conversations, messages, tenants } from "../db/schema";
import { recordChatMetrics } from "./chat-metrics.service";

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

describe("recordChatMetrics", () => {
  it("writes a row with all provided fields", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, tenantId: tenant!.id, role: "assistant", content: "hi" })
      .returning();

    await recordChatMetrics({
      conversationId: conv!.id,
      messageId: msg!.id,
      tenantId: tenant!.id,
      modelId: "deepseek/deepseek-r1:free",
      latencyMs: 842,
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165,
      costCredits: 0,
      toolCallCount: 1,
      retrievedChunkCount: 3,
    });

    const [row] = await db.select().from(chatMetrics).where(eq(chatMetrics.messageId, msg!.id));
    expect(row!.modelId).toBe("deepseek/deepseek-r1:free");
    expect(row!.latencyMs).toBe(842);
    expect(row!.promptTokens).toBe(120);
    expect(row!.toolCallCount).toBe(1);
    expect(row!.retrievedChunkCount).toBe(3);
  });

  it("accepts null for token/cost fields when the provider did not report them", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, tenantId: tenant!.id, role: "assistant", content: "hi" })
      .returning();

    await recordChatMetrics({
      conversationId: conv!.id,
      messageId: msg!.id,
      tenantId: tenant!.id,
      modelId: "some-model",
      latencyMs: 300,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costCredits: null,
      toolCallCount: 0,
      retrievedChunkCount: 0,
    });

    const [row] = await db.select().from(chatMetrics).where(eq(chatMetrics.messageId, msg!.id));
    expect(row!.promptTokens).toBeNull();
    expect(row!.costCredits).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/chat/chat-metrics.service.test.ts`
Expected: FAIL — cannot resolve `./chat-metrics.service`.

- [ ] **Step 3: Implement it**

Create `src/chat/chat-metrics.service.ts`:

```ts
import { db } from "../db";
import { chatMetrics } from "../db/schema";

export type RecordChatMetricsInput = {
  conversationId: string;
  messageId: string;
  tenantId: string;
  modelId: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costCredits: number | null;
  toolCallCount: number;
  retrievedChunkCount: number;
};

export async function recordChatMetrics(input: RecordChatMetricsInput): Promise<void> {
  await db.insert(chatMetrics).values({
    conversationId: input.conversationId,
    messageId: input.messageId,
    tenantId: input.tenantId,
    modelId: input.modelId,
    latencyMs: input.latencyMs,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.totalTokens,
    costCredits: input.costCredits === null ? null : String(input.costCredits),
    toolCallCount: input.toolCallCount,
    retrievedChunkCount: input.retrievedChunkCount,
  });
}
```

`costCredits` is stringified before insert because Drizzle's `numeric()`
column type maps to `string` on the JS side (Postgres `numeric` has more
precision than JS `number` can represent losslessly) — this mirrors how
Drizzle handles every other `numeric`/`decimal` column, not something special
to this table.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/chat/chat-metrics.service.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chat/chat-metrics.service.ts src/chat/chat-metrics.service.test.ts
git commit -m "feat(chat): add chat metrics recording"
```

---

### Task 12: `@fastify/sse` integration spike

**Files:**
- Create: `src/chat/sse-spike.test.ts` (throwaway — deleted at the end of this
  task once its answer is known and Task 15's real route tests are written
  accordingly)

**Interfaces:** none — this task produces no exported code, only an answered
question: does `app.inject()` cleanly capture a `@fastify/sse` route's
streamed body in this Vitest setup?

The design spec flagged this explicitly as unverified. Resolving it now, in
its own task, means Task 15 (the real chat routes) can be written against a
known-working test mechanism instead of an assumption.

- [ ] **Step 1: Install `@fastify/sse`**

```bash
pnpm add @fastify/sse@0.6.0
```

- [ ] **Step 2: Write the spike test**

Create `src/chat/sse-spike.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import fastifySSE from "@fastify/sse";

describe("@fastify/sse + app.inject() spike", () => {
  it("captures a streamed SSE body via inject()", async () => {
    const app = Fastify();
    await app.register(fastifySSE);

    app.get("/spike", { sse: "only" }, async (_request, reply) => {
      async function* gen() {
        yield { event: "token", data: JSON.stringify({ text: "a" }) };
        yield { event: "token", data: JSON.stringify({ text: "b" }) };
      }
      await reply.sse.send(gen());
    });

    await app.ready();
    const res = await app.inject({ method: "GET", url: "/spike" });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: token");
    expect(res.body).toContain('data: {"text":"a"}');
    expect(res.body).toContain('data: {"text":"b"}');
  });
});
```

- [ ] **Step 3: Run it and observe the actual result**

Run: `pnpm test src/chat/sse-spike.test.ts`

**If it passes as written:** `app.inject()` is a working test mechanism for
`@fastify/sse` routes. Proceed to Step 4.

**If it fails** — e.g. `res.body` is empty, truncated, or `inject()` hangs —
this is the fallback, not a blocker: boot a real server on an ephemeral port
and drive it with `fetch()` instead of `inject()`:

```ts
it("captures a streamed SSE body via a real HTTP request", async () => {
  const app = Fastify();
  await app.register(fastifySSE);
  app.get("/spike", { sse: "only" }, async (_request, reply) => {
    async function* gen() {
      yield { event: "token", data: JSON.stringify({ text: "a" }) };
    }
    await reply.sse.send(gen());
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const res = await fetch(`${address}/spike`);
  const body = await res.text();
  await app.close();

  expect(body).toContain("event: token");
});
```

Whichever mechanism actually works, Task 15's route tests are written against
it — do not carry an assumption into that task if this spike disproved it.

- [ ] **Step 4: Delete the spike test**

```bash
rm src/chat/sse-spike.test.ts
```

Its job was to answer a question, not to remain as permanent test coverage —
Task 15's real route tests cover this endpoint properly.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(chat): confirm @fastify/sse streaming test mechanism"
```

If the fallback (real server + fetch) was needed, note that explicitly in the
commit message instead, so Task 15's implementer isn't surprised by which
mechanism the route tests use.

---

### Task 13: Chat service (orchestrator)

**Files:**
- Create: `src/chat/chat.service.ts`
- Test: `src/chat/chat.service.test.ts`

**Interfaces:**
- Consumes: `chatModel` (Task 5); `searchKnowledgeTool` (Task 6);
  `adaptStream` (Task 7); `createConversation`, `getConversation`,
  `appendMessage`, `countUserMessages` (Task 8);
  `maybeRefreshIntentSummary` (Task 9); `buildContext` (Task 10);
  `recordChatMetrics` (Task 11).
- Produces: `runChat(input: RunChatInput): AsyncGenerator<ChatWireEvent>`,
  `ConversationNotFoundError`.

This is where every design decision from the spec becomes concrete: eager
conversation creation, the pre-flight ownership check, exactly one assistant
message per turn, and the pre-stream-vs-mid-stream error split.

- [ ] **Step 1: Write the failing test**

Create `src/chat/chat.service.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: vi.fn() };
});
vi.mock("./model", () => ({ chatModel: { modelId: "fake" } }));
vi.mock("./tools/search-knowledge", () => ({
  searchKnowledgeTool: vi.fn(() => ({ description: "fake tool" })),
}));
vi.mock("./conversations.service", () => ({
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  appendMessage: vi.fn(),
  countUserMessages: vi.fn(async () => 1),
}));
vi.mock("./intent-summary", () => ({ maybeRefreshIntentSummary: vi.fn() }));
vi.mock("./history", () => ({ buildContext: vi.fn(async () => []) }));
vi.mock("./chat-metrics.service", () => ({ recordChatMetrics: vi.fn() }));

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

/** A fake `result.stream` matching streamText()'s real AsyncIterableStream shape closely enough for these tests. */
function fakeResult(parts: unknown[], finalStepProviderMetadata?: unknown) {
  async function* stream() {
    for (const part of parts) yield part;
  }
  return {
    stream: stream(),
    finalStep: Promise.resolve({ providerMetadata: finalStepProviderMetadata }),
  };
}

afterEach(() => vi.clearAllMocks());

describe("runChat", () => {
  it("creates a conversation eagerly when conversationId is omitted", async () => {
    const { createConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(createConversation).mockResolvedValue({ id: "conv-new" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([{ type: "text-delta", id: "1", text: "hi" }, { type: "finish", totalUsage: {} }]) as never,
    );

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: null, message: "hello" }),
    );

    expect(createConversation).toHaveBeenCalledWith("t1", "u1");
    expect(events.at(-1)).toEqual({
      event: "done",
      data: { conversationId: "conv-new", messageId: "msg-1" },
    });
  });

  it("throws ConversationNotFoundError before ever calling the model when ownership does not match", async () => {
    const { getConversation } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue(null);

    const { runChat, ConversationNotFoundError } = await import("./chat.service");

    await expect(
      collect(
        runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-other", message: "hi" }),
      ),
    ).rejects.toThrow(ConversationNotFoundError);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("persists exactly one assistant message with the fully concatenated text", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([
        { type: "text-delta", id: "1", text: "Para" },
        { type: "text-delta", id: "1", text: "cetamol" },
        { type: "finish", totalUsage: {} },
      ]) as never,
    );

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(appendMessage).toHaveBeenCalledWith("conv-1", "t1", "assistant", "Paracetamol");
    expect(appendMessage).toHaveBeenCalledTimes(2); // user turn + assistant turn
  });

  it("yields a sources event and counts retrieved chunks", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search_knowledge",
          input: {},
          output: [{ externalId: "sku-1" }, { externalId: "sku-2" }],
        },
        { type: "finish", totalUsage: {} },
      ]) as never,
    );

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(events).toContainEqual({
      event: "sources",
      data: { documents: [{ externalId: "sku-1" }, { externalId: "sku-2" }] },
    });
  });

  it("yields an error event and does NOT persist an assistant message when the stream errors", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([{ type: "error", error: new Error("rate limited") }]) as never,
    );

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(events).toContainEqual({
      event: "error",
      data: { error: { code: "internal_error", message: "rate limited" } },
    });
    // Only the user's message was appended, never a second (assistant) call.
    expect(appendMessage).toHaveBeenCalledTimes(1);
  });

  it("triggers the intent summary refresh with the current user turn count", async () => {
    const { getConversation, appendMessage, countUserMessages } = await import(
      "./conversations.service"
    );
    const { maybeRefreshIntentSummary } = await import("./intent-summary");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(countUserMessages).mockResolvedValue(3);
    vi.mocked(streamText).mockReturnValue(fakeResult([{ type: "finish", totalUsage: {} }]) as never);

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(maybeRefreshIntentSummary).toHaveBeenCalledWith("conv-1", 3);
  });

  it("records metrics including OpenRouter's cost from finalStep.providerMetadata", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { recordChatMetrics } = await import("./chat-metrics.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult(
        [{ type: "finish", totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }],
        { openrouter: { usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cost: 0.0004 } } },
      ) as never,
    );

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    await vi.waitFor(() =>
      expect(recordChatMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ promptTokens: 100, completionTokens: 20, costCredits: 0.0004 }),
      ),
    );
  });

  it("defaults costCredits to null when providerMetadata has no openrouter usage (anthropic path)", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { recordChatMetrics } = await import("./chat-metrics.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([{ type: "finish", totalUsage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } }]) as never,
    );

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    await vi.waitFor(() =>
      expect(recordChatMetrics).toHaveBeenCalledWith(expect.objectContaining({ costCredits: null })),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/chat/chat.service.test.ts`
Expected: FAIL — cannot resolve `./chat.service`.

- [ ] **Step 3: Implement the orchestrator**

Create `src/chat/chat.service.ts`:

```ts
import { hasToolCall, isStepCount, streamText } from "ai";
import { config } from "../config";
import type { RetrievedChunk } from "../retrieval/retrieve";
import { recordChatMetrics } from "./chat-metrics.service";
import {
  appendMessage,
  countUserMessages,
  createConversation,
  getConversation,
} from "./conversations.service";
import { buildContext } from "./history";
import { maybeRefreshIntentSummary } from "./intent-summary";
import { chatModel } from "./model";
import { adaptStream } from "./stream-adapter";
import { searchKnowledgeTool } from "./tools/search-knowledge";

export class ConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found for this tenant and external user");
    this.name = "ConversationNotFoundError";
  }
}

export type RunChatInput = {
  tenantId: string;
  externalUserId: string;
  conversationId: string | null;
  message: string;
};

export type ChatWireEvent =
  | { event: "token"; data: { text: string } }
  | { event: "sources"; data: { documents: RetrievedChunk[] } }
  | { event: "done"; data: { conversationId: string; messageId: string } }
  | { event: "error"; data: { error: { code: string; message: string } } };

const MAX_TOOL_LOOP_STEPS = 4;

export async function* runChat(input: RunChatInput): AsyncGenerator<ChatWireEvent> {
  const startedAt = Date.now();

  const conversation = input.conversationId
    ? await requireOwnedConversation(input.tenantId, input.externalUserId, input.conversationId)
    : await createConversation(input.tenantId, input.externalUserId);

  await appendMessage(conversation.id, input.tenantId, "user", input.message);
  const userTurnCount = await countUserMessages(conversation.id);

  const context = await buildContext(conversation.id);

  const result = streamText({
    model: chatModel,
    messages: [...context, { role: "user", content: input.message }],
    tools: { search_knowledge: searchKnowledgeTool(input.tenantId) },
    stopWhen: [hasToolCall("search_knowledge"), isStepCount(MAX_TOOL_LOOP_STEPS)],
  });

  let assistantText = "";
  let toolCallCount = 0;
  let retrievedChunkCount = 0;
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};

  for await (const event of adaptStream(result.stream)) {
    switch (event.type) {
      case "token":
        assistantText += event.text;
        yield { event: "token", data: { text: event.text } };
        break;
      case "sources":
        toolCallCount += 1;
        retrievedChunkCount += event.documents.length;
        yield { event: "sources", data: { documents: event.documents } };
        break;
      case "finish":
        usage = event.usage;
        break;
      case "error":
        // Exactly one assistant message per turn, written only on a clean
        // finish (see the design spec) — an errored turn persists the user's
        // message (already appended above, so a retry has something to
        // continue from) but never a partial assistant reply.
        yield { event: "error", data: { error: { code: event.code, message: event.message } } };
        return;
    }
  }

  const assistantMessage = await appendMessage(conversation.id, input.tenantId, "assistant", assistantText);

  maybeRefreshIntentSummary(conversation.id, userTurnCount);

  void recordMetricsInBackground({
    conversationId: conversation.id,
    messageId: assistantMessage.id,
    tenantId: input.tenantId,
    latencyMs: Date.now() - startedAt,
    usage,
    toolCallCount,
    retrievedChunkCount,
    finalStep: result.finalStep,
  });

  yield { event: "done", data: { conversationId: conversation.id, messageId: assistantMessage.id } };
}

async function requireOwnedConversation(tenantId: string, externalUserId: string, conversationId: string) {
  const conversation = await getConversation(tenantId, externalUserId, conversationId);
  if (!conversation) throw new ConversationNotFoundError();
  return conversation;
}

/**
 * Cost is OpenRouter-specific and lives at
 * finalStep.providerMetadata.openrouter.usage.cost — confirmed against the
 * installed @openrouter/ai-sdk-provider's real OpenRouterUsageAccounting
 * type. Absent entirely on the anthropic path, so this defaults to null
 * rather than assuming the shape exists. Fire-and-forget: metrics must never
 * fail or delay the chat response, which has already been yielded by the
 * time this runs.
 */
async function recordMetricsInBackground(args: {
  conversationId: string;
  messageId: string;
  tenantId: string;
  latencyMs: number;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  toolCallCount: number;
  retrievedChunkCount: number;
  finalStep: Awaited<ReturnType<typeof streamText>>["finalStep"];
}): Promise<void> {
  try {
    const finalStep = await args.finalStep;
    const openrouterUsage = (
      finalStep.providerMetadata as { openrouter?: { usage?: { cost?: number } } } | undefined
    )?.openrouter?.usage;

    await recordChatMetrics({
      conversationId: args.conversationId,
      messageId: args.messageId,
      tenantId: args.tenantId,
      modelId: config.CHAT_MODEL_ID,
      latencyMs: args.latencyMs,
      promptTokens: args.usage.inputTokens ?? null,
      completionTokens: args.usage.outputTokens ?? null,
      totalTokens: args.usage.totalTokens ?? null,
      costCredits: openrouterUsage?.cost ?? null,
      toolCallCount: args.toolCallCount,
      retrievedChunkCount: args.retrievedChunkCount,
    });
  } catch {
    // never let metrics recording surface as a chat-facing failure
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/chat/chat.service.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chat/chat.service.ts src/chat/chat.service.test.ts
git commit -m "feat(chat): add chat orchestrator tying model, tools, history and metrics together"
```

---

### Task 14: Chat request/response schemas

**Files:**
- Create: `src/chat/chat.schema.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `chatBody`, `listConversationsQuery`, `conversationParams`,
  `listMessagesQuery`, `conversationResponse`, `messageResponse` — all Zod
  schemas, consumed by Task 15's routes.

This task has no test of its own — Zod schema objects have no behavior to
unit test in isolation; Task 15's route tests exercise validation through the
actual HTTP layer, matching Sprint 1's `documents.schema.ts` precedent.

- [ ] **Step 1: Write the schemas**

Create `src/chat/chat.schema.ts`:

```ts
import { z } from "zod";

export const chatBody = z.object({
  externalUserId: z
    .string()
    .min(1)
    .describe("Your own identifier for the end user having this conversation."),
  conversationId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe("Omit or send null to start a new conversation thread."),
  message: z.string().min(1).max(4000),
});

export const listConversationsQuery = z.object({
  externalUserId: z
    .string()
    .min(1)
    .describe("Required — this endpoint always answers for exactly one end user."),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const conversationParams = z.object({
  id: z.string().uuid(),
});

export const listMessagesQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const conversationResponse = z.object({
  id: z.string(),
  externalUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const messageResponse = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});
```

- [ ] **Step 2: Commit**

```bash
git add src/chat/chat.schema.ts
git commit -m "feat(chat): add chat request and response schemas"
```

---

### Task 15: Chat routes

**Files:**
- Create: `src/chat/chat.routes.ts`
- Modify: `src/app.ts`
- Test: `src/chat/chat.routes.test.ts`

**Interfaces:**
- Consumes: `runChat`, `ConversationNotFoundError` (Task 13); `chatBody`,
  `listConversationsQuery`, `conversationParams`, `listMessagesQuery`,
  `conversationResponse`, `messageResponse` (Task 14);
  `listConversations`, `listMessages`, `getConversationByIdForTenant`
  (Task 8); `errorResponse`, `documentResponse`-style patterns from Sprint 1's
  `documents.schema.ts` (reused, not duplicated).
- Produces: `POST /v1/chat`, `GET /v1/conversations`,
  `GET /v1/conversations/:id/messages`, registered into `buildApp()`'s `/v1`
  scope.

**One thing to verify while writing this task, not assumed:** whether a route
declared with `{ sse: "only" }` can still send a plain, non-SSE JSON response
conditionally (needed for the `ConversationNotFoundError` → `404` path, which
must happen *before* SSE headers commit). Write and run the "returns a plain
404 without ever starting an SSE stream" test from Step 2 **first**, in
isolation, before writing the streaming-success tests — if it fails because
the route option forbids a non-SSE response, the fallback is to **omit**
`sse: "only"` from the route options entirely and rely on `@fastify/sse`
decorating `reply.sse` at the plugin-registration level (available on every
route once `app.register(fastifySSE)` has run), calling `reply.sse.send(...)`
directly only in the success path. Confirm which mechanism actually works
before writing the remaining tests, the same discipline as Task 12's spike.

- [ ] **Step 1: Register `@fastify/sse` in `buildApp()`**

Modify `src/app.ts`. Add the import and register it alongside the other
plugins (order matters here only in that it must be registered before the
`/v1` scope that uses it):

```ts
import fastifySSE from "@fastify/sse";
```

```ts
  void app.register(fastifySSE);
```

- [ ] **Step 2: Write the failing route tests**

Create `src/chat/chat.routes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, chatMetrics, conversations, messages, tenants } from "../db/schema";
import { createTenant, issueApiKey } from "../tenants/tenants.service";
import { buildApp } from "../app";

// No route test in this file creates a document, but runChat's tool-use loop
// still resolves search_knowledge's dependency chain down to lib/voyage — mock
// it so a mistaken real network call fails loudly instead of hanging on a
// real API key that test env deliberately doesn't have.
vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  ),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
  rerank: vi.fn(async (_q: string, texts: string[]) => texts.map((_t, i) => i)),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: vi.fn(), generateText: vi.fn() };
});

// Only the tables this file actually touches — chunks/documents are never
// created here, since every test either mocks streamText entirely or hits
// routes that don't ingest content.
async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

async function tenantWithKey(slug: string) {
  const tenant = await createTenant({ name: slug, slug });
  const { plaintext } = await issueApiKey(tenant.id, "test");
  return { tenant, key: plaintext };
}

function fakeStreamTextResult(parts: unknown[], providerMetadata?: unknown) {
  async function* stream() {
    for (const part of parts) yield part;
  }
  return { stream: stream(), finalStep: Promise.resolve({ providerMetadata }) };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

beforeEach(clean);

describe("POST /v1/chat", () => {
  it("returns a plain 404 without ever starting an SSE stream, for an unknown conversationId", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${key}` },
      payload: { externalUserId: "customer-482", conversationId: crypto.randomUUID(), message: "hi" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { externalUserId: "u1", message: "hi" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a body missing externalUserId", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${key}` },
      payload: { message: "hi" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("streams token, sources, and done events for a new conversation", async () => {
    const { key } = await tenantWithKey("acme");
    const { streamText } = await import("ai");
    vi.mocked(streamText).mockReturnValue(
      fakeStreamTextResult([
        { type: "text-delta", id: "1", text: "Paracetamol" },
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search_knowledge",
          input: {},
          output: [{ externalId: "sku-1" }],
        },
        { type: "finish", totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      ]) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${key}` },
      payload: { externalUserId: "customer-482", message: "Do you have anything for a headache?" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: token");
    expect(res.body).toContain('"text":"Paracetamol"');
    expect(res.body).toContain("event: sources");
    expect(res.body).toContain("event: done");
  });
});

describe("GET /v1/conversations", () => {
  it("requires externalUserId", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it("lists only the given external user's conversations", async () => {
    const { key, tenant } = await tenantWithKey("acme");
    await db.insert(conversations).values([
      { tenantId: tenant.id, externalUserId: "customer-482" },
      { tenantId: tenant.id, externalUserId: "customer-999" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/v1/conversations?externalUserId=customer-482",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].externalUserId).toBe("customer-482");
  });

  it("never returns another tenant's conversations", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await db.insert(conversations).values({ tenantId: a.tenant.id, externalUserId: "customer-482" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/conversations?externalUserId=customer-482",
      headers: { authorization: `Bearer ${b.key}` },
    });

    expect(res.json().data).toHaveLength(0);
  });
});

describe("GET /v1/conversations/:id/messages", () => {
  it("returns the message log in ascending order", async () => {
    const { key, tenant } = await tenantWithKey("acme");
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant.id, externalUserId: "customer-482" })
      .returning();
    await db.insert(messages).values([
      { conversationId: conv!.id, tenantId: tenant.id, role: "user", content: "first" },
      { conversationId: conv!.id, tenantId: tenant.id, role: "assistant", content: "second" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conv!.id}/messages`,
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((m: { content: string }) => m.content)).toEqual(["first", "second"]);
  });

  it("returns 404 for another tenant's conversation", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: a.tenant.id, externalUserId: "customer-482" })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conv!.id}/messages`,
      headers: { authorization: `Bearer ${b.key}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("returns 404 for a genuinely nonexistent conversation, indistinguishable from the above", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "GET",
      url: `/v1/conversations/${crypto.randomUUID()}/messages`,
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/chat/chat.routes.test.ts`
Expected: FAIL — cannot resolve `../app`'s chat routes (not yet registered).

- [ ] **Step 4: Write the routes**

Create `src/chat/chat.routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponse } from "../documents/documents.schema";
import type { Conversation, Message } from "../db/schema";
import {
  chatBody,
  conversationParams,
  conversationResponse,
  listConversationsQuery,
  listMessagesQuery,
  messageResponse,
} from "./chat.schema";
import { ConversationNotFoundError, runChat, type ChatWireEvent } from "./chat.service";
import { getConversationByIdForTenant, listConversations, listMessages } from "./conversations.service";

function toPublicConversation(c: Conversation) {
  return { id: c.id, externalUserId: c.externalUserId, createdAt: c.createdAt, updatedAt: c.updatedAt };
}

function toPublicMessage(m: Message) {
  return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt };
}

function toSSEFrame(event: ChatWireEvent): { event: string; data: string } {
  return { event: event.event, data: JSON.stringify(event.data) };
}

const chatRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/chat",
    {
      schema: {
        tags: ["Chat"],
        summary: "Send a message and receive a streamed reply",
        description:
          "Streams the reply over Server-Sent Events (token, sources, done, error). " +
          "A conversationId that does not belong to the caller returns a plain 404 " +
          "BEFORE the stream starts. A failure mid-stream is an `error` SSE event " +
          "instead, since the HTTP status can no longer change once streaming has " +
          "begun — see docs/errors.md.",
        security: [{ bearerAuth: [] }],
        body: chatBody,
        response: { 400: errorResponse, 401: errorResponse, 404: errorResponse },
      },
      sse: "only",
    },
    async (request, reply) => {
      const { externalUserId, conversationId, message } = request.body;
      const generator = runChat({
        tenantId: request.tenant!.id,
        externalUserId,
        conversationId: conversationId ?? null,
        message,
      });

      let first: IteratorResult<ChatWireEvent>;
      try {
        first = await generator.next();
      } catch (err) {
        if (err instanceof ConversationNotFoundError) {
          return reply
            .code(404)
            .send({ error: { code: "not_found", message: "Conversation not found" } });
        }
        throw err;
      }

      async function* toSSE() {
        if (!first.done) yield toSSEFrame(first.value);
        for await (const event of generator) yield toSSEFrame(event);
      }

      await reply.sse.send(toSSE());
    },
  );

  app.get(
    "/conversations",
    {
      schema: {
        tags: ["Chat"],
        summary: "List this tenant's conversation threads for one external user",
        security: [{ bearerAuth: [] }],
        querystring: listConversationsQuery,
        response: {
          200: z.object({
            data: z.array(conversationResponse),
            meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
          }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { externalUserId, page, limit } = request.query;
      const { data, total } = await listConversations(request.tenant!.id, externalUserId, page, limit);
      return reply
        .code(200)
        .send({ data: data.map(toPublicConversation), meta: { page, limit, total } });
    },
  );

  app.get(
    "/conversations/:id/messages",
    {
      schema: {
        tags: ["Chat"],
        summary: "Full message log for one conversation, oldest first",
        security: [{ bearerAuth: [] }],
        params: conversationParams,
        querystring: listMessagesQuery,
        response: {
          200: z.object({
            data: z.array(messageResponse),
            meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const conversation = await getConversationByIdForTenant(request.tenant!.id, request.params.id);
      if (!conversation) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Conversation not found" } });
      }

      const { page, limit } = request.query;
      const { data, total } = await listMessages(conversation.id, page, limit);
      return reply.code(200).send({ data: data.map(toPublicMessage), meta: { page, limit, total } });
    },
  );
};

export default chatRoutes;
```

- [ ] **Step 5: Register the routes in `buildApp()`**

Modify `src/app.ts` — add `chatRoutes` alongside `documentsRoutes` inside the
`/v1` scope:

```ts
import chatRoutes from "./chat/chat.routes";
```

```ts
  void app.register(
    async (v1) => {
      await v1.register(authPlugin);
      await v1.register(documentsRoutes);
      await v1.register(chatRoutes);
    },
    { prefix: "/v1" },
  );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/chat/chat.routes.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: every suite passes, including every Sprint 1 test unmodified.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/app.ts src/chat/chat.routes.ts src/chat/chat.routes.test.ts
git commit -m "feat(api): add chat, conversations and messages endpoints"
```

---

### Task 16: CI env block update

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:** none — configuration only.

`OPENROUTER_API_KEY` is now conditionally required (default provider is
`openrouter`), which means — per the exact trap Sprint 1's README already
documents — CI's `test` job env block needs it, or every test in the suite
fails config validation the moment this task's config change lands, with a
passing local build giving no warning (your local `.env` already has the
var; CI's job env block does not, until you add it here).

- [ ] **Step 1: Add the new env vars to the `test` job**

Modify `.github/workflows/ci.yml`'s `env:` block:

```yaml
    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
      VOYAGE_API_KEY: ci-test-key
      VOYAGE_EMBEDDING_MODEL: voyage-3
      OPENROUTER_API_KEY: ci-test-key
      CHAT_MODEL_PROVIDER: openrouter
      CHAT_MODEL_ID: deepseek/deepseek-r1:free
      NODE_ENV: test
```

`OPENROUTER_API_KEY` is a throwaway string, not a secret, same reasoning as
`VOYAGE_API_KEY`: every test mocks `ai`'s `streamText`/`generateText`, so the
value is only ever read by config validation, never sent to a real API. CI
must never be able to spend money.

- [ ] **Step 2: Verify locally against the exact CI recipe**

Rehearse this exactly as Sprint 1's CI task did — a real `pgvector/pgvector:pg16`
container with only the CI env vars set:

```bash
docker run -d --name ci-rehearsal-s2 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres -p 55433:5432 pgvector/pgvector:pg16
```

```bash
for f in supabase/migrations/*.sql; do
  psql "postgresql://postgres:postgres@127.0.0.1:55433/postgres" -v ON_ERROR_STOP=1 -f "$f"
done
```

```bash
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55433/postgres" \
  VOYAGE_API_KEY=ci-test-key VOYAGE_EMBEDDING_MODEL=voyage-3 \
  OPENROUTER_API_KEY=ci-test-key CHAT_MODEL_PROVIDER=openrouter \
  CHAT_MODEL_ID=deepseek/deepseek-r1:free NODE_ENV=test \
  pnpm lint && pnpm typecheck && pnpm test
```

Expected: all green, using only the values CI itself will have — not your
local `.env`. Then remove the rehearsal container:

```bash
docker rm -f ci-rehearsal-s2
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add chat model env vars to the test job"
```

- [ ] **Step 4: Confirm CI is green after pushing**

Not optional — part of this sprint's exit gate, same as Sprint 1's.

---

### Task 17: Document the pre-stream vs mid-stream error contract

**Files:**
- Modify: `docs/errors.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add the new section**

Append to `docs/errors.md`:

```markdown
## Streaming errors (`POST /v1/chat`)

`POST /v1/chat` is the one endpoint in this API where an error can arrive
**after** a `200` has already started — because once
`Content-Type: text/event-stream` headers are sent, the HTTP status can never
change. There are genuinely two error paths, not one:

| When | Surface |
|---|---|
| Before streaming starts (bad body, unknown/foreign `conversationId`) | Normal JSON `400`/`404`, exactly like every other route in this API |
| After streaming starts (rate-limited, model unavailable, any mid-stream failure) | An `error` SSE event, then the connection closes |

A mid-stream `error` event has the same shape as every other error in this
API:

```
event: error
data: {"error":{"code":"internal_error","message":"..."}}
```

**A client must handle both.** Checking the initial HTTP status alone is not
enough — a `200` does not guarantee the reply completed successfully. Listen
for the `error` event type in the stream body as well.
```

- [ ] **Step 2: Commit**

```bash
git add docs/errors.md
git commit -m "docs: document the pre-stream vs mid-stream chat error contract"
```

---

### Task 18: Reranking eval harness

**Files:**
- Create: `src/eval/scoring.ts`
- Create: `src/eval/scoring.test.ts`
- Create: `content/eval/retrieval-golden.json`
- Create: `src/scripts/eval-retrieval.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `retrieve` (Task 4), `upsertDocument` (Sprint 1), `createTenant`
  (Sprint 1).
- Produces: `hitRate(results, expectedExternalId): boolean`,
  `reciprocalRank(results, expectedExternalId): number` — pure, unit-tested
  functions; `pnpm eval:retrieval` — a manual script, real Voyage API calls,
  never run in CI.

**Scope note on metrics.** The golden format below has exactly one expected
document per query, not a full relevance judgment set — so "precision" and
"recall" in the usual multi-relevant-document sense would not mean anything
here (precision@K degenerates to a constant `1/K` on any hit). The two
metrics that are actually meaningful for this shape of data are **hit-rate**
(did the expected document appear anywhere in the top K at all) and **MRR**
(did reranking move it *closer to the top*, not just into the results). This
plan implements those two honestly rather than a "precision/recall/MRR"
framing wider than this golden set can support.

- [ ] **Step 1: Write the failing scoring tests**

Create `src/eval/scoring.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hitRate, reciprocalRank } from "./scoring";

const results = [{ externalId: "sku-2" }, { externalId: "sku-1" }, { externalId: "sku-3" }];

describe("hitRate", () => {
  it("is true when the expected id appears anywhere in the results", () => {
    expect(hitRate(results, "sku-1")).toBe(true);
  });

  it("is false when the expected id is absent", () => {
    expect(hitRate(results, "sku-9")).toBe(false);
  });
});

describe("reciprocalRank", () => {
  it("returns 1 when the expected id is first", () => {
    expect(reciprocalRank(results, "sku-2")).toBe(1);
  });

  it("returns 1/2 when the expected id is second", () => {
    expect(reciprocalRank(results, "sku-1")).toBe(0.5);
  });

  it("returns 1/3 when the expected id is third", () => {
    expect(reciprocalRank(results, "sku-3")).toBe(1 / 3);
  });

  it("returns 0 when the expected id is absent", () => {
    expect(reciprocalRank(results, "sku-9")).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/eval/scoring.test.ts`
Expected: FAIL — cannot resolve `./scoring`.

- [ ] **Step 3: Implement the scoring functions**

Create `src/eval/scoring.ts`:

```ts
type ScorableResult = { externalId: string };

export function hitRate(results: ScorableResult[], expectedExternalId: string): boolean {
  return results.some((r) => r.externalId === expectedExternalId);
}

/**
 * 1/(rank), rank starting at 1 — 0 if the expected document never appears.
 * Unlike hitRate, this rewards ranking it near the top, not just anywhere in
 * the results, which is what a reranking pass is actually trying to improve.
 */
export function reciprocalRank(results: ScorableResult[], expectedExternalId: string): number {
  const index = results.findIndex((r) => r.externalId === expectedExternalId);
  return index === -1 ? 0 : 1 / (index + 1);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/eval/scoring.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit the scoring logic**

```bash
git add src/eval/
git commit -m "feat(eval): add hit-rate and MRR scoring, unit-tested"
```

- [ ] **Step 6: Write the golden dataset**

Create `content/eval/retrieval-golden.json`. Two domains, deliberately
different in character — extending the pharmacy examples already used
throughout `docs/`/`examples/`, plus a new docs-site FAQ domain, so a result
that only holds for catalog-shaped content cannot pass this eval.

```json
{
  "domains": {
    "pharmacy": {
      "documents": [
        {
          "externalId": "sku-1",
          "title": "Paracetamol",
          "content": "Paracetamol 500mg tablets. Relieves fever, headache and mild pain."
        },
        {
          "externalId": "sku-2",
          "title": "Loratadine",
          "content": "Loratadine 10mg antihistamine tablets for hay fever and allergic rhinitis."
        },
        {
          "externalId": "sku-3",
          "title": "Sterile bandage",
          "content": "Sterile adhesive bandages for dressing minor cuts and grazes."
        },
        {
          "externalId": "sku-4",
          "title": "Ibuprofen gel",
          "content": "Ibuprofen 5% topical gel for localized muscle and joint pain relief."
        },
        {
          "externalId": "sku-5",
          "title": "Rehydration sachets",
          "content": "Oral rehydration salts for fluid loss from vomiting or diarrhoea."
        }
      ],
      "queries": [
        { "query": "reduce a high temperature", "expectedExternalId": "sku-1" },
        { "query": "my nose runs every spring", "expectedExternalId": "sku-2" },
        { "query": "I cut my finger and it's bleeding", "expectedExternalId": "sku-3" },
        { "query": "sore knee after running", "expectedExternalId": "sku-4" },
        { "query": "keep fluids up after being sick", "expectedExternalId": "sku-5" },
        { "query": "something for a pounding head", "expectedExternalId": "sku-1" },
        { "query": "seasonal sneezing and itchy eyes", "expectedExternalId": "sku-2" },
        { "query": "cover a small wound", "expectedExternalId": "sku-3" }
      ]
    },
    "docs-site": {
      "documents": [
        {
          "externalId": "faq-invite",
          "title": "Inviting teammates",
          "content": "To add someone to your workspace, open Settings, choose Members, and enter their email. They'll receive a link to join."
        },
        {
          "externalId": "faq-export",
          "title": "Exporting your data",
          "content": "You can download everything in your account as a CSV or JSON archive from the Data tab under Account Settings, at any time."
        },
        {
          "externalId": "faq-cancel",
          "title": "Cancelling a subscription",
          "content": "Cancelling stops future billing immediately, but you keep access until the end of the period you already paid for."
        },
        {
          "externalId": "faq-mobile",
          "title": "Mobile access",
          "content": "There isn't a dedicated app yet, but the site works fully in a mobile browser, including offline drafts."
        },
        {
          "externalId": "faq-password",
          "title": "Resetting your password",
          "content": "Use the 'forgot password' link on the sign-in page. A reset link is emailed to you and expires after one hour."
        }
      ],
      "queries": [
        { "query": "how do I add a colleague to my team", "expectedExternalId": "faq-invite" },
        { "query": "get all my information out of the app", "expectedExternalId": "faq-export" },
        { "query": "what happens if I stop paying", "expectedExternalId": "faq-cancel" },
        { "query": "can I use this on my phone", "expectedExternalId": "faq-mobile" },
        { "query": "I forgot how to sign in", "expectedExternalId": "faq-password" },
        { "query": "will I still be billed if I quit today", "expectedExternalId": "faq-cancel" },
        { "query": "is there a phone app to install", "expectedExternalId": "faq-mobile" },
        { "query": "download a copy of everything", "expectedExternalId": "faq-export" }
      ]
    }
  }
}
```

Every query was written to share no exact keyword with its expected
document's title or content — the same discipline as the quickstart's own
"reduce a high temperature" → Paracetamol proof, applied across sixteen
cases instead of one.

- [ ] **Step 7: Write the eval script**

Create `src/scripts/eval-retrieval.ts`:

```ts
/* eslint-disable no-console */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chunks, documents, tenants } from "../db/schema";
import { upsertDocument } from "../documents/documents.service";
import { retrieve } from "../retrieval/retrieve";
import { hitRate, reciprocalRank } from "../eval/scoring";
import { createTenant } from "../tenants/tenants.service";

type GoldenDomain = {
  documents: { externalId: string; title: string; content: string }[];
  queries: { query: string; expectedExternalId: string }[];
};

type Golden = { domains: Record<string, GoldenDomain> };

const EVAL_TENANT_SLUG = "eval-harness";

async function ensureEvalTenant() {
  const existing = await db.select().from(tenants).where(eq(tenants.slug, EVAL_TENANT_SLUG));
  if (existing[0]) return existing[0];
  return createTenant({ name: "Eval Harness", slug: EVAL_TENANT_SLUG });
}

async function main(): Promise<void> {
  const golden: Golden = JSON.parse(
    readFileSync(join(__dirname, "../../content/eval/retrieval-golden.json"), "utf8"),
  );

  const tenant = await ensureEvalTenant();

  console.log("Ingesting golden content (real Voyage embedding calls)...\n");
  for (const domain of Object.values(golden.domains)) {
    for (const doc of domain.documents) {
      await upsertDocument(tenant.id, doc);
    }
  }

  const modes = ["hybrid", "hybrid+rerank"] as const;
  const summary: Record<string, Record<(typeof modes)[number], { hitRate: number; mrr: number }>> = {};

  for (const [domainName, domain] of Object.entries(golden.domains)) {
    summary[domainName] = {} as never;

    for (const mode of modes) {
      let hits = 0;
      let mrrSum = 0;

      for (const { query, expectedExternalId } of domain.queries) {
        const results = await retrieve(tenant.id, query, 5, { mode });
        if (hitRate(results, expectedExternalId)) hits += 1;
        mrrSum += reciprocalRank(results, expectedExternalId);
      }

      summary[domainName][mode] = {
        hitRate: hits / domain.queries.length,
        mrr: mrrSum / domain.queries.length,
      };
    }
  }

  console.log("Domain      Mode            Hit-rate   MRR");
  console.log("----------  --------------  ---------  -----");
  let allDomainsImproveOrHold = true;
  for (const [domainName, modeScores] of Object.entries(summary)) {
    for (const mode of modes) {
      const { hitRate: hr, mrr } = modeScores[mode];
      console.log(
        `${domainName.padEnd(12)}${mode.padEnd(16)}${hr.toFixed(2).padEnd(11)}${mrr.toFixed(3)}`,
      );
    }
    if (modeScores["hybrid+rerank"].mrr < modeScores.hybrid.mrr) allDomainsImproveOrHold = false;
  }

  console.log();
  console.log(
    allDomainsImproveOrHold
      ? "PASS — hybrid+rerank scores >= plain hybrid on every domain."
      : "FAIL — hybrid+rerank scored WORSE than plain hybrid on at least one domain. Do not ship reranking as the default until this is investigated.",
  );

  await db.$client.end();
}

void main();
```

- [ ] **Step 8: Add the script and Voyage API key requirement**

Add to `package.json`'s scripts:

```json
"eval:retrieval": "tsx src/scripts/eval-retrieval.ts"
```

- [ ] **Step 9: Run it against your local stack**

```bash
pnpm db:reset   # start from a clean local DB — this is a real API cost run
pnpm eval:retrieval
```

Expected: a table of hit-rate/MRR for both domains, both modes, ending in a
`PASS` or `FAIL` line. This is the actual exit-gate proof for this sprint —
"reranking eval shows ≥ parity vs. plain hybrid" means this line must read
`PASS`. If it reads `FAIL`, that is a real finding to investigate before
considering reranking done, not a reason to edit the script until it passes.

- [ ] **Step 10: Commit**

```bash
git add content/eval/ src/scripts/eval-retrieval.ts package.json
git commit -m "feat(eval): add two-domain reranking eval harness"
```

---

### Task 19: Integration docs and a runnable chat example

**Files:**
- Modify: `docs/quickstart.md`
- Modify: `docs/concepts.md`
- Modify: `docs/self-hosting.md`
- Modify: `examples/curl.sh`
- Create: `examples/node/chat.js`
- Create: `examples/node/chat-README.md` (or fold into the existing
  `examples/node/README.md` — see Step 5)

Matches Sprint 1's discipline: documentation ships inside the sprint, not
after it. A developer who cannot integrate the new capability from the docs
alone is exactly the gap this task closes.

- [ ] **Step 1: Add a chat section to `docs/quickstart.md`**

Append a new step after the existing search step:

```markdown
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
```

- [ ] **Step 2: Add conversation concepts to `docs/concepts.md`**

Append:

```markdown
## Conversation

A conversation belongs to a **tenant and one of that tenant's own end users**
(`externalUserId` — your identifier for them, not ours). One end user can have
many conversations; omit `conversationId` to start a new one, or send one back
to continue an existing thread.

Every message — yours and the assistant's — is preserved in full,
indefinitely (retention lands in a later sprint). A short rolling summary is
kept alongside the full log purely to bound how much context gets sent to the
model on long conversations; it never replaces the underlying messages.

The assistant can call `search_knowledge` mid-reply — the same retrieval
`POST /v1/search` exposes directly, with a reranking pass added on top. What
it found is returned as a `sources` event, so you can show citations without
re-querying separately.
```

- [ ] **Step 3: Add the new env vars to `docs/self-hosting.md`**

Add rows to the existing environment variable table:

```markdown
| `CHAT_MODEL_PROVIDER`   | no          | `openrouter` | `openrouter` \| `anthropic`                                  |
| `CHAT_MODEL_ID`         | no          | `deepseek/deepseek-r1:free` | See the delisting runbook below                |
| `OPENROUTER_API_KEY`    | conditional | —            | Required when `CHAT_MODEL_PROVIDER=openrouter` (the default) |
| `ANTHROPIC_API_KEY`     | conditional | —            | Required when `CHAT_MODEL_PROVIDER=anthropic`                |
```

Add the runbook as its own subsection:

```markdown
### When `CHAT_MODEL_ID` stops working

OpenRouter's free-tier models rotate and get delisted without warning — this
is a known, expected occurrence, not a bug in this service. If chat requests
start failing with a model-not-found or similar error from the provider:

1. Check <https://openrouter.ai/models?supported_parameters=tools&free> for a
   current replacement that supports tool calling (`search_knowledge` requires
   it).
2. Update `CHAT_MODEL_ID`, redeploy. No code change needed — this is exactly
   why the model id is a config value rather than a constant.
```

- [ ] **Step 4: Add a chat example to `examples/curl.sh`**

Append, before the final "no key" example (so the script still ends on the
error-case demonstration):

```bash
echo "== POST /v1/chat (streamed) =="
curl -N -sS -X POST "${BASE_URL}/v1/chat" "${auth[@]}" "${json[@]}" \
  -d '{"externalUserId": "curl-example-user", "message": "Do you have anything for a headache?"}'
echo -e "\n"
```

`-N` disables curl's output buffering — without it, streamed output only
appears once the connection closes, defeating the point of watching it live.

- [ ] **Step 5: Write `examples/node/chat.js`**

```js
/**
 * Consumes POST /v1/chat's Server-Sent Events stream with plain fetch — no
 * dependencies, matching index.js's own "no client SDK yet" stance (see
 * docs/superpowers/specs/2026-07-30-chat-engine-design.md).
 *
 *   API_KEY=sk_live_... node examples/node/chat.js
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4000";
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("API_KEY is not set. Create a tenant first:");
  console.error('  pnpm create-tenant "Acme Pharmacy" acme-pharmacy');
  process.exit(1);
}

/** Parses one SSE frame ("event: x\ndata: {...}\n\n") into {event, data}. */
function parseFrame(frame) {
  const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
  const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
  return {
    event: eventLine?.slice("event: ".length),
    data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : undefined,
  };
}

async function chat(externalUserId, conversationId, message) {
  const res = await fetch(`${BASE_URL}/v1/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ externalUserId, conversationId, message }),
  });

  if (!res.ok) {
    const body = await res.json();
    throw new Error(`chat failed [${body.error.code}]: ${body.error.message}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let newConversationId = conversationId;

  process.stdout.write("Assistant: ");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const { event, data } = parseFrame(frame);

      if (event === "token") process.stdout.write(data.text);
      if (event === "sources") {
        console.log(`\n  (cited: ${data.documents.map((d) => d.externalId).join(", ")})`);
      }
      if (event === "done") newConversationId = data.conversationId;
      if (event === "error") throw new Error(`stream error [${data.error.code}]: ${data.error.message}`);
    }
  }
  console.log();

  return newConversationId;
}

async function main() {
  const conversationId = await chat("example-user", null, "Do you have anything for a headache?");
  await chat("example-user", conversationId, "How many should I take?");
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 6: Update `examples/node/README.md`**

Add a section:

```markdown
## Chat (streaming)

```bash
pnpm create-tenant "Example Co" example-co
API_KEY=sk_live_... node examples/node/chat.js
```

Demonstrates a two-turn conversation: the first call omits `conversationId`
and prints the one the server assigns; the second call sends it back to
continue the same thread. Each reply that cites a document prints which one,
from the `sources` event.
```

- [ ] **Step 7: Verify the quickstart end to end**

```bash
pnpm db:reset
```

Follow `docs/quickstart.md` **verbatim, without consulting the source**,
through the new chat section, confirming a real streamed reply and a
`sources` event citing the document pushed earlier in the quickstart.

- [ ] **Step 8: Verify the runnable example**

```bash
pnpm create-tenant "Example Co" example-co
API_KEY=<printed key> node examples/node/chat.js
```

Expected: two assistant replies print, the second continuing the same
conversation, at least one citing a document if one was pushed earlier in
this session.

- [ ] **Step 9: Verify `/docs` and `/openapi.json` include the new routes**

```bash
pnpm dev
```

Open `http://localhost:4000/docs` — confirm `POST /v1/chat`,
`GET /v1/conversations`, and `GET /v1/conversations/:id/messages` all appear
with their request/response schemas.

- [ ] **Step 10: Commit**

```bash
git add docs/ examples/
git commit -m "docs: add chat integration guide and runnable streaming example"
```

---

## Sprint 2 exit gate

Mirrors Sprint 1's discipline: every line below must be **observed**, not
assumed.

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` all green
      locally.
- [ ] CI green on push — confirmed with the exact env vars CI uses, not your
      local `.env` (Task 16).
- [ ] **Every Sprint 1 test still passes, unmodified.** `retrieve()` and
      `POST /v1/search` were extended, not replaced.
- [ ] **Reranking eval shows ≥ parity vs. plain hybrid on BOTH domains** —
      `pnpm eval:retrieval` ends in a `PASS` line (Task 18). Not just "did not
      error" — the printed hit-rate/MRR table must actually show
      `hybrid+rerank` at or above `hybrid` for pharmacy AND docs-site.
- [ ] **Conversation history is recorded**: every user and assistant turn
      persists as a `messages` row, verified by reading it back via
      `GET /v1/conversations/:id/messages` after a real chat call.
- [ ] **Token metrics are recorded**: a `chat_metrics` row exists per
      assistant turn with `latency_ms` and (when using the OpenRouter
      provider) `cost_credits` populated — verified with a direct query
      after a real chat call, not just that the code path exists.
- [ ] **Isolation proven by tests, at three layers:**
  - `conversations.service.test.ts` — cross-tenant and cross-external-user
    isolation for `getConversation`/`getConversationByIdForTenant`.
  - `chat.routes.test.ts` — "never returns another tenant's conversations",
    "returns 404 for another tenant's conversation".
  - `search-knowledge.test.ts` — tenantId is never a tool-callable parameter.
- [ ] **The pre-stream/mid-stream error split is real, not just documented**:
  a request with an unknown `conversationId` returns a plain `404` with no
  `text/event-stream` header (verified in `chat.routes.test.ts`); a mid-stream
  failure is observed as an `error` SSE event in a manual test against a
  deliberately-broken `OPENROUTER_API_KEY`.
- [ ] `GET /docs` lists all three new routes; `GET /openapi.json` still
      passes an OpenAPI validator.
- [ ] `docs/quickstart.md` followed **verbatim from a clean database**,
      through the new chat section, ending in a real streamed reply with a
      `sources` citation.
- [ ] `node examples/node/chat.js` runs green against a fresh tenant,
      demonstrating both a new-conversation call and a continued one.

## Deferred, with the sprint that owns them

- **Retention/cleanup** → Sprint 6, alongside rate limits and quotas.
  Conversations and messages accumulate indefinitely until then.
- **Client SDK** → revisit once the streaming contract has proven stable
  under real use.
- **Per-tenant model/provider choice** → not this sprint. The AI SDK's
  provider abstraction is what makes this addable later without a rewrite.
- **Viewing recorded metrics** → Sprint 5's tenant dashboard. `chat_metrics`
  is written, not yet exposed.
- **Custom tools** → Sprint 3. `search_knowledge` is the only tool this
  loop has; tenant-registered HTTPS tools with HMAC-signed requests are
  their own sprint.


