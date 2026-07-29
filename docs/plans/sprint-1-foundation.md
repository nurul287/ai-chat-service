# AI Chat Service — Sprint 1: Foundation, Ingestion & Retrieval

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone multi-tenant service where a tenant can be created, issued an API key, push arbitrary documents over HTTP, and search them with hybrid retrieval — with tenant isolation enforced and tested at every query, on a codebase that already has lint, structured logging, a published API reference, and CI.

**Architecture:** A standalone Fastify + TypeScript service with its own Supabase Postgres (pgvector). Tenants authenticate with a hashed secret API key (`sk_live_…`) over Bearer auth. Documents pushed via REST are split into chunks, embedded with Voyage AI, and stored with both a vector column and a Postgres FTS column. Retrieval fuses a vector leg and a keyword leg via Reciprocal Rank Fusion. The service is domain-agnostic — it stores "documents," not "products," so it serves an e-commerce catalog, a pharmacy inventory, or a docs site identically.

**Tech Stack:** Node 22+, TypeScript (`strict`, `noUncheckedIndexedAccess`), Fastify 5, Drizzle ORM (queries) + raw SQL migrations via Supabase CLI, postgres.js, Supabase Postgres + pgvector, Voyage AI embeddings (`voyage-3`, 1024 dims), Zod via `fastify-type-provider-zod`, Vitest, pino (built into Fastify).

## Provenance

This document supersedes `Aurevo.BE/docs/superpowers/plans/2026-07-29-rag-chat-service-foundation.md`, which was written against **Express 5 + supertest** before the roadmap (`this-is-not-the-greedy-crown.md`) settled on **Fastify 5**.

| Tasks | Status in this document |
|---|---|
| 2, 3, 4, 6, 7, 8, 9, 10 | Carried over **verbatim** — framework-agnostic (schema, crypto, chunking, embeddings, services, SQL). Task 2 has one appended addendum on local Supabase ports. |
| 1, 5, 11, 12 | **Rewritten** for Fastify: dependency set, the auth plugin (`decorateRequest` + scoped `preHandler` replacing Express middleware), routes as a Fastify plugin with `fastify-type-provider-zod`, and a `buildApp()` factory tested through `app.inject()` instead of supertest. |
| 13, 14, 15, 16, 17 | **New.** These existed only as one-line rows in the roadmap table; they are specced task-by-task here for the first time. |

Two defects in the superseded document are fixed here and called out where they occur:

1. **Nothing loaded `.env`.** `src/config/index.ts` validated `process.env` at import time, but no test or script ever populated it, so every test file importing `db` would have died on config validation. Fixed in Task 1 with `import "dotenv/config"`.
2. **`pnpm build` and `pnpm typecheck` could not both be right.** A single `tsconfig.json` that excludes `**/*.test.ts` leaves test files unchecked; one that includes them emits them into `dist/`. Fixed in Task 1 with a `tsconfig.build.json` used only by `build`.

## Global Constraints

- Repo working name is `ai-chat-service`. It is a placeholder — it appears in `package.json`'s `name` and `README.md` only. Rename before public launch; nothing in this plan depends on it.
- Node `>=22`. TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.
- **Every** database read or write that touches tenant-owned data (`documents`, `chunks`) MUST filter by `tenant_id`. No repository function may expose a query without a tenant scope. This is the single most important correctness property in this plan.
- **`tenantId` comes only from the authenticated API key** — never from a request body, query param, or path segment. Every service function takes `tenantId` as its first argument.
- Embedding dimension is **1024** (`voyage-3`). It is baked into the `vector(1024)` column — changing the model later requires a migration and a re-embed.
- API keys are stored as SHA-256 hashes only. The plaintext key is returned exactly once, at creation, and is never logged or re-readable.
- All timestamps are `timestamptz`, read as ISO strings (`mode: 'string'`).
- Tests use a real local Postgres (no mocked data layer), matching Aurevo.BE's convention. External HTTP (Voyage) is mocked.
- **The local Supabase stack uses a dedicated port block: API `55321`, DB `55322`, Studio `55323`, Inbucket `55324`.** Aurevo's local stack already owns `54321`–`54324` on this machine and is routinely running. Sharing the default block would either fail to start or — far worse — silently point this service at Aurevo's database. Both stacks must be able to run simultaneously.
- **The error response shape is a public API contract from day one.** Every failure returns `{ "error": { "code": "...", "message": "..." } }` with a stable, documented `code` (`unauthorized`, `invalid_request`, `not_found`, `internal_error`). Changing a code later is a breaking change for every consumer.
- Conventional commit messages. Commit at the end of every task.

---

### Task 1: Repo scaffold and validated config

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config/index.ts`
- Test: `src/config/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `config` object with typed fields `DATABASE_URL: string`, `VOYAGE_API_KEY: string`, `VOYAGE_EMBEDDING_MODEL: string`, `PORT: number`, `NODE_ENV: "development" | "test" | "production"`, `LOG_LEVEL: string`. Also exports `parseConfig(env: Record<string, string | undefined>)` for testing.

- [ ] **Step 1: Initialise the repo and install dependencies**

```bash
mkdir ai-chat-service && cd ai-chat-service
git init -b main
pnpm init
pnpm add fastify fastify-plugin drizzle-orm postgres zod dotenv
pnpm add -D typescript @types/node vitest tsx drizzle-kit pino-pretty
```

`pino` is **not** installed directly — it ships inside Fastify, which is the point of choosing Fastify. `pino-pretty` is a dev dependency because only the development logger transport uses it.

- [ ] **Step 2: Write `package.json` scripts and metadata**

Replace the generated `package.json`'s metadata and scripts with:

```json
{
  "name": "ai-chat-service",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:start": "pnpm dlx supabase@2.98.2 start",
    "db:reset": "pnpm dlx supabase@2.98.2 db reset",
    "db:status": "pnpm dlx supabase@2.98.2 status"
  }
}
```

Keep the `dependencies` and `devDependencies` blocks that `pnpm add` generated.

- [ ] **Step 3: Write `tsconfig.json`**

This config **includes** test files, so `pnpm typecheck` and the editor both check them.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Write `tsconfig.build.json`**

`pnpm build` uses this one so tests never land in `dist/`.

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 5: Write `vitest.config.ts`**

Test files share one local Postgres, so parallel file execution causes cross-test interference — one file truncating tables while another inserts. Disable it.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    globals: false,
  },
});
```

- [ ] **Step 6: Write `.gitignore` and `.env.example`**

`.gitignore`:

```
node_modules/
dist/
.env
.env.local
supabase/.temp/
supabase/.branches/
*.log
```

`.env.example` — note the non-default Postgres port, per the Global Constraints:

```
# Postgres connection string. Local Supabase on this project's dedicated port
# block (55321-55324) so it can run alongside other local Supabase stacks.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres

# Voyage AI — https://dash.voyageai.com
VOYAGE_API_KEY=
VOYAGE_EMBEDDING_MODEL=voyage-3

PORT=4000
NODE_ENV=development
LOG_LEVEL=info
```

- [ ] **Step 7: Write the failing config test**

Create `src/config/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseConfig } from "./index";

const valid = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
  VOYAGE_API_KEY: "pa-test-key",
  VOYAGE_EMBEDDING_MODEL: "voyage-3",
  PORT: "4000",
  NODE_ENV: "test",
};

describe("parseConfig", () => {
  it("parses a valid environment", () => {
    const config = parseConfig(valid);
    expect(config.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(config.PORT).toBe(4000);
    expect(config.NODE_ENV).toBe("test");
  });

  it("defaults the embedding model, port and log level when absent", () => {
    const { VOYAGE_EMBEDDING_MODEL: _m, PORT: _p, ...rest } = valid;
    const config = parseConfig(rest);
    expect(config.VOYAGE_EMBEDDING_MODEL).toBe("voyage-3");
    expect(config.PORT).toBe(4000);
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("throws a readable error naming the missing variable", () => {
    const { VOYAGE_API_KEY: _k, ...rest } = valid;
    expect(() => parseConfig(rest)).toThrow(/VOYAGE_API_KEY/);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => parseConfig({ ...valid, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `pnpm test src/config/config.test.ts`
Expected: FAIL — `Failed to resolve import "./index"`.

- [ ] **Step 9: Implement the config module**

Create `src/config/index.ts`:

```ts
import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  VOYAGE_API_KEY: z.string().min(1, "VOYAGE_API_KEY is required"),
  VOYAGE_EMBEDDING_MODEL: z.string().default("voyage-3"),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parses and validates an environment. Exported separately from `config` so
 * tests can exercise validation without mutating process.env — and so a
 * missing var fails loudly at boot with the variable's name, never as an
 * undefined-at-runtime surprise.
 *
 * `dotenv/config` is imported for its side effect above: it populates
 * process.env from `.env` for local dev, tests, and CLI scripts. In production
 * (Railway) there is no `.env` file and the platform supplies real env vars,
 * so the import is a harmless no-op.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration — ${issues}`);
  }
  return result.data;
}

export const config = parseConfig(process.env);
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `pnpm test src/config/config.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 11: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json vitest.config.ts .gitignore .env.example src/config/
git commit -m "chore: scaffold repo with validated config"
```

---
### Task 2: Database connection and tenant schema

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/001_tenants_and_api_keys.sql`
- Create: `src/db/schema.ts`
- Create: `src/db/index.ts`
- Test: `src/db/schema.test.ts`

**Interfaces:**
- Consumes: `config.DATABASE_URL` from Task 1.
- Produces: `db` (Drizzle instance), and table objects `tenants`, `apiKeys`. Row types `Tenant = typeof tenants.$inferSelect` and `ApiKey = typeof apiKeys.$inferSelect`.

- [ ] **Step 1: Initialise Supabase locally**

```bash
pnpm dlx supabase@2.98.2 init
pnpm db:start
```

Expected: prints local API/DB URLs. The DB URL should be `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/001_tenants_and_api_keys.sql`:

```sql
create extension if not exists vector;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Secret keys are stored hashed. key_prefix is the first 12 chars of the
-- plaintext, kept so a dashboard can show "sk_live_a1b2…" for identification
-- without ever storing anything that could authenticate a request.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_api_keys_tenant on public.api_keys (tenant_id);
```

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:reset`
Expected: applies `001_tenants_and_api_keys.sql` with no errors.

- [ ] **Step 4: Write the failing schema test**

Create `src/db/schema.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { apiKeys, tenants } from "./schema";

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

describe("tenants and api_keys schema", () => {
  it("inserts a tenant and reads it back", async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ name: "Acme Pharmacy", slug: "acme-pharmacy" })
      .returning();

    expect(tenant!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tenant!.name).toBe("Acme Pharmacy");
  });

  it("cascades api key deletion when its tenant is deleted", async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ name: "Acme", slug: "acme" })
      .returning();
    await db.insert(apiKeys).values({
      tenantId: tenant!.id,
      name: "default",
      keyPrefix: "sk_live_abcd",
      keyHash: "hash-1",
    });

    await db.delete(tenants).where(eq(tenants.id, tenant!.id));

    const remaining = await db.select().from(apiKeys);
    expect(remaining).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test src/db/schema.test.ts`
Expected: FAIL — cannot resolve `./index` or `./schema`.

- [ ] **Step 6: Write the Drizzle schema**

Create `src/db/schema.ts`:

```ts
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text().notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (table) => [index("idx_api_keys_tenant").on(table.tenantId)],
);

export type Tenant = typeof tenants.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
```

- [ ] **Step 7: Write the DB connection module**

Create `src/db/index.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config";
import * as schema from "./schema";

const client = postgres(config.DATABASE_URL);

export const db = drizzle(client, { schema });
export { client };
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm test src/db/schema.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 9: Commit**

```bash
git add supabase/ src/db/
git commit -m "feat(db): add tenants and api_keys schema"
```

> **Sprint-1 addendum — local Supabase port block.** Step 1 above runs `supabase init`, which writes `supabase/config.toml` using the default `543xx` ports. Before the first `pnpm db:start`, shift the whole block so this project owns its own ports — otherwise it collides with, or far worse *silently attaches to*, another local Supabase stack on the same machine (Aurevo's is routinely running and owns `54321`–`54324` plus `54329`).
>
> Set `project_id` and shift **every** `port` key the generated file contains from `543xx` to `553xx`:
>
> ```toml
> project_id = "ai-chat-service"
>
> [api]
> port = 55321
>
> [db]
> port = 55322
> shadow_port = 55320
>
> [db.pooler]
> port = 55329
>
> [studio]
> port = 55323
>
> [inbucket]
> port = 55324
>
> [analytics]
> port = 55327
> ```
>
> `DATABASE_URL` is then `postgresql://postgres:postgres@127.0.0.1:55322/postgres`, matching `.env.example` from Task 1. **Before running any test, confirm with `pnpm db:status` that the reported DB URL is on port 55322** — a test suite that truncates tables against the wrong database is the one mistake here that is not recoverable.

---
### Task 3: API key generation and hashing

**Files:**
- Create: `src/auth/api-key.ts`
- Test: `src/auth/api-key.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, Node `crypto` only).
- Produces: `generateApiKey(): { plaintext: string; prefix: string; hash: string }` and `hashApiKey(plaintext: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/auth/api-key.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "./api-key";

describe("generateApiKey", () => {
  it("produces a prefixed plaintext key", () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith("sk_live_")).toBe(true);
    expect(plaintext.length).toBeGreaterThan(40);
  });

  it("returns a prefix that is the leading 12 chars of the plaintext", () => {
    const { plaintext, prefix } = generateApiKey();
    expect(prefix).toBe(plaintext.slice(0, 12));
  });

  it("returns a hash matching hashApiKey of the plaintext", () => {
    const { plaintext, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(plaintext));
  });

  it("never repeats a key", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().plaintext));
    expect(keys.size).toBe(200);
  });
});

describe("hashApiKey", () => {
  it("is deterministic", () => {
    expect(hashApiKey("sk_live_abc")).toBe(hashApiKey("sk_live_abc"));
  });

  it("differs for different inputs", () => {
    expect(hashApiKey("sk_live_abc")).not.toBe(hashApiKey("sk_live_abd"));
  });

  it("returns a 64-char hex digest", () => {
    expect(hashApiKey("sk_live_abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/auth/api-key.test.ts`
Expected: FAIL — cannot resolve `./api-key`.

- [ ] **Step 3: Implement the module**

Create `src/auth/api-key.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "sk_live_";
const PREFIX_LENGTH = 12;

/**
 * SHA-256 rather than a slow KDF (bcrypt/argon2) on purpose: an API key is a
 * 256-bit random value, not a human-chosen password, so it has no meaningful
 * dictionary/brute-force surface — and this runs on every authenticated
 * request, where a deliberately slow hash would be a latency tax on the hot
 * path.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX_LENGTH),
    hash: hashApiKey(plaintext),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/auth/api-key.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/auth/api-key.ts src/auth/api-key.test.ts
git commit -m "feat(auth): add API key generation and hashing"
```

---

### Task 4: Tenant service and API key verification

**Files:**
- Create: `src/tenants/tenants.service.ts`
- Test: `src/tenants/tenants.service.test.ts`

**Interfaces:**
- Consumes: `db`, `tenants`, `apiKeys`, `Tenant` from Task 2; `generateApiKey`, `hashApiKey` from Task 3.
- Produces:
  - `createTenant(input: { name: string; slug: string }): Promise<Tenant>`
  - `issueApiKey(tenantId: string, name: string): Promise<{ plaintext: string; prefix: string }>`
  - `verifyApiKey(plaintext: string): Promise<Tenant | null>`
  - `revokeApiKey(keyId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/tenants/tenants.service.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant, issueApiKey, revokeApiKey, verifyApiKey } from "./tenants.service";

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

describe("createTenant", () => {
  it("creates a tenant", async () => {
    const tenant = await createTenant({ name: "Acme Pharmacy", slug: "acme-pharmacy" });
    expect(tenant.name).toBe("Acme Pharmacy");
    expect(tenant.slug).toBe("acme-pharmacy");
  });

  it("rejects a duplicate slug", async () => {
    await createTenant({ name: "Acme", slug: "acme" });
    await expect(createTenant({ name: "Acme Two", slug: "acme" })).rejects.toThrow();
  });
});

describe("issueApiKey / verifyApiKey", () => {
  it("issues a key that verifies back to its tenant", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    const resolved = await verifyApiKey(plaintext);
    expect(resolved?.id).toBe(tenant.id);
  });

  it("stores only the hash, never the plaintext", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenant.id));
    expect(row!.keyHash).not.toBe(plaintext);
    expect(JSON.stringify(row)).not.toContain(plaintext.slice(12));
  });

  it("returns null for an unknown key", async () => {
    expect(await verifyApiKey("sk_live_not-a-real-key")).toBeNull();
  });

  it("returns null for a revoked key", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenant.id));

    await revokeApiKey(row!.id);

    expect(await verifyApiKey(plaintext)).toBeNull();
  });

  it("records last_used_at on successful verification", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    await verifyApiKey(plaintext);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenant.id));
    expect(row!.lastUsedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/tenants/tenants.service.test.ts`
Expected: FAIL — cannot resolve `./tenants.service`.

- [ ] **Step 3: Implement the service**

Create `src/tenants/tenants.service.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, tenants, type Tenant } from "../db/schema";
import { generateApiKey, hashApiKey } from "../auth/api-key";

export async function createTenant(input: { name: string; slug: string }): Promise<Tenant> {
  const [tenant] = await db.insert(tenants).values(input).returning();
  return tenant!;
}

/**
 * Returns the plaintext key exactly once — it is not stored and cannot be
 * recovered afterwards. The caller is responsible for showing it to the user
 * immediately; a lost key must be revoked and reissued.
 */
export async function issueApiKey(
  tenantId: string,
  name: string,
): Promise<{ plaintext: string; prefix: string }> {
  const { plaintext, prefix, hash } = generateApiKey();
  await db.insert(apiKeys).values({ tenantId, name, keyPrefix: prefix, keyHash: hash });
  return { plaintext, prefix };
}

export async function verifyApiKey(plaintext: string): Promise<Tenant | null> {
  const hash = hashApiKey(plaintext);

  const [row] = await db
    .select({ id: apiKeys.id, tenantId: apiKeys.tenantId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)));

  if (!row) return null;

  // Fire-and-forget: last_used_at is telemetry, and must never add latency to
  // or fail an authenticated request.
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => {});

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId));
  return tenant ?? null;
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, keyId));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/tenants/tenants.service.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tenants/
git commit -m "feat(tenants): add tenant service with API key issuance and verification"
```

---

### Task 5: Fastify auth plugin (tenant resolution on the `/v1` scope)

> **Rewritten for Fastify.** The superseded plan implemented this as Express middleware (`src/auth/authenticate.ts`) tested with hand-rolled mock `req`/`res` objects. Fastify's encapsulation model gives a stronger guarantee — the hook is attached to a *scope*, so every route registered in that scope is authenticated whether or not its author remembered to opt in.

**Files:**
- Create: `src/plugins/auth.ts`
- Test: `src/plugins/auth.test.ts`

**Interfaces:**
- Consumes: `verifyApiKey` from Task 4; `Tenant` from Task 2.
- Produces: a default-exported Fastify plugin that decorates `request.tenant` and registers a `preHandler` hook, rejecting unauthenticated requests with `401`.

**Why `fastify-plugin` (`fp`) is required here — and why it does not make auth global.**

This is the one piece of Fastify semantics that is easy to get backwards, so it is worth stating explicitly:

- **Without `fp`**, `register(authPlugin)` creates a *new child context*. The `preHandler` hook would apply only to routes registered *inside `authPlugin` itself* — of which there are none. The hook would silently never run, and every `/v1` route would be wide open. This failure is invisible: the app boots, the tests for other tasks pass, and only an explicit "rejects an unauthenticated request" test catches it.
- **With `fp`**, the plugin does not create a context; its hook and decorator attach to the *enclosing* scope. Because `app.ts` (Task 12) registers it inside an anonymous `/v1` wrapper plugin, the enclosing scope is `/v1` — so the hook covers every `/v1` route and nothing else.

The encapsulation boundary that keeps `GET /health` and `GET /docs` public therefore comes from the `/v1` wrapper in `app.ts`, **not** from this plugin. The final test in this task asserts exactly that, so a later refactor that hoists the registration to the root instance fails loudly instead of quietly locking down the health check.

- [ ] **Step 1: Write the failing test**

Create `src/plugins/auth.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant, issueApiKey } from "../tenants/tenants.service";
import authPlugin from "./auth";

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();

  // Deliberately registered on the ROOT instance, outside the /v1 scope.
  app.get("/health", async () => ({ status: "ok" }));

  await app.register(
    async (v1) => {
      await v1.register(authPlugin);
      v1.get("/whoami", async (request) => ({ tenantId: request.tenant!.id }));
    },
    { prefix: "/v1" },
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

beforeEach(clean);

describe("auth plugin", () => {
  it("resolves a valid key to its tenant", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${plaintext}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tenantId).toBe(tenant.id);
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/whoami" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: "sk_live_no-bearer-prefix" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: "Bearer sk_live_nope" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked key", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");
    const [row] = await db.select().from(apiKeys);
    await db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, row!.id));

    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${plaintext}` },
    });

    expect(res.statusCode).toBe(401);
  });

  // The scoping guarantee: the preHandler must not leak outside /v1.
  it("leaves routes outside the /v1 scope unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});
```

Add `import { eq } from "drizzle-orm";` to the imports — the revoked-key test needs it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/plugins/auth.test.ts`
Expected: FAIL — cannot resolve `./auth`.

- [ ] **Step 3: Implement the plugin**

Create `src/plugins/auth.ts`:

```ts
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import type { Tenant } from "../db/schema";
import { verifyApiKey } from "../tenants/tenants.service";

declare module "fastify" {
  interface FastifyRequest {
    tenant: Tenant | null;
  }
}

/**
 * Resolves a Bearer API key to its tenant and pins it on the request. Every
 * downstream handler reads `request.tenant.id` for its tenant scope — no
 * handler may ever take a tenant id from a request body, query param, or path
 * segment, which would let one tenant address another's data.
 *
 * Wrapped in `fp` so the hook attaches to the ENCLOSING scope rather than to
 * this plugin's own (empty) child context — see the task notes. `app.ts`
 * registers it inside the `/v1` wrapper, which is what keeps `/health` and
 * `/docs` public.
 */
const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("tenant", null);

  fastify.addHook("preHandler", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Missing Bearer API key" } });
    }

    const tenant = await verifyApiKey(header.slice("Bearer ".length).trim());
    if (!tenant) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Invalid or revoked API key" } });
    }

    request.tenant = tenant;
  });
};

export default fp(authPlugin, { name: "auth" });
```

Two Fastify details worth not relearning the hard way:

- `decorateRequest` is given `null`, not an object. Fastify 5 rejects reference-type defaults on request decorators (they would be shared across requests); a primitive or `null` placeholder plus per-request assignment is the supported pattern.
- The hook `return`s the `reply.send(...)` call. Returning the reply is how an async Fastify hook short-circuits the lifecycle — without the `return`, the handler still runs after the 401 is sent.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/plugins/auth.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/auth.ts src/plugins/auth.test.ts
git commit -m "feat(auth): add Fastify auth plugin scoped to /v1"
```

---
### Task 6: Documents and chunks schema

**Files:**
- Create: `supabase/migrations/002_documents_and_chunks.sql`
- Modify: `src/db/schema.ts`
- Test: `src/db/documents-schema.test.ts`

**Interfaces:**
- Consumes: `tenants` from Task 2.
- Produces: table objects `documents`, `chunks`; row types `Document = typeof documents.$inferSelect`, `Chunk = typeof chunks.$inferSelect`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/002_documents_and_chunks.sql`:

```sql
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  external_id text not null,
  title text,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create index idx_documents_tenant on public.documents (tenant_id);

create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(1024) not null,
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now()
);

create index idx_chunks_tenant on public.chunks (tenant_id);
create index idx_chunks_document on public.chunks (document_id);
create index idx_chunks_fts on public.chunks using gin (fts);
create index idx_chunks_embedding on public.chunks using hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 2: Apply the migration**

Run: `pnpm db:reset`
Expected: applies both migrations with no errors.

- [ ] **Step 3: Write the failing test**

Create `src/db/documents-schema.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { chunks, documents, tenants } from "./schema";

async function clean() {
  await db.delete(chunks);
  await db.delete(documents);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

const embedding = Array.from({ length: 1024 }, () => 0.01);

describe("documents and chunks schema", () => {
  it("enforces unique (tenant_id, external_id)", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    await db.insert(documents).values({
      tenantId: tenant!.id,
      externalId: "sku-1",
      content: "first",
    });

    await expect(
      db.insert(documents).values({ tenantId: tenant!.id, externalId: "sku-1", content: "second" }),
    ).rejects.toThrow();
  });

  it("allows the same external_id across different tenants", async () => {
    const [a] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [b] = await db.insert(tenants).values({ name: "B", slug: "b" }).returning();

    await db.insert(documents).values({ tenantId: a!.id, externalId: "sku-1", content: "x" });
    await db.insert(documents).values({ tenantId: b!.id, externalId: "sku-1", content: "y" });

    const rows = await db.select().from(documents);
    expect(rows).toHaveLength(2);
  });

  it("cascades chunk deletion when its document is deleted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [doc] = await db
      .insert(documents)
      .values({ tenantId: tenant!.id, externalId: "sku-1", content: "x" })
      .returning();
    await db.insert(chunks).values({
      tenantId: tenant!.id,
      documentId: doc!.id,
      chunkIndex: 0,
      content: "x",
      embedding,
    });

    await db.delete(documents).where(eq(documents.id, doc!.id));

    expect(await db.select().from(chunks)).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test src/db/documents-schema.test.ts`
Expected: FAIL — `documents` is not exported from `./schema`.

- [ ] **Step 5: Add the tables to the Drizzle schema**

Append to `src/db/schema.ts`:

```ts
import { integer, jsonb, unique, vector } from "drizzle-orm/pg-core";

export const documents = pgTable(
  "documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    title: text(),
    content: text().notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_documents_tenant").on(table.tenantId),
    unique("documents_tenant_id_external_id_key").on(table.tenantId, table.externalId),
  ],
);

// `fts` is a generated tsvector column (migration 002) and is deliberately not
// mapped here — Drizzle has no generated-column type for it, and it is only
// ever read through raw SQL in the keyword search leg.
export const chunks = pgTable(
  "chunks",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text().notNull(),
    embedding: vector({ dimensions: 1024 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_chunks_tenant").on(table.tenantId),
    index("idx_chunks_document").on(table.documentId),
  ],
);

export type Document = typeof documents.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
```

Merge the new imports into the existing `drizzle-orm/pg-core` import line rather than adding a second one.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test src/db/documents-schema.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/002_documents_and_chunks.sql src/db/
git commit -m "feat(db): add documents and chunks schema with pgvector and FTS"
```

---

### Task 7: Text chunking

**Files:**
- Create: `src/ingestion/chunk-text.ts`
- Test: `src/ingestion/chunk-text.test.ts`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `chunkText(text: string, opts?: { maxChars?: number; overlapChars?: number }): string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/ingestion/chunk-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk-text";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("Paracetamol 500mg tablet.")).toEqual(["Paracetamol 500mg tablet."]);
  });

  it("returns an empty array for blank input", () => {
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("splits on paragraph boundaries when possible", () => {
    const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}`;
    const result = chunkText(text, { maxChars: 400, overlapChars: 0 });
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("a".repeat(300));
    expect(result[1]).toBe("b".repeat(300));
  });

  it("hard-splits a single paragraph longer than maxChars", () => {
    const result = chunkText("c".repeat(1000), { maxChars: 400, overlapChars: 0 });
    expect(result.length).toBeGreaterThan(1);
    expect(result.every((c) => c.length <= 400)).toBe(true);
    expect(result.join("")).toBe("c".repeat(1000));
  });

  it("overlaps consecutive chunks by overlapChars", () => {
    const result = chunkText("d".repeat(1000), { maxChars: 400, overlapChars: 50 });
    expect(result[1]!.startsWith("d".repeat(50))).toBe(true);
  });

  it("never emits an empty or whitespace-only chunk", () => {
    const result = chunkText("x\n\n\n\n\ny", { maxChars: 400 });
    expect(result.every((c) => c.trim().length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/ingestion/chunk-text.test.ts`
Expected: FAIL — cannot resolve `./chunk-text`.

- [ ] **Step 3: Implement chunking**

Create `src/ingestion/chunk-text.ts`:

```ts
const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 120;

/**
 * Splits text for embedding. Paragraph-first so a chunk rarely cuts mid-idea;
 * only a single paragraph that exceeds maxChars on its own is hard-split, with
 * a small overlap carried across the boundary so a fact spanning the cut is
 * still retrievable from at least one chunk.
 *
 * Character-based rather than token-based deliberately: it needs no tokenizer
 * dependency, and at these sizes the approximation is well inside the
 * embedding model's context window.
 */
export function chunkText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      const step = Math.max(1, maxChars - overlapChars);
      for (let start = 0; start < paragraph.length; start += step) {
        const slice = paragraph.slice(start, start + maxChars);
        if (slice.trim().length > 0) chunks.push(slice);
        if (start + maxChars >= paragraph.length) break;
      }
      continue;
    }

    if (current.length + paragraph.length + 2 > maxChars) flush();
    current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
  }

  flush();
  return chunks;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/ingestion/chunk-text.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/chunk-text.ts src/ingestion/chunk-text.test.ts
git commit -m "feat(ingestion): add paragraph-aware text chunking"
```

---

### Task 8: Voyage embeddings client

**Files:**
- Create: `src/lib/voyage.ts`
- Test: `src/lib/voyage.test.ts`

**Interfaces:**
- Consumes: `config.VOYAGE_API_KEY`, `config.VOYAGE_EMBEDDING_MODEL` from Task 1.
- Produces: `embedDocuments(texts: string[]): Promise<number[][]>` and `embedQuery(text: string): Promise<number[]>`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/voyage.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { embedDocuments, embedQuery } from "./voyage";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("embedDocuments", () => {
  it("returns embeddings ordered by the API's index field", async () => {
    stubFetch({
      data: [
        { embedding: [0.2], index: 1 },
        { embedding: [0.1], index: 0 },
      ],
    });

    expect(await embedDocuments(["a", "b"])).toEqual([[0.1], [0.2]]);
  });

  it("sends input_type=document", async () => {
    const fetchMock = stubFetch({ data: [{ embedding: [0.1], index: 0 }] });
    await embedDocuments(["a"]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.input_type).toBe("document");
  });

  it("returns an empty array without calling the API for empty input", async () => {
    const fetchMock = stubFetch({ data: [] });
    expect(await embedDocuments([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with the status code when the API fails", async () => {
    stubFetch({ error: "bad" }, 500);
    await expect(embedDocuments(["a"])).rejects.toThrow(/500/);
  });
});

describe("embedQuery", () => {
  it("sends input_type=query and returns one vector", async () => {
    const fetchMock = stubFetch({ data: [{ embedding: [0.5], index: 0 }] });

    expect(await embedQuery("paracetamol")).toEqual([0.5]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.input_type).toBe("query");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/voyage.test.ts`
Expected: FAIL — cannot resolve `./voyage`.

- [ ] **Step 3: Implement the client**

Create `src/lib/voyage.ts`:

```ts
import { config } from "../config";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

type VoyageEmbeddingsResponse = { data: { embedding: number[]; index: number }[] };

async function embed(input: string[], inputType: "query" | "document"): Promise<number[][]> {
  if (input.length === 0) return [];

  const res = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input,
      model: config.VOYAGE_EMBEDDING_MODEL,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as VoyageEmbeddingsResponse;
  // The API does not guarantee response order matches input order — sort by
  // the index it returns so embeddings line up with their source texts.
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return embed(texts, "document");
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embed([text], "query");
  if (!embedding) throw new Error("Voyage returned no embedding for the query");
  return embedding;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/voyage.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/voyage.ts src/lib/voyage.test.ts
git commit -m "feat(lib): add Voyage embeddings client"
```

---

### Task 9: Document ingestion service

**Files:**
- Create: `src/documents/documents.service.ts`
- Test: `src/documents/documents.service.test.ts`

**Interfaces:**
- Consumes: `db`, `documents`, `chunks`, `Document` from Tasks 2/6; `chunkText` from Task 7; `embedDocuments` from Task 8.
- Produces:
  - `upsertDocument(tenantId: string, input: { externalId: string; title?: string; content: string; metadata?: Record<string, unknown> }): Promise<Document>`
  - `deleteDocument(tenantId: string, externalId: string): Promise<boolean>`
  - `listDocuments(tenantId: string, page: number, limit: number): Promise<{ data: Document[]; total: number }>`

- [ ] **Step 1: Write the failing test**

Create `src/documents/documents.service.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chunks, documents, tenants } from "../db/schema";
import { deleteDocument, listDocuments, upsertDocument } from "./documents.service";

vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  ),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
}));

async function clean() {
  await db.delete(chunks);
  await db.delete(documents);
  await db.delete(tenants);
}

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(tenants).values({ name: slug, slug }).returning();
  return tenant!;
}

beforeEach(clean);
afterAll(clean);

describe("upsertDocument", () => {
  it("creates a document and its chunks", async () => {
    const tenant = await makeTenant("acme");
    const doc = await upsertDocument(tenant.id, {
      externalId: "sku-1",
      title: "Paracetamol",
      content: "Paracetamol 500mg. Used for fever and mild pain.",
    });

    expect(doc.externalId).toBe("sku-1");
    const rows = await db.select().from(chunks).where(eq(chunks.documentId, doc.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.tenantId).toBe(tenant.id);
  });

  it("replaces chunks on re-upsert rather than duplicating them", async () => {
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "first version" });
    const doc = await upsertDocument(tenant.id, { externalId: "sku-1", content: "second version" });

    const rows = await db.select().from(chunks).where(eq(chunks.documentId, doc.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("second version");

    const allDocs = await db.select().from(documents);
    expect(allDocs).toHaveLength(1);
  });

  it("keeps two tenants' same-externalId documents separate", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");

    await upsertDocument(a.id, { externalId: "sku-1", content: "tenant a content" });
    await upsertDocument(b.id, { externalId: "sku-1", content: "tenant b content" });

    const aChunks = await db.select().from(chunks).where(eq(chunks.tenantId, a.id));
    const bChunks = await db.select().from(chunks).where(eq(chunks.tenantId, b.id));
    expect(aChunks[0]!.content).toBe("tenant a content");
    expect(bChunks[0]!.content).toBe("tenant b content");
  });
});

describe("deleteDocument", () => {
  it("deletes the document and returns true", async () => {
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "x" });

    expect(await deleteDocument(tenant.id, "sku-1")).toBe(true);
    expect(await db.select().from(documents)).toHaveLength(0);
    expect(await db.select().from(chunks)).toHaveLength(0);
  });

  it("returns false for an unknown externalId", async () => {
    const tenant = await makeTenant("acme");
    expect(await deleteDocument(tenant.id, "nope")).toBe(false);
  });

  it("refuses to delete another tenant's document", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    await upsertDocument(a.id, { externalId: "sku-1", content: "a content" });

    expect(await deleteDocument(b.id, "sku-1")).toBe(false);
    expect(await db.select().from(documents)).toHaveLength(1);
  });
});

describe("listDocuments", () => {
  it("returns only the calling tenant's documents", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    await upsertDocument(a.id, { externalId: "a-1", content: "x" });
    await upsertDocument(b.id, { externalId: "b-1", content: "y" });

    const result = await listDocuments(a.id, 1, 10);
    expect(result.total).toBe(1);
    expect(result.data[0]!.externalId).toBe("a-1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/documents/documents.service.test.ts`
Expected: FAIL — cannot resolve `./documents.service`.

- [ ] **Step 3: Implement the service**

Create `src/documents/documents.service.ts`:

```ts
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { chunks, documents, type Document } from "../db/schema";
import { chunkText } from "../ingestion/chunk-text";
import { embedDocuments } from "../lib/voyage";

export type UpsertDocumentInput = {
  externalId: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
};

/**
 * Creates or replaces a document and its chunks, keyed by (tenantId,
 * externalId) so a host application can re-push the same record repeatedly
 * without duplicating it. Chunks are fully replaced rather than diffed:
 * content edits shift every downstream offset anyway, so a replace is both
 * simpler and strictly correct.
 */
export async function upsertDocument(
  tenantId: string,
  input: UpsertDocumentInput,
): Promise<Document> {
  const pieces = chunkText(input.content);
  const embeddings = await embedDocuments(pieces);

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId,
        externalId: input.externalId,
        title: input.title ?? null,
        content: input.content,
        metadata: input.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [documents.tenantId, documents.externalId],
        set: {
          title: input.title ?? null,
          content: input.content,
          metadata: input.metadata ?? {},
          updatedAt: new Date().toISOString(),
        },
      })
      .returning();

    await tx.delete(chunks).where(eq(chunks.documentId, doc!.id));

    if (pieces.length > 0) {
      await tx.insert(chunks).values(
        pieces.map((content, index) => ({
          tenantId,
          documentId: doc!.id,
          chunkIndex: index,
          content,
          embedding: embeddings[index]!,
        })),
      );
    }

    return doc!;
  });
}

export async function deleteDocument(tenantId: string, externalId: string): Promise<boolean> {
  const deleted = await db
    .delete(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.externalId, externalId)))
    .returning({ id: documents.id });
  return deleted.length > 0;
}

export async function listDocuments(
  tenantId: string,
  page: number,
  limit: number,
): Promise<{ data: Document[]; total: number }> {
  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(documents)
      .where(eq(documents.tenantId, tenantId))
      .orderBy(desc(documents.updatedAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: count() }).from(documents).where(eq(documents.tenantId, tenantId)),
  ]);

  return { data: rows, total: Number(totals!.total) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/documents/documents.service.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/documents/
git commit -m "feat(documents): add tenant-scoped document ingestion"
```

---

### Task 10: Tenant-scoped hybrid retrieval

**Files:**
- Create: `src/retrieval/retrieve.ts`
- Test: `src/retrieval/retrieve.test.ts`

**Interfaces:**
- Consumes: `db`, `chunks`, `documents` from Tasks 2/6; `embedQuery` from Task 8.
- Produces:
  - `rrfFuse<T extends { id: string }>(lists: T[][], k?: number): T[]`
  - `retrieve(tenantId: string, query: string, topK?: number): Promise<RetrievedChunk[]>`
  - `type RetrievedChunk = { documentId: string; externalId: string; title: string | null; content: string; metadata: unknown }`

- [ ] **Step 1: Write the failing test**

Create `src/retrieval/retrieve.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { chunks, documents, tenants } from "../db/schema";
import { upsertDocument } from "../documents/documents.service";
import { retrieve, rrfFuse } from "./retrieve";

// Deterministic stand-in embeddings: the vector leg is exercised end to end
// (the query runs against a real pgvector index) but ranking is driven by the
// keyword leg, so the assertions do not depend on a live embedding model.
vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  ),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
}));

async function clean() {
  await db.delete(chunks);
  await db.delete(documents);
  await db.delete(tenants);
}

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(tenants).values({ name: slug, slug }).returning();
  return tenant!;
}

beforeEach(clean);
afterAll(clean);

describe("rrfFuse", () => {
  it("ranks an item appearing in both lists above one appearing in neither's top", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    const fused = rrfFuse([
      [b, a],
      [c, a],
    ]);
    expect(fused[0]!.id).toBe("a");
  });

  it("preserves first-list order on a tie", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    expect(rrfFuse([[a, b]]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("returns an empty array for no lists", () => {
    expect(rrfFuse([])).toEqual([]);
  });
});

describe("retrieve", () => {
  it("finds a chunk by keyword", async () => {
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, {
      externalId: "sku-1",
      title: "Paracetamol",
      content: "Paracetamol 500mg tablets relieve fever and headache.",
    });
    await upsertDocument(tenant.id, {
      externalId: "sku-2",
      title: "Bandage",
      content: "Sterile adhesive bandage for minor cuts.",
    });

    const results = await retrieve(tenant.id, "paracetamol fever", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.externalId).toBe("sku-1");
  });

  it("never returns another tenant's chunks", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    await upsertDocument(a.id, {
      externalId: "secret",
      content: "Tenant A confidential formulary notes.",
    });

    const results = await retrieve(b.id, "confidential formulary", 5);
    expect(results).toHaveLength(0);
  });

  it("respects topK", async () => {
    const tenant = await makeTenant("acme");
    for (let i = 0; i < 5; i++) {
      await upsertDocument(tenant.id, {
        externalId: `sku-${i}`,
        content: `Vitamin supplement number ${i} for daily wellness.`,
      });
    }

    const results = await retrieve(tenant.id, "vitamin supplement", 2);
    expect(results).toHaveLength(2);
  });

  it("returns an empty array when the tenant has no documents", async () => {
    const tenant = await makeTenant("empty");
    expect(await retrieve(tenant.id, "anything", 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/retrieval/retrieve.test.ts`
Expected: FAIL — cannot resolve `./retrieve`.

- [ ] **Step 3: Implement retrieval**

Create `src/retrieval/retrieve.ts`:

```ts
import { and, cosineDistance, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { chunks, documents } from "../db/schema";
import { embedQuery } from "../lib/voyage";

export type RetrievedChunk = {
  documentId: string;
  externalId: string;
  title: string | null;
  content: string;
  metadata: unknown;
};

type Candidate = RetrievedChunk & { id: string };

/** Candidates pulled per leg before fusion trims to topK — wider than topK so a
 *  result ranked poorly by one leg can still win on the strength of the other. */
const CANDIDATE_POOL = 12;

const candidateColumns = {
  id: chunks.id,
  documentId: chunks.documentId,
  externalId: documents.externalId,
  title: documents.title,
  content: chunks.content,
  metadata: documents.metadata,
};

async function vectorSearch(tenantId: string, embedding: number[], limit: number): Promise<Candidate[]> {
  return db
    .select(candidateColumns)
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(eq(chunks.tenantId, tenantId))
    .orderBy(cosineDistance(chunks.embedding, embedding))
    .limit(limit);
}

/**
 * Keyword leg over the generated `fts` column. `websearch_to_tsquery` never
 * throws on arbitrary user text, which matters because the query string comes
 * straight from an end user. Its terms are ANDed, so a query containing any
 * non-matching word returns nothing — acceptable, since an empty keyword leg
 * just leaves fusion with the vector ordering.
 */
async function keywordSearch(tenantId: string, query: string, limit: number): Promise<Candidate[]> {
  const tsquery = sql`websearch_to_tsquery('english', ${query})`;
  return db
    .select(candidateColumns)
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(and(eq(chunks.tenantId, tenantId), sql`${sql.raw('"chunks"."fts"')} @@ ${tsquery}`))
    .orderBy(sql`ts_rank(${sql.raw('"chunks"."fts"')}, ${tsquery}) desc`)
    .limit(limit);
}

/**
 * Reciprocal Rank Fusion: score(id) = Σ over lists of 1/(k + rank). Ties break
 * by first-seen order, keeping results stable when one leg is empty or both
 * legs fully agree.
 */
export function rrfFuse<T extends { id: string }>(lists: T[][], k = 60): T[] {
  const scores = new Map<string, { item: T; score: number; firstSeen: number }>();
  let seenCounter = 0;

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]!;
      const existing = scores.get(item.id);
      const increment = 1 / (k + rank + 1);
      if (existing) {
        existing.score += increment;
      } else {
        scores.set(item.id, { item, score: increment, firstSeen: seenCounter++ });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen)
    .map((entry) => entry.item);
}

export async function retrieve(
  tenantId: string,
  query: string,
  topK = 5,
): Promise<RetrievedChunk[]> {
  const embedding = await embedQuery(query);

  const [vectorHits, keywordHits] = await Promise.all([
    vectorSearch(tenantId, embedding, CANDIDATE_POOL),
    keywordSearch(tenantId, query, CANDIDATE_POOL),
  ]);

  return rrfFuse([vectorHits, keywordHits])
    .slice(0, topK)
    .map(({ id: _id, ...chunk }) => chunk);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/retrieval/retrieve.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/
git commit -m "feat(retrieval): add tenant-scoped hybrid search with RRF"
```

---

### Task 11: HTTP API for documents and search

> **Rewritten for Fastify.** The superseded plan used an Express `Router`, hand-rolled `safeParse` calls in each controller, and supertest against a real socket. Here one Zod schema per route drives request validation, handler types, **and** the OpenAPI spec published in Task 16 — so the three cannot drift apart — and tests run through `app.inject()` with no socket at all.

**Files:**
- Create: `src/documents/documents.schema.ts`
- Create: `src/documents/documents.routes.ts`
- Create: `src/app.ts`
- Test: `src/documents/documents.routes.test.ts`

**Interfaces:**
- Consumes: `authPlugin` (Task 5); `upsertDocument`, `deleteDocument`, `listDocuments` (Task 9); `retrieve` (Task 10).
- Produces: `buildApp(): FastifyInstance` exported from `src/app.ts`, serving `PUT /v1/documents`, `GET /v1/documents`, `DELETE /v1/documents/:externalId`, `POST /v1/search`, `GET /health`.

**Why `buildApp()` is a factory, not a singleton.** A module-level `export const app = Fastify()` would bind one instance to the module cache, so tests could not build an isolated app and `listen()` would be one import away from the test path. A factory keeps `inject()` clean and keeps `listen()` entirely in `server.ts` (Task 12).

- [ ] **Step 1: Install the type provider and its peers**

```bash
pnpm add fastify-type-provider-zod @fastify/swagger openapi-types
```

`@fastify/swagger` and `openapi-types` are **peer dependencies of `fastify-type-provider-zod@7`**, so they are installed here even though the spec is not wired up until Task 16. `zod` must be `>=4.1.5` — the schemas below use Zod 4 syntax (two-argument `z.record`).

- [ ] **Step 2: Write the failing route test**

Create `src/documents/documents.routes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, chunks, documents, tenants } from "../db/schema";
import { createTenant, issueApiKey } from "../tenants/tenants.service";
import { buildApp } from "../app";

vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  ),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
}));

async function clean() {
  await db.delete(chunks);
  await db.delete(documents);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

async function tenantWithKey(slug: string) {
  const tenant = await createTenant({ name: slug, slug });
  const { plaintext } = await issueApiKey(tenant.id, "test");
  return { tenant, key: plaintext };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

beforeEach(clean);

function put(key: string, body: unknown) {
  return app.inject({
    method: "PUT",
    url: "/v1/documents",
    headers: { authorization: `Bearer ${key}` },
    payload: body,
  });
}

describe("PUT /v1/documents", () => {
  it("creates a document", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await put(key, {
      externalId: "sku-1",
      title: "Paracetamol",
      content: "Relieves fever.",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.externalId).toBe("sku-1");
  });

  it("does not leak tenantId in the response body", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await put(key, { externalId: "sku-1", content: "x" });

    expect(res.json().data).not.toHaveProperty("tenantId");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/documents",
      payload: { externalId: "sku-1", content: "x" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects a body missing content", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await put(key, { externalId: "sku-1" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });
});

describe("GET /v1/documents", () => {
  it("lists only the calling tenant's documents", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await put(a.key, { externalId: "a-1", content: "alpha" });
    await put(b.key, { externalId: "b-1", content: "beta" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/documents",
      headers: { authorization: `Bearer ${a.key}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].externalId).toBe("a-1");
    expect(res.json().meta.total).toBe(1);
  });
});

describe("DELETE /v1/documents/:externalId", () => {
  it("deletes the tenant's own document", async () => {
    const { key } = await tenantWithKey("acme");
    await put(key, { externalId: "sku-1", content: "x" });

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/documents/sku-1",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(200);
    expect(await db.select().from(documents)).toHaveLength(0);
  });

  it("returns 404 for another tenant's document", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await put(a.key, { externalId: "sku-1", content: "x" });

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/documents/sku-1",
      headers: { authorization: `Bearer ${b.key}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(await db.select().from(documents)).toHaveLength(1);
  });
});

describe("POST /v1/search", () => {
  it("returns matching chunks for the calling tenant", async () => {
    const { key } = await tenantWithKey("acme");
    await put(key, {
      externalId: "sku-1",
      title: "Paracetamol",
      content: "Paracetamol relieves fever.",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: { authorization: `Bearer ${key}` },
      payload: { query: "paracetamol fever" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThan(0);
    expect(res.json().data[0].externalId).toBe("sku-1");
  });

  it("never returns another tenant's chunks", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await put(a.key, { externalId: "secret", content: "Confidential formulary notes." });

    const res = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: { authorization: `Bearer ${b.key}` },
      payload: { query: "confidential formulary" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });

  it("rejects an empty query", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: { authorization: `Bearer ${key}` },
      payload: { query: "" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /health", () => {
  it("reports ok without authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});

describe("unknown routes", () => {
  it("returns the documented not_found error shape", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/documents/documents.routes.test.ts`
Expected: FAIL — cannot resolve `../app`.

- [ ] **Step 4: Write the schemas**

Create `src/documents/documents.schema.ts`. These are the single source of truth for validation, handler types, and the OpenAPI spec.

```ts
import { z } from "zod";

export const upsertDocumentBody = z.object({
  externalId: z.string().min(1).max(255).describe("Your own identifier for this document. Re-pushing the same externalId replaces the document rather than duplicating it."),
  title: z.string().max(500).optional(),
  content: z.string().min(1).max(200_000),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary JSON returned alongside search results."),
});

export const listDocumentsQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const deleteDocumentParams = z.object({
  externalId: z.string().min(1),
});

export const searchBody = z.object({
  query: z.string().min(1).max(2000),
  topK: z.coerce.number().int().positive().max(20).default(5),
});

/**
 * The public shape of a document. `tenantId` is deliberately absent — the
 * caller already knows which tenant it is, and keeping it out of the contract
 * means a future multi-tenant-aware key cannot accidentally expose it.
 */
export const documentResponse = z.object({
  id: z.string(),
  externalId: z.string(),
  title: z.string().nullable(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const searchResultResponse = z.object({
  documentId: z.string(),
  externalId: z.string(),
  title: z.string().nullable(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
```

- [ ] **Step 5: Write the routes plugin**

Create `src/documents/documents.routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Document } from "../db/schema";
import { retrieve } from "../retrieval/retrieve";
import { deleteDocument, listDocuments, upsertDocument } from "./documents.service";
import {
  deleteDocumentParams,
  documentResponse,
  errorResponse,
  listDocumentsQuery,
  searchBody,
  searchResultResponse,
  upsertDocumentBody,
} from "./documents.schema";

/** Explicit mapping rather than relying on Zod stripping unknown keys — the
 *  omission of tenantId is a contract decision, not a serializer side effect. */
function toPublicDocument(doc: Document) {
  return {
    id: doc.id,
    externalId: doc.externalId,
    title: doc.title,
    content: doc.content,
    metadata: (doc.metadata ?? {}) as Record<string, unknown>,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const documentsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.put(
    "/documents",
    {
      schema: {
        tags: ["Documents"],
        summary: "Create or replace a document",
        description:
          "Upserts on (tenant, externalId). The document is chunked and embedded synchronously, so it is searchable as soon as this call returns.",
        security: [{ bearerAuth: [] }],
        body: upsertDocumentBody,
        response: {
          200: z.object({ data: documentResponse }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const doc = await upsertDocument(request.tenant!.id, request.body);
      return reply.code(200).send({ data: toPublicDocument(doc) });
    },
  );

  app.get(
    "/documents",
    {
      schema: {
        tags: ["Documents"],
        summary: "List this tenant's documents",
        security: [{ bearerAuth: [] }],
        querystring: listDocumentsQuery,
        response: {
          200: z.object({
            data: z.array(documentResponse),
            meta: z.object({
              page: z.number(),
              limit: z.number(),
              total: z.number(),
            }),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { page, limit } = request.query;
      const { data, total } = await listDocuments(request.tenant!.id, page, limit);
      return reply.code(200).send({
        data: data.map(toPublicDocument),
        meta: { page, limit, total },
      });
    },
  );

  app.delete(
    "/documents/:externalId",
    {
      schema: {
        tags: ["Documents"],
        summary: "Delete a document",
        security: [{ bearerAuth: [] }],
        params: deleteDocumentParams,
        response: {
          200: z.object({ data: z.object({ deleted: z.boolean() }) }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const deleted = await deleteDocument(request.tenant!.id, request.params.externalId);
      if (!deleted) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "Document not found" } });
      }
      return reply.code(200).send({ data: { deleted: true } });
    },
  );

  app.post(
    "/search",
    {
      schema: {
        tags: ["Search"],
        summary: "Hybrid search over this tenant's documents",
        description:
          "Fuses a pgvector cosine-similarity leg and a Postgres full-text leg with Reciprocal Rank Fusion. Results are always scoped to the calling tenant.",
        security: [{ bearerAuth: [] }],
        body: searchBody,
        response: {
          200: z.object({ data: z.array(searchResultResponse) }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const results = await retrieve(request.tenant!.id, request.body.query, request.body.topK);
      return reply.code(200).send({
        data: results.map((r) => ({
          documentId: r.documentId,
          externalId: r.externalId,
          title: r.title,
          content: r.content,
          metadata: (r.metadata ?? {}) as Record<string, unknown>,
        })),
      });
    },
  );
};

export default documentsRoutes;
```

- [ ] **Step 6: Write `buildApp()`**

Create `src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import documentsRoutes from "./documents/documents.routes";
import authPlugin from "./plugins/auth";

export function buildApp(): FastifyInstance {
  const app = Fastify({ bodyLimit: 5 * 1024 * 1024 });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get("/health", async () => ({ status: "ok" }));

  // The /v1 wrapper is the encapsulation boundary. authPlugin is `fp`-wrapped,
  // so its preHandler attaches to THIS scope — covering every route registered
  // inside it, and nothing outside it. See Task 5.
  void app.register(
    async (v1) => {
      await v1.register(authPlugin);
      await v1.register(documentsRoutes);
    },
    { prefix: "/v1" },
  );

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "Route not found" } }),
  );

  app.setErrorHandler(async (err, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: err.validation.map((i) => `${i.instancePath} ${i.message}`).join("; ").trim(),
        },
      });
    }

    if (isResponseSerializationError(err)) {
      return reply
        .code(500)
        .send({ error: { code: "internal_error", message: "Response did not match its schema" } });
    }

    return reply
      .code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500)
      .send({ error: { code: "internal_error", message: err.message } });
  });

  return app;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm test src/documents/documents.routes.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/app.ts src/documents/
git commit -m "feat(api): add documents and search endpoints"
```

---
### Task 12: Server bootstrap, admin CLI, and deployment

> **Rewritten for Fastify.** `app.listen()` is now async and returns a promise, shutdown is `app.close()` rather than a callback-style `server.close()`, and logging goes through `app.log` instead of `console`.

**Files:**
- Create: `src/server.ts`
- Create: `src/scripts/create-tenant.ts`
- Create: `railway.json`
- Create: `README.md`
- Test: manual verification (documented below)

**Interfaces:**
- Consumes: `buildApp` (Task 11); `config` (Task 1); `createTenant`, `issueApiKey` (Task 4); `client`, `db` (Task 2).
- Produces: a runnable server and a `pnpm create-tenant` CLI.

- [ ] **Step 1: Write the server entrypoint**

Create `src/server.ts`:

```ts
import { sql } from "drizzle-orm";
import { buildApp } from "./app";
import { config } from "./config";
import { client, db } from "./db";

async function main(): Promise<void> {
  const app = buildApp();

  // Fail fast: a service that cannot reach its database should never report
  // itself healthy, and finding out at boot beats finding out on first request.
  try {
    await db.execute(sql`select 1`);
    app.log.info("database connection ok");
  } catch (err) {
    app.log.error({ err }, "database unreachable at boot");
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      await app.close(); // drains in-flight requests
      await client.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    // host 0.0.0.0, not the default 127.0.0.1 — a container-bound service that
    // only listens on loopback is unreachable from Railway's proxy.
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}

void main();
```

- [ ] **Step 2: Write the tenant-creation CLI**

Create `src/scripts/create-tenant.ts`. This deliberately uses `console` rather than the app logger — its output is a human-readable receipt, not a log stream, and the API key must be legible in a terminal.

```ts
/* eslint-disable no-console */
import { client } from "../db";
import { createTenant, issueApiKey } from "../tenants/tenants.service";

async function main(): Promise<void> {
  const [name, slug] = process.argv.slice(2);
  if (!name || !slug) {
    console.error('Usage: pnpm create-tenant "<name>" <slug>');
    process.exit(1);
  }

  const tenant = await createTenant({ name, slug });
  const { plaintext } = await issueApiKey(tenant.id, "default");

  console.log(`\nTenant created: ${tenant.name} (${tenant.slug})`);
  console.log(`Tenant ID:      ${tenant.id}`);
  console.log(`API key:        ${plaintext}`);
  console.log("\nStore this key now — it is hashed in the database and cannot be shown again.\n");

  await client.end();
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the CLI script to `package.json`**

Add to the `scripts` block:

```json
"create-tenant": "tsx src/scripts/create-tenant.ts"
```

- [ ] **Step 4: Write `railway.json`**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "node dist/server.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

- [ ] **Step 5: Write `README.md`**

````markdown
# ai-chat-service

Multi-tenant retrieval service. Tenants push arbitrary documents over HTTP and
search them with hybrid (vector + keyword) retrieval. Domain-agnostic — a
product catalog, a pharmacy inventory, and a docs site are all just documents.

> The name `ai-chat-service` is a working title. It appears only in
> `package.json` and this file.

## Local setup

```bash
pnpm install
cp .env.example .env       # add your VOYAGE_API_KEY
pnpm db:start              # local Supabase (Docker) on ports 55321-55324
pnpm db:reset              # apply migrations
pnpm create-tenant "Acme Pharmacy" acme-pharmacy
pnpm dev
```

## API

All `/v1` routes require `Authorization: Bearer <api key>`.

| Method   | Path                        | Purpose                        |
| -------- | --------------------------- | ------------------------------ |
| `PUT`    | `/v1/documents`             | Create or replace a document   |
| `GET`    | `/v1/documents`             | List this tenant's documents   |
| `DELETE` | `/v1/documents/:externalId` | Delete a document              |
| `POST`   | `/v1/search`                | Hybrid search over documents   |
| `GET`    | `/health`                   | Liveness probe (no auth)       |
| `GET`    | `/docs`                     | Swagger UI (no auth)           |
| `GET`    | `/openapi.json`             | OpenAPI spec (no auth)         |

Full guides live in [`docs/`](docs/); runnable examples in [`examples/`](examples/).

## Tenant isolation

Every query against `documents` and `chunks` is filtered by `tenant_id`, taken
only from the authenticated API key — never from a request body, query param,
or path segment. `documents.routes.test.ts`, `documents.service.test.ts`, and
`retrieve.test.ts` all assert that one tenant cannot read or delete another's
data.
````

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: PASS — every suite green (config, api-key, schema, documents-schema, tenants, auth plugin, chunk-text, voyage, documents service, retrieval, routes).

- [ ] **Step 7: Verify the build**

Run: `pnpm build`
Expected: `tsc` completes with no output; `dist/server.js` exists and `dist/` contains **no** `.test.js` files.

- [ ] **Step 8: Manually verify the running service**

```bash
pnpm create-tenant "Acme Pharmacy" acme-pharmacy
pnpm dev
```

In a second terminal, substituting the printed key:

```bash
curl -s http://localhost:4000/health

curl -s -X PUT http://localhost:4000/v1/documents \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"externalId":"sku-1","title":"Paracetamol","content":"Paracetamol 500mg relieves fever and mild pain."}'

curl -s -X POST http://localhost:4000/v1/search \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"query":"something for a fever"}'
```

Expected: `{"status":"ok"}`; a document JSON body; and a search result whose
`externalId` is `sku-1`.

**This last call is the real proof of the system.** The query shares no keyword
with the stored title or content ("something for a fever" vs "Paracetamol
500mg"), so the FTS leg contributes nothing — a hit demonstrates the vector leg
genuinely works against live Voyage embeddings, which no mocked test can show.

- [ ] **Step 9: Cross-tenant spot check**

```bash
pnpm create-tenant "Other Co" other-co
curl -s -X POST http://localhost:4000/v1/search \
  -H "Authorization: Bearer <other-co key>" -H "Content-Type: application/json" \
  -d '{"query":"something for a fever"}'
```

Expected: `{"data":[]}` — the second tenant cannot see the first tenant's document.

- [ ] **Step 10: Commit**

```bash
git add package.json src/server.ts src/scripts/ railway.json README.md
git commit -m "feat: add server bootstrap, tenant CLI, and deploy config"
```

---
### Task 13: ESLint and Prettier

> **New task.** The roadmap specifies "flat config, `pnpm lint` / `pnpm format`, lint failures block CI" and nothing more; this is the first task-level spec.

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc`
- Create: `.prettierignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: `tsconfig.json` (Task 1) for type-aware linting.
- Produces: `pnpm lint`, `pnpm lint:fix`, `pnpm format`, `pnpm format:check`.

- [ ] **Step 1: Install**

```bash
pnpm add -D eslint @eslint/js typescript-eslint prettier eslint-config-prettier
```

- [ ] **Step 2: Write `eslint.config.js`**

`package.json` is `"type": "commonjs"`, so the flat config is CommonJS.

```js
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "supabase/**", "examples/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      // Drizzle's `.returning()` yields an array whose first element is
      // statically optional but dynamically guaranteed, and `request.tenant` is
      // guaranteed by the /v1 preHandler. Both are asserted with `!` throughout
      // by design, so this rule would fire on correct code everywhere.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Kept ON deliberately: the codebase uses deliberate fire-and-forget
      // (last_used_at telemetry), and each site marks itself with `void`. An
      // unmarked floating promise is a bug, not a style choice.
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  prettier,
);
```

`prettier` (i.e. `eslint-config-prettier`) is **last** so it can switch off every stylistic rule that would otherwise fight the formatter.

- [ ] **Step 3: Write `.prettierrc` and `.prettierignore`**

`.prettierrc`:

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always"
}
```

`.prettierignore`:

```
dist/
node_modules/
pnpm-lock.yaml
supabase/.temp/
```

- [ ] **Step 4: Add the scripts**

```json
"lint": "eslint .",
"lint:fix": "eslint . --fix",
"format": "prettier --write .",
"format:check": "prettier --check ."
```

- [ ] **Step 5: Format the codebase and fix what lint finds**

```bash
pnpm format
pnpm lint:fix
pnpm lint
```

Expected: `pnpm lint` exits 0. Fix any remaining error by hand — do not silence a rule to make it pass without writing down why in a comment.

- [ ] **Step 6: Prove lint actually fails the build**

Temporarily add an unused variable to any source file, then:

Run: `pnpm lint`
Expected: FAIL, non-zero exit, naming the file. Remove the variable and confirm it passes again. This matters because a lint step that cannot fail is worse than no lint step — it produces a green check that means nothing.

- [ ] **Step 7: Confirm the suite still passes**

Run: `pnpm test && pnpm typecheck`
Expected: both green — formatting touched every file, so this catches an autofix that changed behaviour.

- [ ] **Step 8: Commit**

```bash
git add eslint.config.js .prettierrc .prettierignore package.json pnpm-lock.yaml
git commit -m "chore: add eslint and prettier"
git add -A && git commit -m "style: format codebase with prettier"
```

Two commits, deliberately: the tooling change and the mechanical reformat of every file are separate concerns, and bundling them makes the diff unreviewable.

---

### Task 14: Observability and hardening

> **New task.** Smaller than it would be on Express, because Fastify supplies the logger and request ids natively — this task configures them rather than building them.

**Files:**
- Create: `src/lib/logger.ts`
- Modify: `src/app.ts`
- Test: `src/app.observability.test.ts`

**Interfaces:**
- Consumes: `config` (Task 1).
- Produces: `loggerOptions` per environment; `buildApp(opts?)` accepting a logger override for tests; `@fastify/helmet` and `@fastify/cors` registered; an error handler that logs with the request id.

- [ ] **Step 1: Install**

```bash
pnpm add @fastify/helmet @fastify/cors
```

- [ ] **Step 2: Write the failing test**

Create `src/app.observability.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

/** Captures raw pino output so we can assert on what actually gets logged. */
function captureLogs() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      level: "info",
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    },
  };
}

describe("request logging", () => {
  it("logs every request with a request id", async () => {
    const { lines, logger } = captureLogs();
    const app = buildApp({ logger });

    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.some((e) => typeof e.reqId === "string")).toBe(true);
  });

  it("logs an unhandled error with the same request id, and does not swallow it", async () => {
    const { lines, logger } = captureLogs();
    const app = buildApp({ logger });
    app.get("/boom", async () => {
      throw new Error("kaboom");
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    await app.close();

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal_error");

    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const errorLine = entries.find((e) => e.level === 50);
    expect(errorLine).toBeDefined();
    expect(typeof errorLine!.reqId).toBe("string");
  });
});

describe("security headers", () => {
  it("sets helmet's headers", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does not grant cross-origin access to browsers", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example" },
    });
    await app.close();

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/app.observability.test.ts`
Expected: FAIL — `buildApp` takes no arguments yet, and no helmet headers are set.

- [ ] **Step 4: Write the logger options**

Create `src/lib/logger.ts`:

```ts
import type { FastifyServerOptions } from "fastify";
import { config } from "../config";

/**
 * JSON in production (machine-parseable for Railway's log drain), pretty in
 * development (human-readable), and off entirely in tests — a test suite that
 * prints a log line per request buries the actual failure output.
 */
export const loggerOptions: Record<string, FastifyServerOptions["logger"]> = {
  production: { level: config.LOG_LEVEL },
  development: {
    level: config.LOG_LEVEL,
    transport: {
      target: "pino-pretty",
      options: { translateTime: "HH:MM:ss Z", ignore: "pid,hostname" },
    },
  },
  test: false,
};

export const defaultLogger = loggerOptions[config.NODE_ENV] ?? false;
```

- [ ] **Step 5: Wire it into `buildApp()`**

Modify `src/app.ts`:

```ts
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
// ...existing imports
import { defaultLogger } from "./lib/logger";

export function buildApp(
  opts: { logger?: FastifyServerOptions["logger"] } = {},
): FastifyInstance {
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    logger: opts.logger ?? defaultLogger,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  void app.register(fastifyHelmet);

  // CORS is registered but closed. Sprint 1 issues only SECRET keys, which must
  // never reach a browser — so granting any cross-origin access would actively
  // encourage the one thing authentication.md warns against. Sprint 4 adds
  // publishable keys with a per-tenant domain allowlist; this is the single
  // place that changes when it does.
  void app.register(fastifyCors, { origin: false });

  // ...existing /health, /v1 scope, notFoundHandler
```

and replace the error handler's final branch so failures are logged rather than silently serialized:

```ts
  app.setErrorHandler(async (err, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: err.validation.map((i) => `${i.instancePath} ${i.message}`).join("; ").trim(),
        },
      });
    }

    if (isResponseSerializationError(err)) {
      request.log.error({ err }, "response failed its schema");
      return reply
        .code(500)
        .send({ error: { code: "internal_error", message: "Response did not match its schema" } });
    }

    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    // Only genuinely unexpected failures are logged at error level. A 4xx is
    // the caller's problem and would just be noise at this volume.
    if (status >= 500) request.log.error({ err }, "unhandled error");

    return reply.code(status).send({ error: { code: "internal_error", message: err.message } });
  });
```

`request.log` rather than `app.log` is the whole point: Fastify's child logger carries `reqId` automatically, so the error line joins up with the request lines around it.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test src/app.observability.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Confirm nothing else broke**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all green. Helmet changes response headers, so this catches any test asserting on an exact header set.

- [ ] **Step 8: Verify production emits JSON**

```bash
pnpm build
NODE_ENV=production DATABASE_URL=... VOYAGE_API_KEY=... node dist/server.js
```

Expected: startup lines are single-line JSON objects, not pretty-printed colour output. Stop the server afterwards.

- [ ] **Step 9: Commit**

```bash
git add src/lib/logger.ts src/app.ts src/app.observability.test.ts package.json pnpm-lock.yaml
git commit -m "feat(observability): configure pino, helmet, cors and error logging"
```

---

### Task 15: GitHub Actions CI

> **New task.** The roadmap specifies "lint → typecheck → test on every push/PR against a `postgres:16` service container with the `vector` extension and both migrations applied."

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `pnpm lint` (Task 13), `pnpm typecheck` (Task 1), `pnpm test`, `supabase/migrations/*.sql` (Tasks 2 and 6).
- Produces: a required status check on every push and pull request.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`. Note the image: **`pgvector/pgvector:pg16`, not `postgres:16`** — the stock Postgres image has no `vector` extension available to install, so `create extension vector` in migration 001 fails and every DB-backed test dies at setup.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
      VOYAGE_API_KEY: ci-test-key
      VOYAGE_EMBEDDING_MODEL: voyage-3
      NODE_ENV: test

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Apply migrations
        run: |
          for f in supabase/migrations/*.sql; do
            echo "applying $f"
            psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
          done

      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

`VOYAGE_API_KEY` is a throwaway string, not a secret: every test mocks the Voyage module, so the value is only ever read by config validation. Keeping a real key out of CI is deliberate — CI must never be able to spend money.

- [ ] **Step 2: Note the env-var trap in the README**

Add to `README.md` under local setup:

> **Adding a required env var is a two-file change.** `src/config/index.ts` validates the environment at import time, so *every* test file fails config validation the moment a new required variable exists but is not also present in `.github/workflows/ci.yml`'s `env:` block. A passing local build never catches this, because your `.env` already has it.

This exact trap is documented in Aurevo.BE's CLAUDE.md as something that bit that project repeatedly; it is inherited here along with the config pattern.

- [ ] **Step 3: Verify the workflow parses**

Run: `pnpm dlx yaml-lint .github/workflows/ci.yml` (or any YAML validator)
Expected: valid. A syntax error here is only discovered on push, where it costs a round trip.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: add lint, typecheck and test workflow"
```

- [ ] **Step 5: Confirm CI is green after the first push**

CI green on the first push is part of Sprint 1's exit gate. If the remote does not exist yet, this step is carried to whenever the repo is first pushed — but it is not optional, and it is not "done" until observed green.

---

### Task 16: OpenAPI specification and live API reference

> **New task.** The roadmap specifies `@fastify/swagger` + `@fastify/swagger-ui` driven off the existing Zod route schemas, served at `/docs` and `/openapi.json`, with "a test asserts every `/v1` route appears in the generated spec, so a new endpoint cannot ship undocumented."

**Files:**
- Modify: `src/app.ts`
- Test: `src/app.openapi.test.ts`

**Interfaces:**
- Consumes: the Zod route schemas from Task 11; `@fastify/swagger` (already installed in Task 11 as a peer dependency).
- Produces: `GET /docs` (Swagger UI) and `GET /openapi.json` (machine-readable spec), both unauthenticated.

- [ ] **Step 1: Install the UI**

```bash
pnpm add @fastify/swagger-ui
```

- [ ] **Step 2: Write the failing test**

Create `src/app.openapi.test.ts`. The second test is the one that earns its keep: it enumerates the routes Fastify actually registered and asserts each one is in the spec, so adding an endpoint without a schema fails CI.

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

/** Fastify route params are `:externalId`; OpenAPI paths are `{externalId}`. */
function toOpenApiPath(url: string): string {
  return url.replace(/:(\w+)/g, "{$1}");
}

describe("OpenAPI spec", () => {
  it("serves a spec naming the service and its security scheme", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBeTruthy();
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  it("documents every registered /v1 route", async () => {
    const app = buildApp({ logger: false });

    // `register` is deferred until ready(), so a hook added here still sees
    // every route the plugins go on to register.
    const registered: string[] = [];
    app.addHook("onRoute", (route) => {
      if (route.url.startsWith("/v1") && route.method !== "HEAD") {
        registered.push(toOpenApiPath(route.url));
      }
    });
    await app.ready();

    const spec = app.swagger() as { paths: Record<string, unknown> };
    const documented = Object.keys(spec.paths);
    await app.close();

    expect(registered.length).toBeGreaterThan(0);
    for (const path of registered) {
      expect(documented).toContain(path);
    }
  });

  it("serves the browsable UI without authentication", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/docs" });
    await app.close();

    // swagger-ui redirects /docs -> /docs/static/index.html
    expect([200, 302]).toContain(res.statusCode);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/app.openapi.test.ts`
Expected: FAIL — `/openapi.json` returns the 404 error shape and `app.swagger` is not a function.

- [ ] **Step 4: Register swagger in `buildApp()`**

Modify `src/app.ts`. Registration must come **before** the routes, so the spec builder sees them.

```ts
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
```

```ts
  // Before the /v1 registration:
  void app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "AI Chat Service API",
        version: "0.1.0",
        description:
          "Multi-tenant document ingestion and hybrid retrieval. Push documents with PUT /v1/documents, then search them with POST /v1/search. All /v1 routes require a secret API key.",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "Your secret API key, e.g. `sk_live_…`. Server-side only.",
          },
        },
      },
    },
    // Converts the Zod route schemas into JSON Schema for the spec. This is why
    // the reference cannot drift from validation: they are the same object.
    transform: jsonSchemaTransform,
  });

  void app.register(fastifySwaggerUI, { routePrefix: "/docs" });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
```

`/openapi.json` is hidden from the spec it serves — a self-referential entry is noise, and `schema: { hide: true }` is also what keeps the health check and docs routes out of the published surface if desired.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/app.openapi.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Verify by eye**

```bash
pnpm dev
```

Open `http://localhost:4000/docs`. Expected: all four `/v1` operations listed with request and response schemas, an **Authorize** button accepting a bearer token, and `PUT /v1/documents` showing `externalId`/`title`/`content`/`metadata` with the descriptions written in Task 11.

Then paste `http://localhost:4000/openapi.json` into an OpenAPI validator and confirm it reports no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/app.ts src/app.openapi.test.ts
git commit -m "feat(docs): publish OpenAPI spec and Swagger UI"
```

---

### Task 17: Integration documentation and runnable examples

> **New task.** The audience is a developer who has never seen this repo and wants a working integration in ten minutes. For a developer-facing product the integration docs *are* the product surface: a developer who cannot integrate quickly never discovers whether the retrieval is any good.

**Files:**
- Create: `docs/quickstart.md`
- Create: `docs/concepts.md`
- Create: `docs/authentication.md`
- Create: `docs/errors.md`
- Create: `docs/self-hosting.md`
- Create: `examples/curl.sh`
- Create: `examples/node/index.js`
- Create: `examples/node/README.md`

**Interfaces:**
- Consumes: the finished API from Tasks 11–16.
- Produces: the written half of Sprint 1's exit gate.

- [ ] **Step 1: Write `docs/quickstart.md`**

The ten-minute path, each step in **both** curl and Node `fetch`:

1. Get a key — `pnpm create-tenant "Acme Pharmacy" acme-pharmacy`, with an explicit "copy this now, it is shown once."
2. Push your first document — `PUT /v1/documents`, explaining that `externalId` is the caller's own id.
3. Search it — `POST /v1/search`, using a query that shares no keyword with the document, so the reader sees semantic retrieval working rather than string matching.
4. What next — links to `concepts.md`, `/docs`, and `examples/`.

- [ ] **Step 2: Write `docs/concepts.md`**

Tenant, document, chunk, retrieval. Must state plainly:
- `externalId` is **your** id. Re-pushing the same one replaces the document rather than duplicating it — this is what makes a re-sync loop safe to run repeatedly.
- **Chunking is internal.** Callers push whole documents and never manage chunks; the service splits, embeds, and reassembles on retrieval.
- Retrieval is hybrid: a vector leg for meaning and a keyword leg for exact terms, fused with Reciprocal Rank Fusion. Say what that buys — a product code matches exactly, a paraphrased question still matches.
- Tenant isolation: every query is scoped by the key you authenticated with.

- [ ] **Step 3: Write `docs/authentication.md`**

- Secret keys (`sk_live_…`), server-side only, full read/write access to that tenant's documents.
- **Never ship a secret key to a browser.** Anyone holding it can read, replace, and delete every document you have pushed. Publishable browser-safe keys arrive in Sprint 4.
- Rotation: issue a new key, deploy it, then revoke the old one — in that order, so there is no window without a working key.
- Keys are stored as SHA-256 hashes. A lost key cannot be recovered, only revoked and reissued.

- [ ] **Step 4: Write `docs/errors.md`**

The error contract table. Every failure returns `{ "error": { "code": "...", "message": "..." } }`.

| Code | HTTP | When |
|---|---|---|
| `unauthorized` | 401 | Missing, malformed, unknown, or revoked API key |
| `invalid_request` | 400 | Request body, query, or params failed schema validation |
| `not_found` | 404 | No such document for this tenant — or no such route |
| `internal_error` | 500 | Unexpected server failure |

State explicitly that these codes are a stable public contract: `message` may change wording at any time, `code` may not. Note that `not_found` on a delete is also what a caller sees when addressing **another tenant's** document — deliberately indistinguishable from a genuinely missing one, so the API cannot be used to probe for the existence of another tenant's data.

- [ ] **Step 5: Write `docs/self-hosting.md`**

Every env var and what happens without it; running migrations; the local Supabase port block (55321–55324) and why it differs from the Supabase default; deploying to Railway with `railway.json`, `/health` as the healthcheck path, and the reminder that `DATABASE_URL` must point at a Postgres with the `vector` extension available.

- [ ] **Step 6: Write `examples/curl.sh`**

Every endpoint as a copy-pasteable script reading `API_KEY` and `BASE_URL` from the environment, with `set -euo pipefail` so a failure stops rather than cascading.

- [ ] **Step 7: Write `examples/node/index.js` and its README**

A standalone script — plain `fetch`, no dependencies, no build step — that ingests three documents, runs a search, and prints the results. Its README states how to run it: `API_KEY=sk_live_... node examples/node/index.js`.

Keep it dependency-free on purpose: a reader must be able to see the whole integration in one file, and an example needing `pnpm install` is one more thing that can be broken by the reader's environment rather than by the service.

- [ ] **Step 8: Verify the quickstart from a clean database**

This is the step that catches documentation drift, and it only works if done honestly:

```bash
pnpm db:reset      # wipes everything
```

Then follow `docs/quickstart.md` **verbatim, without consulting the source code**, and confirm it ends in a successful search. Anything you had to know that is not written down is a documentation bug — fix the doc, not your memory of it.

- [ ] **Step 9: Verify the runnable example**

```bash
pnpm create-tenant "Example Co" example-co
API_KEY=<printed key> node examples/node/index.js
```

Expected: three documents ingested and a search result printed. The example doubles as a smoke test — if it breaks later, an integration path broke.

- [ ] **Step 10: Verify the published reference**

1. `GET /docs` renders and lists all four `/v1` operations.
2. `GET /openapi.json` passes an OpenAPI validator.

- [ ] **Step 11: Commit**

```bash
git add docs/ examples/
git commit -m "docs: add integration guides and runnable examples"
```

---
## Sprint 1 exit gate

Sprint 1 is done when every line below has been **observed**, not assumed. "It compiles" is not an exit gate.

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` all green locally.
- [ ] CI green on the first push.
- [ ] **Cross-tenant isolation proven by tests at all three layers:**
  - `retrieve.test.ts` — "never returns another tenant's chunks"
  - `documents.service.test.ts` — "refuses to delete another tenant's document", "keeps two tenants' same-externalId documents separate"
  - `documents.routes.test.ts` — "returns 404 for another tenant's document", "lists only the calling tenant's documents", "never returns another tenant's chunks"
- [ ] Deployed to Railway, with `/health` answering over the public URL.
- [ ] **Live semantic proof:** searching `"something for a fever"` returns the document titled `"Paracetamol"`. The query shares no keyword with the document, so a hit proves the vector leg works against real Voyage embeddings — something no mocked test can establish.
- [ ] Cross-tenant spot check against the running service: a second tenant's key returns `[]` for the first tenant's content.
- [ ] `GET /docs` renders and lists every `/v1` operation; `GET /openapi.json` passes an OpenAPI validator.
- [ ] `docs/quickstart.md` followed **verbatim from a clean database, without consulting the source**, ending in a successful search.
- [ ] `node examples/node/index.js` runs green against a fresh tenant.
- [ ] Observability check: each request logs a line carrying `reqId`, and `NODE_ENV=production` emits JSON rather than pretty-printed output.

## Deferred, with the sprint that owns them

These are deliberately **not** in Sprint 1. Each gets its own planning pass when it starts, informed by what the previous sprint taught us.

- **Sprint 2 — Chat engine.** Conversations/messages tables, an SSE streaming endpoint, the tool-use loop via the Vercel AI SDK, a built-in `search_knowledge` tool wired to `retrieve()`, rolling intent summaries, and per-request token metrics. **Reranking lands here**, alongside the eval harness that justifies it: Voyage `rerank-2.5-lite` is eval-gated as strictly better on Aurevo's catalog (MRR 0.984 → 1.000), but there is no way to confirm it helps on generic non-catalog data without evals, so the two ship together.
- **Sprint 3 — Custom tools.** Tenant-registered tool definitions (name, description, JSON schema, HTTPS endpoint), outbound calls with HMAC request signing, per-tool timeouts and graceful degradation. This is how a tenant exposes live data (stock, order status) without the service ever knowing what a "product" is.
- **Sprint 4 — Embeddable widget.** Publishable browser-safe keys separate from secret keys, per-tenant domain allowlisting, the drop-in `<script>` snippet, and the chat UI. The `origin: false` CORS registration from Task 14 is the single place that opens up.
- **Sprint 5 — Tenant dashboard.** Supabase Auth signup, API key management UI, document browser, usage and cost metrics.
- **Sprint 6 — Launch hardening.** Per-tenant rate limits and quotas (`@fastify/rate-limit`), abuse and cost-runaway protection, published docs site. **Rate limiting is a hard gate before any external tenant touches the service** — until Sprint 6 this is single-tenant-by-trust.
- **Aurevo migration.** Explicitly out of scope until the service is proven standalone.

## Known design debts

Recorded here because retrofitting either one after real tenant data exists is materially harder than designing for it now.

- **Embedding-model migration.** `vector(1024)` is pinned to `voyage-3`. Changing models later needs a migration plus a full re-embed of every tenant's corpus. A versioned-embeddings story is worth designing before the first paying tenant.
- **Billing and metering.** Not scoped in any sprint yet. If this is sold rather than self-hosted it needs a sprint of its own; the usage metrics in Sprint 5 are the natural foundation.

---

## Appendix: deviations during execution

Recorded after the fact. The plan above is what was intended; this is what
actually happened and why.

### Toolchain

- **TypeScript pinned to 5.9, not `latest`.** `pnpm add typescript` resolved to
  **7.0.2** — the Go-based native compiler. Drizzle's type inference and
  `drizzle-kit` 0.31 are validated against the 5.x line that Aurevo.BE runs in
  production, and the whole premise of this plan is porting a proven stack, so
  matching it beat being first onto a new compiler.
- **Zod 4, diverging from Aurevo.BE's Zod 3.** Not optional:
  `fastify-type-provider-zod@7` peer-requires `zod >=4.1.5`.
- **pnpm 11 moved the build-script allowlist.** The `pnpm` field in
  `package.json` is silently ignored, and `onlyBuiltDependencies` in
  `pnpm-workspace.yaml` is superseded by `allowBuilds`. Until this was right,
  `pnpm test` failed outright on `ERR_PNPM_IGNORED_BUILDS` — pnpm 11 treats an
  unapproved build script as an error, not a warning.

### Ordering

- `buildApp(opts)`'s logger parameter and `src/lib/logger.ts` were both pulled
  forward from Task 14, because Task 11's route tests need to silence logging
  and Task 12's `server.ts` needs the logger config.

### Corrections found while executing

- **`flushApiKeyTouches()` (Task 4).** The planned test asserted `last_used_at`
  immediately after `verifyApiKey`, racing the deliberate fire-and-forget write
  — postgres.js can run the update and the following read on different pooled
  connections. Production stays fire-and-forget; the test awaits a tracked
  promise instead.
- **`setErrorHandler` needs an explicit `FastifyError` annotation (Task 11).**
  Without it Fastify's overload resolution infers the error as `unknown` and
  every property access fails to typecheck, despite correct runtime behaviour.
- **Timestamps were not ISO-8601 (Task 12).** The Global Constraints call for
  ISO strings, but `mode: "string"` returns Postgres' own wire format
  (`2026-07-29 09:46:57.946863+00`). V8 parses it; Go's `time.RFC3339` and
  Python's `fromisoformat` do not. Normalised at the API boundary, with a test.
  Found only by looking at a real response body — no mocked test would have
  caught it.
- **The "cannot ship undocumented" test did not work as specified (Task 16).**
  The plan's check was that every registered `/v1` path appears in the spec, but
  `@fastify/swagger` auto-includes a schema-less route and invents a bare 200
  for it — so the test would have passed for exactly the endpoint it existed to
  catch. Verified empirically, then strengthened to assert `summary`,
  `security` and `operationId`, and re-verified that it now fails when an
  undocumented route is added.
- **The spec failed OpenAPI validation (Task 16).** `redocly lint` reported one
  error (`servers` must be present) and warnings for a missing `operationId` on
  every operation. Both were fixed; `operationId` matters because it is what
  client generators turn into method names. An optional `PUBLIC_URL` was added
  so the deployed spec advertises the real host — optional deliberately, since a
  new *required* var breaks every test until CI's env block is updated too.

### Infrastructure isolation (decided after the first push)

The service shares **no infrastructure** with any other project. Confirmed and
enforced:

- **Local Postgres** is its own Supabase project (`project_id =
  "ai-chat-service"`), its own Docker stack, on its own `55321`–`55324` port
  block. It can run concurrently with any other local Supabase stack, and
  cannot be confused for one.
- **Production Postgres** is a dedicated Supabase project; **production compute**
  is a dedicated Railway project. Neither is shared with, nor nested inside,
  another project's resources.
- **The only shared dependency is the Voyage AI API key**, which is billed per
  request rather than per project — so reusing one key across projects couples
  nothing operationally.

The single remaining Aurevo reference anywhere in the codebase is a comment in
`vitest.config.ts` explaining *why* `fileParallelism` is disabled. That is
lineage, not coupling.

Two hosted-Postgres behaviours are handled in `src/db/connection-options.ts`,
because neither is exercised by a localhost-only setup and both fail
confusingly:

- **TLS** is required for any non-private host. postgres.js does not negotiate
  it by default, and a managed provider refuses the connection without it.
- **Prepared statements are disabled on a transaction pooler** (port `6543`, or
  a `pooler.` hostname). That pooler multiplexes one server connection across
  many clients, so a statement prepared by one is invisible to the next —
  surfacing as intermittent `prepared statement does not exist` errors under
  concurrency, not as a clean failure at startup.

Both are derived from the URL rather than exposed as env vars, so there is no
way to deploy with a correct `DATABASE_URL` and a contradictory flag.

### Lint decisions worth knowing

`require-await` is off: Fastify's plugin, hook and handler contracts require
`async` regardless of whether the body awaits. The `no-unsafe-*` family is off
in test files only: `inject().json()` returns `any` by design, so those rules
fire on every correct assertion in a route test.

### Exit-gate status

**CI green on first push — met.** Run
[30457311026](https://github.com/nurul287/ai-chat-service/actions/runs/30457311026)
passed in 1m9s on the first push to `main`. The workflow had also been
rehearsed locally beforehand against the same `pgvector/pgvector:pg16` image
with only CI's env vars.

One annotation, not a failure: `actions/checkout@v4`, `actions/setup-node@v4`
and `pnpm/action-setup@v4` still target Node 20, which GitHub has deprecated
and now force-runs on Node 24. Bump those action majors when convenient.

**Deployed to Railway — NOT met.** No Railway project exists yet. This is the
only outstanding Sprint 1 exit-gate item; everything else was observed and is
recorded in the session that produced this repo.
