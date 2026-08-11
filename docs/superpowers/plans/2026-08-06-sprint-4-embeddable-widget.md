# Sprint 4: Embeddable Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant paste one `<script>` tag onto any page and get a
working chat bubble, authenticated by a publishable key that cannot touch
documents/tools, restricted to origins the tenant explicitly allows.

**Architecture:** A new `kind` column distinguishes publishable
(`pk_live_…`) from secret (`sk_live_…`) API keys; a new `allowed_origins`
column on `tenants` is the shared per-tenant domain allowlist. A new
`/widget/*` route group — structurally a sibling of `/v1`, never nested
inside it — carries its own publishable-key auth and its own dynamic CORS,
completely independent of `/v1`'s closed-CORS secret-key auth. `/widget/chat`
calls the existing `runChat()` directly; zero duplication of Sprint 2/3's
chat logic. A small vanilla-TS bundle in `widget/` (outside `src/`, which
compiles for Node) is served at `GET /widget.js`.

**Tech Stack:** Same as Sprint 1-3 — Fastify 5, Drizzle ORM, Zod, Vitest
against real local Postgres. New: `esbuild` (already a transitive
dependency via tooling, added here as a direct devDependency for the
widget's own build step), `jsdom` (for the one widget-side test needing
`localStorage`).

## Global Constraints

- **`tenantId` comes only from the authenticated key** — unchanged
  invariant, extended: a publishable key resolves to a tenant exactly like
  a secret key does, through its own verification function.
- **A publishable key must be structurally incapable of passing secret-key
  auth, and vice versa.** `verifyApiKey` (used by every existing `/v1/*`
  route) filters to `kind = 'secret'`; the new `verifyPublishableApiKey`
  filters to `kind = 'publishable'`. Neither function can accept the
  other's key — this is the exit gate's first half, enforced at the query,
  not by checking a flag after the fact.
- **CORS is not the security boundary; it only makes the legitimate case
  usable.** CORS is browser-enforced — it decides whether a browser's JS
  may *read* a response, not whether the server processes the request at
  all, and gives zero protection against a non-browser caller that ignores
  or spoofs `Origin`. Every `/widget/*` route independently rejects a
  request whose `Origin` isn't on the resolved tenant's `allowed_origins`,
  regardless of what CORS headers get sent. Verified empirically (Task 3)
  that a denied-CORS request still reaches and executes the route handler
  server-side — that's exactly why the independent check is required, not
  optional hardening.
- **`@fastify/cors`'s dynamic origin must be registered as `{ delegator:
  fn }`, not as a bare function passed directly as the plugin's options.**
  Verified empirically against the installed `@fastify/cors@11.3.0`: the
  bare-function form is silently ignored and CORS falls back to
  `Access-Control-Allow-Origin: *` (permissive, unverified) — that is the
  opposite of what this sprint needs and does not throw or warn, so no
  test that only checks "did a response come back" would catch it. Task 3
  writes a test asserting the actual header value.
- **CORS preflight (`OPTIONS`) never carries the real request's
  `Authorization` header** — browsers do not include it on the preflight
  itself. The CORS delegate branches on `request.method === "OPTIONS"` and
  reflects `Origin` permissively in that case; the real, tenant-scoped
  check only happens for the actual request. Verified empirically in
  Task 3 that this is genuinely how Fastify/the browser handshake works,
  not assumed from the spec.
- **`/widget/*` is a sibling of `/v1`, never nested inside it.**
  `src/plugins/auth.ts`'s `authPlugin` is `fp`-wrapped specifically so its
  preHandler attaches to whatever scope registers it — nesting a widget
  route under `/v1` would make it inherit secret-key auth and closed CORS.
  Verified empirically (Task 3) that two independent `fp`-wrapped auth
  plugins, each decorating `request.tenant`, work correctly when
  registered on sibling prefixed scopes with no collision.
- **No dashboard, no settings API this sprint.** Widget customization
  (color, position) is read from `data-*` attributes on the embed script
  tag itself. Publishable keys and the domain allowlist are CLI-managed,
  extending `create-tenant`'s existing tooling — matching how every
  credential-management operation in this project has worked so far.
  Sprint 5 owns the dashboard.
- **Tests run against real local Postgres** (`127.0.0.1:55322`),
  `fileParallelism: false` — unchanged from Sprint 1-3.
- Conventional commit messages. Commit at the end of every task.

---

### Task 1: Publishable key type and domain allowlist — schema

**Files:**
- Modify: `src/db/schema.ts`
- Test: `src/db/widget-schema.test.ts`
- Generated (not hand-written): a new file under `supabase/migrations/`,
  produced by `pnpm db:generate` in Step 4.

**Interfaces:**
- Consumes: `apiKeys`, `tenants` (existing).
- Produces: `apiKeys.kind` column (`"secret" | "publishable"`, `NOT NULL`,
  defaults `'secret'`); `tenants.allowedOrigins` column (`string[]`,
  `NOT NULL`, defaults `[]`). Task 2 consumes both directly.

- [ ] **Step 1: Write the failing test**

Create `src/db/widget-schema.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "./index";
import { apiKeys, tenants } from "./schema";

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

describe("api_keys.kind and tenants.allowed_origins", () => {
  it("defaults an api key's kind to secret", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [key] = await db
      .insert(apiKeys)
      .values({ tenantId: tenant!.id, name: "default", keyPrefix: "sk_live_x", keyHash: "hash1" })
      .returning();

    expect(key!.kind).toBe("secret");
  });

  it("accepts an explicit publishable kind", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [key] = await db
      .insert(apiKeys)
      .values({
        tenantId: tenant!.id,
        name: "widget",
        keyPrefix: "pk_live_x",
        keyHash: "hash2",
        kind: "publishable",
      })
      .returning();

    expect(key!.kind).toBe("publishable");
  });

  it("rejects a kind outside secret/publishable", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();

    await expect(
      db.insert(apiKeys).values({
        tenantId: tenant!.id,
        name: "bad",
        keyPrefix: "x",
        keyHash: "hash3",
        kind: "admin" as "secret",
      }),
    ).rejects.toThrow();
  });

  it("defaults a tenant's allowed_origins to an empty array", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    expect(tenant!.allowedOrigins).toEqual([]);
  });

  it("stores a tenant's allowed_origins list", async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ name: "A", slug: "a", allowedOrigins: ["https://acme.com", "https://www.acme.com"] })
      .returning();

    expect(tenant!.allowedOrigins).toEqual(["https://acme.com", "https://www.acme.com"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/widget-schema.test.ts`
Expected: FAIL — `kind` and `allowedOrigins` are not valid columns yet.

- [ ] **Step 3: Add the columns to the Drizzle schema**

Modify `src/db/schema.ts` — add `jsonb` and `check` to the `tenants`
table's needs (both already imported for other tables; confirm they're in
the top `drizzle-orm/pg-core` import list, which they already are).

Add `allowedOrigins` to the `tenants` table definition:

```ts
export const tenants = pgTable("tenants", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  allowedOrigins: jsonb("allowed_origins").default([]).notNull().$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});
```

Add `kind` to the `apiKeys` table definition, and a check constraint
alongside the existing index:

```ts
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text().notNull(),
    kind: text().notNull().default("secret").$type<"secret" | "publishable">(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_api_keys_tenant").on(table.tenantId),
    check("api_keys_kind_check", sql`${table.kind} in ('secret', 'publishable')`),
  ],
);
```

- [ ] **Step 4: Generate the migration**

```bash
pnpm db:generate
```

A new file appears under `supabase/migrations/`. Open it and confirm it
contains exactly: an `ALTER TABLE "tenants" ADD COLUMN "allowed_origins"`
statement, an `ALTER TABLE "api_keys" ADD COLUMN "kind"` statement, and the
new check constraint — nothing about any other table.

- [ ] **Step 5: Apply it locally**

```bash
pnpm db:reset
```

Expected: all migrations apply cleanly, ending with the new one.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/db/widget-schema.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Run the full suite to confirm nothing regressed**

Run: `pnpm test`
Expected: every existing test still passes — `kind` defaults to `'secret'`
for every existing insert that doesn't specify it, so no existing test
that creates an api key should need any change.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/widget-schema.test.ts supabase/migrations/
git commit -m "feat(db): add api_keys.kind and tenants.allowed_origins for Sprint 4"
```

---

### Task 2: Publishable key generation, verification, and tenant lookups

**Files:**
- Modify: `src/auth/api-key.ts`
- Modify: `src/tenants/tenants.service.ts`
- Test: `src/auth/api-key.test.ts` (create if it doesn't already exist —
  check first; if it exists, add to it)
- Test: `src/tenants/tenants.service.test.ts` (same — add to existing file)

**Interfaces:**
- Consumes: `apiKeys.kind`, `tenants.allowedOrigins` from Task 1.
- Produces:
  - `generateApiKey(kind?: "secret" | "publishable"): { plaintext, prefix, hash }`
    — signature change, `kind` optional and defaults to `"secret"` so
    every existing call site keeps working unchanged.
  - `issueApiKey(tenantId, name, kind?: "secret" | "publishable"): Promise<{ plaintext, prefix }>`
    — same backward-compatible default.
  - `verifyApiKey(plaintext): Promise<Tenant | null>` — now filters to
    `kind = 'secret'` only (behavior change: a publishable key presented
    here now correctly returns `null`).
  - `verifyPublishableApiKey(plaintext): Promise<Tenant | null>` — new,
    mirrors `verifyApiKey` but filters to `kind = 'publishable'`. Task 3
    consumes this.
  - `getTenantBySlug(slug): Promise<Tenant | null>` — new. Task 5 (CLI)
    consumes this.
  - `setAllowedOrigins(tenantId, origins: string[]): Promise<void>` — new.
    Task 5 consumes this.

- [ ] **Step 1: Check for existing test files, then write the failing tests**

Run `ls src/auth/*.test.ts src/tenants/*.test.ts` first — if
`src/auth/api-key.test.ts` or `src/tenants/tenants.service.test.ts`
already exist, add these tests to them rather than overwriting. If
`src/auth/api-key.test.ts` doesn't exist, create it with just the tests
below (no other content needed — `generateApiKey`/`hashApiKey` may not
have had a dedicated test file before now).

Add to (or create) `src/auth/api-key.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateApiKey } from "./api-key";

describe("generateApiKey", () => {
  it("defaults to a secret key with the sk_live_ prefix", () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith("sk_live_")).toBe(true);
  });

  it("generates a publishable key with the pk_live_ prefix", () => {
    const { plaintext } = generateApiKey("publishable");
    expect(plaintext.startsWith("pk_live_")).toBe(true);
  });
});
```

Add to `src/tenants/tenants.service.test.ts` (check it exists first the
same way; if not, create it with these tests plus a minimal `clean()`
helper matching the style of every other service test file in this
project — see `src/tools/tenant-tools.service.test.ts` for the exact
pattern to copy):

```ts
describe("issueApiKey / verifyApiKey / verifyPublishableApiKey — kind isolation", () => {
  it("a secret key issued by default is accepted by verifyApiKey", async () => {
    const tenant = await createTenant({ name: "A", slug: "a" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    const resolved = await verifyApiKey(plaintext);
    expect(resolved?.id).toBe(tenant.id);
  });

  it("a publishable key is rejected by verifyApiKey", async () => {
    const tenant = await createTenant({ name: "A", slug: "a" });
    const { plaintext } = await issueApiKey(tenant.id, "widget", "publishable");

    expect(await verifyApiKey(plaintext)).toBeNull();
  });

  it("a publishable key is accepted by verifyPublishableApiKey", async () => {
    const tenant = await createTenant({ name: "A", slug: "a" });
    const { plaintext } = await issueApiKey(tenant.id, "widget", "publishable");

    const resolved = await verifyPublishableApiKey(plaintext);
    expect(resolved?.id).toBe(tenant.id);
  });

  it("a secret key is rejected by verifyPublishableApiKey", async () => {
    const tenant = await createTenant({ name: "A", slug: "a" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    expect(await verifyPublishableApiKey(plaintext)).toBeNull();
  });
});

describe("getTenantBySlug", () => {
  it("returns the tenant matching the slug", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    expect((await getTenantBySlug("acme"))?.id).toBe(tenant.id);
  });

  it("returns null for an unknown slug", async () => {
    expect(await getTenantBySlug("no-such-slug")).toBeNull();
  });
});

describe("setAllowedOrigins", () => {
  it("replaces a tenant's allowed_origins list", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await setAllowedOrigins(tenant.id, ["https://acme.com"]);

    const [row] = await db.select().from(tenants).where(eq(tenants.id, tenant.id));
    expect(row!.allowedOrigins).toEqual(["https://acme.com"]);
  });
});
```

Add the corresponding imports at the top of the test file:
`verifyPublishableApiKey`, `getTenantBySlug`, `setAllowedOrigins` from
`./tenants.service`; `eq` from `drizzle-orm`; `tenants` from `../db/schema`
(alongside whatever's already imported there).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/auth/api-key.test.ts src/tenants/tenants.service.test.ts`
Expected: FAIL — `verifyPublishableApiKey`, `getTenantBySlug`,
`setAllowedOrigins` don't exist yet; `generateApiKey("publishable")`
still produces an `sk_live_` prefix.

- [ ] **Step 3: Implement `src/auth/api-key.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIXES = { secret: "sk_live_", publishable: "pk_live_" } as const;
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

export function generateApiKey(
  kind: "secret" | "publishable" = "secret",
): { plaintext: string; prefix: string; hash: string } {
  const plaintext = `${KEY_PREFIXES[kind]}${randomBytes(32).toString("base64url")}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX_LENGTH),
    hash: hashApiKey(plaintext),
  };
}
```

- [ ] **Step 4: Implement `src/tenants/tenants.service.ts`**

Replace the whole file with:

```ts
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, tenants, type Tenant } from "../db/schema";
import { generateApiKey, hashApiKey } from "../auth/api-key";

export async function createTenant(input: { name: string; slug: string }): Promise<Tenant> {
  const [tenant] = await db.insert(tenants).values(input).returning();
  return tenant!;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  return tenant ?? null;
}

export async function setAllowedOrigins(tenantId: string, origins: string[]): Promise<void> {
  await db
    .update(tenants)
    .set({ allowedOrigins: origins, updatedAt: new Date().toISOString() })
    .where(eq(tenants.id, tenantId));
}

/**
 * Returns the plaintext key exactly once — it is not stored and cannot be
 * recovered afterwards. The caller is responsible for showing it to the user
 * immediately; a lost key must be revoked and reissued.
 */
export async function issueApiKey(
  tenantId: string,
  name: string,
  kind: "secret" | "publishable" = "secret",
): Promise<{ plaintext: string; prefix: string }> {
  const { plaintext, prefix, hash } = generateApiKey(kind);
  await db.insert(apiKeys).values({ tenantId, name, keyPrefix: prefix, keyHash: hash, kind });
  return { plaintext, prefix };
}

export async function verifyApiKey(plaintext: string): Promise<Tenant | null> {
  const hash = hashApiKey(plaintext);

  const [row] = await db
    .select({ id: apiKeys.id, tenantId: apiKeys.tenantId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), eq(apiKeys.kind, "secret"), isNull(apiKeys.revokedAt)));

  if (!row) return null;

  touchLastUsed(row.id);

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId));
  return tenant ?? null;
}

/**
 * Mirrors verifyApiKey exactly, filtered to the opposite kind. Kept as a
 * separate function rather than a parameterized one so that neither call
 * site can accidentally pass the wrong kind at a call site — the function
 * name IS the guarantee.
 */
export async function verifyPublishableApiKey(plaintext: string): Promise<Tenant | null> {
  const hash = hashApiKey(plaintext);

  const [row] = await db
    .select({ id: apiKeys.id, tenantId: apiKeys.tenantId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), eq(apiKeys.kind, "publishable"), isNull(apiKeys.revokedAt)));

  if (!row) return null;

  touchLastUsed(row.id);

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, row.tenantId));
  return tenant ?? null;
}

const pendingTouches = new Set<Promise<void>>();

/**
 * Fire-and-forget: last_used_at is telemetry, and must never add latency to
 * or fail an authenticated request. Shared by both verify functions.
 */
function touchLastUsed(keyId: string): void {
  const touch = db
    .update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, keyId))
    .then(
      () => undefined,
      () => undefined,
    );
  pendingTouches.add(touch);
  void touch.finally(() => pendingTouches.delete(touch));
}

/**
 * Test-only: resolves once every in-flight `last_used_at` write has settled.
 * Without this a test asserting on last_used_at races the fire-and-forget
 * update, because postgres.js may run the update and the following read on
 * different pooled connections.
 */
export async function flushApiKeyTouches(): Promise<void> {
  await Promise.all([...pendingTouches]);
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, keyId));
}
```

Note: this refactors the previous inline `last_used_at` touch logic in
`verifyApiKey` into a shared `touchLastUsed` helper, since
`verifyPublishableApiKey` needs the exact same behavior. `flushApiKeyTouches`
still works unchanged — `pendingTouches` is the same module-level set
either function adds to.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/auth/api-key.test.ts src/tenants/tenants.service.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: every existing test passes unchanged — `verifyApiKey`'s added
`kind = 'secret'` filter matches every key any existing test creates,
since Task 1 defaults `kind` to `'secret'`.

- [ ] **Step 7: Commit**

```bash
git add src/auth/api-key.ts src/auth/api-key.test.ts src/tenants/tenants.service.ts src/tenants/tenants.service.test.ts
git commit -m "feat(auth): add publishable key generation, verification, and tenant lookups"
```

---

### Task 3: Publishable auth plugin, widget CORS, and `POST /widget/session`

**Files:**
- Create: `src/plugins/publishable-auth.ts`
- Create: `src/widget/widget.schema.ts`
- Create: `src/widget/widget.routes.ts`
- Test: `src/widget/widget.routes.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `verifyPublishableApiKey` from `src/tenants/tenants.service.ts`
  (Task 2).
- Produces: the `/widget` route prefix registered in `app.ts`, with
  publishable-key auth and per-tenant CORS wired on. Task 4 registers
  `POST /widget/chat` inside the same `widget.routes.ts` file and prefix.

This task is the one with the most subtle, previously-verified mechanics —
follow the exact code below rather than reconstructing it from the general
`@fastify/cors` docs, which describe the bare-function `origin` option that
does **not** work for this use case (see Global Constraints).

- [ ] **Step 1: Write the failing tests**

Create `src/widget/widget.routes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant, issueApiKey, setAllowedOrigins } from "../tenants/tenants.service";
import { buildApp } from "../app";

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

async function tenantWithPublishableKey(slug: string, allowedOrigins: string[]) {
  const tenant = await createTenant({ name: slug, slug });
  await setAllowedOrigins(tenant.id, allowedOrigins);
  const { plaintext } = await issueApiKey(tenant.id, "widget", "publishable");
  return { tenant, key: plaintext };
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

describe("POST /widget/session", () => {
  it("mints a fresh externalUserId for an allowed origin", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().externalUserId).toBe("string");
    expect(res.json().externalUserId.length).toBeGreaterThan(0);
  });

  it("mints a different id on each call", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);
    const headers = { authorization: `Bearer ${key}`, origin: "https://acme.com" };

    const first = await app.inject({ method: "POST", url: "/widget/session", headers });
    const second = await app.inject({ method: "POST", url: "/widget/session", headers });

    expect(first.json().externalUserId).not.toBe(second.json().externalUserId);
  });

  it("rejects a request from an origin not on the tenant's allowlist", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}`, origin: "https://evil.example.com" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a request with no Origin header at all", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a secret key, even one that would pass on /v1", async () => {
    const tenant = await createTenant({ name: "acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    const res = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${plaintext}`, origin: "https://acme.com" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("sends Access-Control-Allow-Origin only for the allowed origin, echoing the request Origin", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const allowed = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://acme.com");

    const denied = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}`, origin: "https://evil.example.com" },
    });
    // The critical assertion: CORS must NOT just be "*" or reflect a
    // disallowed origin — a wildcard here would mean the delegate wasn't
    // actually wired up (see this plan's Global Constraints).
    expect(denied.headers["access-control-allow-origin"]).not.toBe("*");
    expect(denied.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
  });

  it("answers a CORS preflight (OPTIONS) without requiring the Authorization header", async () => {
    await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "OPTIONS",
      url: "/widget/session",
      headers: {
        origin: "https://acme.com",
        "access-control-request-method": "POST",
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("https://acme.com");
  });
});

describe("/v1 routes reject publishable keys", () => {
  it("a publishable key on /v1/documents is rejected exactly like an invalid key", async () => {
    const tenant = await createTenant({ name: "acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "widget", "publishable");

    const res = await app.inject({
      method: "GET",
      url: "/v1/documents",
      headers: { authorization: `Bearer ${plaintext}` },
    });

    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/widget/widget.routes.test.ts`
Expected: FAIL — `/widget/session` doesn't exist yet (404s), so every test
fails on status code.

- [ ] **Step 3: Implement `src/plugins/publishable-auth.ts`**

```ts
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { verifyPublishableApiKey } from "../tenants/tenants.service";

/**
 * Mirrors src/plugins/auth.ts's structure exactly, but resolves a
 * publishable key and additionally requires the request's Origin to be on
 * the resolved tenant's allowed_origins list. This is the actual security
 * boundary for the widget — CORS (src/widget/widget.routes.ts's
 * registration) only controls whether a browser is allowed to *read* the
 * response; a request from a disallowed origin still reaches this
 * preHandler and is rejected here regardless of what CORS headers get
 * sent (verified in widget.routes.test.ts).
 *
 * `request.tenant`'s type is already declared globally by auth.ts's
 * `declare module "fastify"` block — no need to redeclare it here.
 *
 * Wrapped in `fp` for the same reason as auth.ts: so the preHandler
 * attaches to the enclosing scope (the `/widget` prefix block in app.ts)
 * rather than this plugin's own empty child context. Verified empirically
 * that two independently `fp`-wrapped auth plugins — this one and
 * auth.ts's — can each decorate `request.tenant` on their own sibling
 * scope (`/widget` vs `/v1`) without colliding.
 */
const publishableAuthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("tenant", null);

  fastify.addHook("preHandler", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Missing Bearer API key" } });
    }

    const tenant = await verifyPublishableApiKey(header.slice("Bearer ".length).trim());
    if (!tenant) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Invalid or revoked API key" } });
    }

    const origin = request.headers.origin;
    if (!origin || !tenant.allowedOrigins.includes(origin)) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Origin not allowed for this tenant" } });
    }

    request.tenant = tenant;
  });
};

export default fp(publishableAuthPlugin, { name: "publishable-auth" });
```

- [ ] **Step 4: Implement `src/widget/widget.schema.ts`**

```ts
import { z } from "zod";

export const widgetSessionResponse = z.object({
  externalUserId: z.string(),
});
```

- [ ] **Step 5: Implement `src/widget/widget.routes.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponse } from "../documents/documents.schema";
import { widgetSessionResponse } from "./widget.schema";

const widgetRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/session",
    {
      schema: {
        operationId: "startWidgetSession",
        tags: ["Widget"],
        summary: "Mint a new visitor session for the embeddable widget",
        description:
          "Called once by the widget on first load. Nothing is persisted here — the " +
          "returned id only becomes meaningful once used as externalUserId in a real chat turn.",
        security: [{ bearerAuth: [] }],
        response: { 200: widgetSessionResponse, 401: errorResponse },
      },
    },
    async (_request, reply) => {
      return reply.code(200).send({ externalUserId: randomUUID() });
    },
  );
};

export default widgetRoutes;
```

- [ ] **Step 6: Wire `/widget` into `app.ts`, as a sibling of `/v1`**

Modify `src/app.ts` — add the imports:

```ts
import publishableAuthPlugin from "./plugins/publishable-auth";
import widgetRoutes from "./widget/widget.routes";
```

And register a new top-level prefix block, placed after the existing
`/v1` block (order doesn't matter functionally, but keeps related things
grouped):

```ts
  // A sibling of /v1, not nested inside it — see this plan's Global
  // Constraints for why nesting here would incorrectly inherit /v1's
  // closed CORS and secret-key auth.
  void app.register(
    async (widget) => {
      await widget.register(fastifyCors, {
        delegator: async (request) => {
          const origin = request.headers.origin;

          // Preflight never carries the real request's Authorization
          // header, so there's no key yet to resolve a tenant from. This
          // branch is inert: the actual authorization decision happens in
          // publishableAuthPlugin's preHandler on the real request, which
          // runs regardless of what CORS decided here.
          if (request.method === "OPTIONS") {
            return { origin: origin ?? false };
          }

          const header = request.headers.authorization;
          if (!header?.startsWith("Bearer ") || !origin) {
            return { origin: false };
          }

          const tenant = await verifyPublishableApiKey(header.slice("Bearer ".length).trim());
          const allowed = tenant?.allowedOrigins.includes(origin) ?? false;
          return { origin: allowed ? origin : false };
        },
      });
      await widget.register(publishableAuthPlugin);
      await widget.register(widgetRoutes);
    },
    { prefix: "/widget" },
  );
```

Add the `verifyPublishableApiKey` import alongside the others at the top
of `app.ts`:

```ts
import { verifyPublishableApiKey } from "./tenants/tenants.service";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run src/widget/widget.routes.test.ts`
Expected: PASS (all tests, including the CORS-header assertions)

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: every existing test still passes — `/v1`'s CORS and auth are
completely untouched by this task; only a new sibling scope was added.

- [ ] **Step 9: Commit**

```bash
git add src/plugins/publishable-auth.ts src/widget/widget.schema.ts src/widget/widget.routes.ts src/widget/widget.routes.test.ts src/app.ts
git commit -m "feat(widget): add publishable auth, per-tenant CORS, and POST /widget/session"
```

---

### Task 4: `POST /widget/chat`, reusing the existing chat engine

**Files:**
- Create: `src/chat/stream-chat-response.ts`
- Modify: `src/chat/chat.routes.ts`
- Modify: `src/widget/widget.routes.ts`
- Test: `src/widget/widget.routes.test.ts` (add to it)
- Test: `src/chat/chat.routes.test.ts` (no behavior change expected — see
  Step 5)

**Interfaces:**
- Consumes: `runChat`, `ConversationNotFoundError`, `ChatWireEvent` from
  `src/chat/chat.service.ts` (existing, Sprint 2); `chatBody` from
  `src/chat/chat.schema.ts` (existing).
- Produces: `streamChatResponse(reply: FastifyReply, input: RunChatInput): Promise<void>`
  — extracted from `chat.routes.ts`'s existing `POST /chat` handler so
  both `/v1/chat` and `/widget/chat` share the exact same SSE-streaming
  logic with zero duplication.

`/v1/chat`'s current handler inlines the SSE-streaming control flow
(peek the first event to catch `ConversationNotFoundError` before any
stream starts, then yield the rest). `/widget/chat` needs the identical
logic. Extracting it now — before duplicating it — is the right call per
this plan's "DRY without premature abstraction": this isn't a hypothetical
future need, it's needed by the very next route in this same task.

- [ ] **Step 1: Write the failing test**

Add to `src/widget/widget.routes.test.ts` (reuse the `tenantWithPublishableKey`
helper already in the file; add `vi.mock` for `streamText` at the top of
the file exactly as `src/chat/chat.routes.test.ts` already does, since
this route also flows through the real chat model call):

```ts
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
```

(Add these `vi.mock` calls at the very top of the file, above the other
imports, matching `chat.routes.test.ts`'s exact placement — `vi.mock` calls
are hoisted by Vitest regardless of position, but keeping them at the top
matches this project's established convention.)

```ts
describe("POST /widget/chat", () => {
  it("streams a reply for an allowed origin, using a fresh session id", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);
    const { streamText } = await import("ai");
    vi.mocked(streamText).mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", id: "1", text: "Hello" };
        yield { type: "finish", totalUsage: {} };
      })(),
      finalStep: Promise.resolve({ providerMetadata: undefined }),
    } as never);

    const res = await app.inject({
      method: "POST",
      url: "/widget/chat",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com", accept: "text/event-stream" },
      payload: { externalUserId: "visitor-1", message: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: token");
    expect(res.body).toContain("event: done");
  });

  it("rejects a request from a disallowed origin before ever starting a stream", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "POST",
      url: "/widget/chat",
      headers: { authorization: `Bearer ${key}`, origin: "https://evil.example.com" },
      payload: { externalUserId: "visitor-1", message: "hi" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/widget/widget.routes.test.ts`
Expected: FAIL — `/widget/chat` doesn't exist yet (404s).

- [ ] **Step 3: Extract `src/chat/stream-chat-response.ts`**

```ts
import type { FastifyReply } from "fastify";
import { ConversationNotFoundError, runChat, type ChatWireEvent, type RunChatInput } from "./chat.service";

function toSSEFrame(event: ChatWireEvent) {
  return { event: event.event, data: event.data };
}

/**
 * Shared by /v1/chat and /widget/chat — the SSE-streaming control flow is
 * identical for both: peek the first event so a pre-stream failure
 * (ConversationNotFoundError) can still become a plain 404 rather than an
 * SSE `error` event, then stream everything else. See docs/errors.md for
 * why this split matters — once SSE headers are sent, the HTTP status can
 * never change.
 */
export async function streamChatResponse(reply: FastifyReply, input: RunChatInput): Promise<void> {
  const generator = runChat(input);

  let first: IteratorResult<ChatWireEvent>;
  try {
    first = await generator.next();
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      await reply.code(404).send({ error: { code: "not_found", message: "Conversation not found" } });
      return;
    }
    throw err;
  }

  async function* toSSE() {
    if (!first.done) yield toSSEFrame(first.value);
    for await (const event of generator) yield toSSEFrame(event);
  }

  await reply.sse.send(toSSE());
}
```

- [ ] **Step 4: Update `src/chat/chat.routes.ts` to use the shared helper**

Replace the `POST /chat` handler's body. Find this block:

```ts
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
```

Replace it with:

```ts
    async (request, reply) => {
      const { externalUserId, conversationId, message } = request.body;
      await streamChatResponse(reply, {
        tenantId: request.tenant!.id,
        externalUserId,
        conversationId: conversationId ?? null,
        message,
      });
    },
```

Remove the now-unused `toSSEFrame` function and the `ConversationNotFoundError`
import from `chat.routes.ts` (still imported from `./chat.service` if
anything else in the file uses it — check before removing; if
`ConversationNotFoundError` is only referenced in the block you just
deleted, remove its import too). Add the new import:

```ts
import { streamChatResponse } from "./stream-chat-response";
```

- [ ] **Step 5: Confirm `chat.routes.test.ts` still passes unchanged**

Run: `pnpm vitest run src/chat/chat.routes.test.ts`
Expected: PASS, with zero test-file changes — this refactor must be
behavior-preserving. If anything fails, the refactor changed observable
behavior and needs fixing before proceeding, not the test.

- [ ] **Step 6: Implement `POST /widget/chat`**

Modify `src/widget/widget.routes.ts` — add the imports:

```ts
import { chatBody } from "../chat/chat.schema";
import { streamChatResponse } from "../chat/stream-chat-response";
```

And add the route inside the plugin, after `/session`:

```ts
  app.post(
    "/chat",
    {
      schema: {
        operationId: "sendWidgetChat",
        tags: ["Widget"],
        summary: "Send a message from the embeddable widget and receive a streamed reply",
        description:
          "Identical wire contract to POST /v1/chat, authenticated by a publishable key " +
          "instead of a secret key, and restricted to the tenant's allowed origins. See " +
          "docs/errors.md for the pre-stream vs mid-stream error split.",
        security: [{ bearerAuth: [] }],
        body: chatBody,
        response: { 400: errorResponse, 401: errorResponse, 404: errorResponse },
      },
      sse: "only",
    },
    async (request, reply) => {
      const { externalUserId, conversationId, message } = request.body;
      await streamChatResponse(reply, {
        tenantId: request.tenant!.id,
        externalUserId,
        conversationId: conversationId ?? null,
        message,
      });
    },
  );
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run src/widget/widget.routes.test.ts src/chat/chat.routes.test.ts`
Expected: PASS (all tests)

- [ ] **Step 8: Run the full suite**

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/chat/stream-chat-response.ts src/chat/chat.routes.ts src/widget/widget.routes.ts src/widget/widget.routes.test.ts
git commit -m "feat(widget): add POST /widget/chat, sharing chat.routes.ts's SSE streaming logic"
```

---

### Task 5: CLI — issue a publishable key, set the domain allowlist

**Files:**
- Create: `src/scripts/describe-target.ts`
- Modify: `src/scripts/create-tenant.ts`
- Create: `src/scripts/issue-publishable-key.ts`
- Create: `src/scripts/set-allowed-origins.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `getTenantBySlug`, `issueApiKey`, `setAllowedOrigins` from
  `src/tenants/tenants.service.ts` (Tasks 2).
- Produces: `pnpm issue-publishable-key <slug>`,
  `pnpm set-allowed-origins <slug> <origin1> [origin2 ...]` CLI commands.
  Nothing later in this plan depends on these programmatically — they're
  operator tooling, verified by manual invocation (Step 4) rather than an
  automated test, matching `create-tenant.ts`'s own precedent (it has no
  test file either — it's a thin wrapper over already-tested service
  functions).

- [ ] **Step 1: Extract the shared `describeTarget` helper**

Create `src/scripts/describe-target.ts`:

```ts
import { config } from "../config";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Names the database being written to, before writing to it.
 *
 * This is the one place a developer deliberately points at production, and
 * `.env` gives no feedback about which database is live — dotenv silently
 * takes the LAST definition of a duplicated key, so an appended production
 * URL wins over the local one that appears to still be there. Printing the
 * host turns "which database am I about to touch?" into something you can
 * see rather than something you have to reconstruct.
 *
 * Shared by every CLI script in this directory that writes to the database
 * — consolidated here after the second copy so the safety check can't
 * silently drift between scripts.
 */
export function describeTarget(): string {
  const host = new URL(config.DATABASE_URL).hostname;
  return LOCAL_HOSTS.has(host) ? `${host} (local)` : `${host}  ***NOT LOCAL***`;
}
```

Modify `src/scripts/create-tenant.ts` — remove its own `LOCAL_HOSTS`
constant and `describeTarget` function (the first ~14 lines after the
imports), and instead import the shared one:

```ts
import { config } from "../config";
import { client } from "../db";
import { createTenant, issueApiKey } from "../tenants/tenants.service";
import { describeTarget } from "./describe-target";
```

(Drop the `config` import if nothing else in the file uses it directly —
check; `describeTarget` now owns the only use of `config.DATABASE_URL` in
this file.) The rest of `create-tenant.ts` is unchanged.

- [ ] **Step 2: Create `src/scripts/issue-publishable-key.ts`**

```ts
import { client } from "../db";
import { getTenantBySlug, issueApiKey } from "../tenants/tenants.service";
import { describeTarget } from "./describe-target";

async function main(): Promise<void> {
  const [slug] = process.argv.slice(2);
  if (!slug) {
    console.error("Usage: pnpm issue-publishable-key <tenant-slug>");
    process.exit(1);
  }

  console.log(`\nTarget database: ${describeTarget()}`);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`No tenant with slug "${slug}"`);
    process.exit(1);
  }

  const { plaintext } = await issueApiKey(tenant.id, "widget", "publishable");

  console.log(`\nPublishable key issued for: ${tenant.name} (${tenant.slug})`);
  console.log(`Key: ${plaintext}`);
  console.log(
    "\nThis key is safe to embed in a browser — it only works from origins on this",
  );
  console.log("tenant's allowed_origins list. Set that list with:");
  console.log(`  pnpm set-allowed-origins ${tenant.slug} <origin1> [origin2 ...]\n`);

  await client.end();
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Create `src/scripts/set-allowed-origins.ts`**

```ts
import { client } from "../db";
import { getTenantBySlug, setAllowedOrigins } from "../tenants/tenants.service";
import { describeTarget } from "./describe-target";

async function main(): Promise<void> {
  const [slug, ...origins] = process.argv.slice(2);
  if (!slug || origins.length === 0) {
    console.error("Usage: pnpm set-allowed-origins <tenant-slug> <origin1> [origin2 ...]");
    console.error("Example: pnpm set-allowed-origins acme-pharmacy https://acme.com https://www.acme.com");
    process.exit(1);
  }

  console.log(`\nTarget database: ${describeTarget()}`);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`No tenant with slug "${slug}"`);
    process.exit(1);
  }

  await setAllowedOrigins(tenant.id, origins);

  console.log(`\nAllowed origins for ${tenant.name} (${tenant.slug}):`);
  for (const origin of origins) console.log(`  ${origin}`);
  console.log();

  await client.end();
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Add the scripts and verify manually**

Modify `package.json` — add to `"scripts"`:

```json
    "issue-publishable-key": "tsx src/scripts/issue-publishable-key.ts",
    "set-allowed-origins": "tsx src/scripts/set-allowed-origins.ts",
```

Verify against the local database (already running from earlier tasks):

```bash
pnpm create-tenant "Widget Test Co" widget-test-co
pnpm set-allowed-origins widget-test-co http://localhost:3000
pnpm issue-publishable-key widget-test-co
```

Expected: each command prints `Target database: 127.0.0.1 (local)`
(confirming the safety check works for the two new scripts too), and the
final command prints a `pk_live_…` key.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: unchanged — `create-tenant.ts`'s behavior is identical, just its
`describeTarget` implementation moved to a shared file. `pnpm lint` and
`pnpm typecheck` clean too.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/describe-target.ts src/scripts/create-tenant.ts src/scripts/issue-publishable-key.ts src/scripts/set-allowed-origins.ts package.json
git commit -m "feat(cli): add issue-publishable-key and set-allowed-origins"
```

---

### Task 6: The widget bundle

**Files:**
- Create: `widget/src/session.ts`
- Create: `widget/src/ui.ts`
- Create: `widget/src/index.ts`
- Create: `widget/build.mjs`
- Test: `widget/src/session.test.ts`
- Modify: `src/app.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing from earlier tasks directly — this is the browser
  side, talking to `/widget/session` and `/widget/chat` over plain HTTP,
  the same way any external integrator would.
- Produces: `GET /widget.js`, a single dependency-free script a tenant
  embeds via `<script src=".../widget.js" data-key="pk_live_..." ...>`.

`widget/` is a sibling of `src/`, not inside it — this is browser-targeted
code with a different runtime (no Node APIs) and a different build step
(`esbuild`, not `tsc`) than the server, which `tsconfig.build.json`
compiles for Node/CommonJS.

- [ ] **Step 1: Install `esbuild` and `jsdom` as direct dependencies**

```bash
pnpm add -D esbuild jsdom
```

(`esbuild` is already present transitively via other tooling, but this
plan invokes it directly in `build.mjs`, so it needs to be a direct
devDependency rather than relying on whatever version happens to be
hoisted.)

- [ ] **Step 2: Write the failing test for session persistence**

Create `widget/src/session.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateSession } from "./session";

const originalFetch = global.fetch;

afterEach(() => {
  localStorage.clear();
  global.fetch = originalFetch;
});

describe("getOrCreateSession", () => {
  it("calls /widget/session and persists the returned id", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ externalUserId: "session-abc" }),
    })) as unknown as typeof fetch;

    const id = await getOrCreateSession("https://api.example.com", "pk_live_test");

    expect(id).toBe("session-abc");
    expect(localStorage.getItem("ai-chat-widget:externalUserId")).toBe("session-abc");
  });

  it("returns the persisted id on a second call without calling fetch again", async () => {
    localStorage.setItem("ai-chat-widget:externalUserId", "existing-session");
    global.fetch = vi.fn() as unknown as typeof fetch;

    const id = await getOrCreateSession("https://api.example.com", "pk_live_test");

    expect(id).toBe("existing-session");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws with a clear message when the session endpoint rejects the request", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;

    await expect(getOrCreateSession("https://api.example.com", "pk_live_test")).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run widget/src/session.test.ts`
Expected: FAIL — `Cannot find module './session'`

- [ ] **Step 4: Implement `widget/src/session.ts`**

```ts
const STORAGE_KEY = "ai-chat-widget:externalUserId";

/**
 * Mints a session once (server-side, via POST /widget/session) and
 * persists it in localStorage so a returning visitor keeps their
 * conversation history — the same continuity a client-generated UUID
 * would give, just server-minted per the Sprint 4 design.
 */
export async function getOrCreateSession(baseUrl: string, apiKey: string): Promise<string> {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const res = await fetch(`${baseUrl}/widget/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to start a chat session (HTTP ${res.status})`);
  }

  const body = (await res.json()) as { externalUserId: string };
  localStorage.setItem(STORAGE_KEY, body.externalUserId);
  return body.externalUserId;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run widget/src/session.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Implement `widget/src/ui.ts`**

```ts
export type WidgetConfig = {
  color: string;
  position: "bottom-right" | "bottom-left";
};

export type WidgetElements = {
  bubble: HTMLButtonElement;
  panel: HTMLDivElement;
  messageList: HTMLDivElement;
  input: HTMLInputElement;
  form: HTMLFormElement;
};

/** Builds and mounts the widget's DOM, closed by default. Pure DOM — no fetch, no state beyond open/closed. */
export function mountWidget(config: WidgetConfig): WidgetElements {
  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.zIndex = "2147483647";
  root.style[config.position === "bottom-right" ? "right" : "left"] = "20px";
  root.style.bottom = "20px";
  root.style.fontFamily = "system-ui, sans-serif";

  const bubble = document.createElement("button");
  bubble.textContent = "💬";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.style.width = "56px";
  bubble.style.height = "56px";
  bubble.style.borderRadius = "50%";
  bubble.style.border = "none";
  bubble.style.background = config.color;
  bubble.style.color = "#fff";
  bubble.style.fontSize = "24px";
  bubble.style.cursor = "pointer";
  bubble.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)";

  const panel = document.createElement("div");
  panel.style.display = "none";
  panel.style.flexDirection = "column";
  panel.style.width = "320px";
  panel.style.height = "420px";
  panel.style.marginBottom = "12px";
  panel.style.background = "#fff";
  panel.style.borderRadius = "12px";
  panel.style.boxShadow = "0 4px 24px rgba(0,0,0,0.2)";
  panel.style.overflow = "hidden";

  const messageList = document.createElement("div");
  messageList.style.flex = "1";
  messageList.style.overflowY = "auto";
  messageList.style.padding = "12px";

  const form = document.createElement("form");
  form.style.display = "flex";
  form.style.borderTop = "1px solid #e5e5e5";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type a message…";
  input.style.flex = "1";
  input.style.border = "none";
  input.style.padding = "12px";
  input.style.outline = "none";

  form.appendChild(input);
  panel.appendChild(messageList);
  panel.appendChild(form);
  root.appendChild(panel);
  root.appendChild(bubble);
  document.body.appendChild(root);

  bubble.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "flex" : "none";
  });

  return { bubble, panel, messageList, input, form };
}

export function appendMessage(messageList: HTMLDivElement, role: "user" | "assistant", text: string): HTMLDivElement {
  const bubble = document.createElement("div");
  bubble.textContent = text;
  bubble.style.margin = "6px 0";
  bubble.style.padding = "8px 12px";
  bubble.style.borderRadius = "12px";
  bubble.style.maxWidth = "80%";
  bubble.style.whiteSpace = "pre-wrap";
  if (role === "user") {
    bubble.style.marginLeft = "auto";
    bubble.style.background = "#e5e5ea";
  } else {
    bubble.style.background = "#f0f0f5";
  }
  messageList.appendChild(bubble);
  messageList.scrollTop = messageList.scrollHeight;
  return bubble;
}
```

- [ ] **Step 7: Implement `widget/src/index.ts`**

```ts
import { getOrCreateSession } from "./session";
import { appendMessage, mountWidget } from "./ui";

type ChatSSEEvent = { event: string; data: unknown };

/**
 * Minimal SSE frame parser for a fetch ReadableStream — browsers have no
 * built-in way to POST with a body and custom headers while consuming an
 * SSE response (EventSource only supports GET, no custom headers), so this
 * parses the same "event: x\ndata: y\n\n" wire format server.ts/chat
 * already produces, by hand.
 */
async function* parseSSE(response: Response): AsyncGenerator<ChatSSEEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (data) yield { event, data: JSON.parse(data) as unknown };
    }
  }
}

function init(): void {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  const apiKey = script.dataset.key;
  if (!apiKey) {
    console.error("[ai-chat-widget] missing data-key attribute on the embed script tag");
    return;
  }

  const baseUrl = new URL(script.src).origin;
  const color = script.dataset.color ?? "#4f46e5";
  const position = script.dataset.position === "bottom-left" ? "bottom-left" : "bottom-right";

  const { messageList, input, form } = mountWidget({ color, position });

  let conversationId: string | null = null;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    void sendMessage(message);
  });

  async function sendMessage(message: string): Promise<void> {
    appendMessage(messageList, "user", message);
    const assistantBubble = appendMessage(messageList, "assistant", "");

    try {
      const externalUserId = await getOrCreateSession(baseUrl, apiKey!);

      const res = await fetch(`${baseUrl}/widget/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ externalUserId, conversationId, message }),
      });

      if (!res.ok || !res.body) {
        assistantBubble.textContent = "Sorry, something went wrong.";
        return;
      }

      for await (const frame of parseSSE(res)) {
        if (frame.event === "token") {
          assistantBubble.textContent += (frame.data as { text: string }).text;
          messageList.scrollTop = messageList.scrollHeight;
        } else if (frame.event === "done") {
          conversationId = (frame.data as { conversationId: string }).conversationId;
        } else if (frame.event === "error") {
          assistantBubble.textContent = "Sorry, something went wrong.";
        }
      }
    } catch {
      assistantBubble.textContent = "Sorry, something went wrong.";
    }
  }
}

init();
```

- [ ] **Step 8: Write `widget/build.mjs`**

```js
import { build } from "esbuild";

await build({
  entryPoints: ["widget/src/index.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: "widget-dist/widget.js",
  minify: process.env.NODE_ENV === "production",
});

console.log("Built widget-dist/widget.js");
```

- [ ] **Step 9: Wire the build and serve the bundle**

Modify `.gitignore` — add:

```
widget-dist/
```

Modify `package.json` — update the `"build"` script to also build the
widget, and add a standalone script for iterating on just the widget:

```json
    "build": "tsc -p tsconfig.build.json && node widget/build.mjs",
    "build:widget": "node widget/build.mjs",
```

Run it once now so the file exists for the next step:

```bash
pnpm build:widget
```

Modify `src/app.ts` — add the imports:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
```

Add a lazily-cached read and the route, near the existing `/openapi.json`
route:

```ts
  let widgetScriptCache: string | null = null;
  function getWidgetScript(): string {
    // Lazy, not module-load-time: this file only exists after `pnpm
    // build:widget` has run, and route tests that never touch this
    // endpoint shouldn't fail to import app.ts just because that build
    // step hasn't happened yet in their environment.
    widgetScriptCache ??= readFileSync(join(__dirname, "../widget-dist/widget.js"), "utf8");
    return widgetScriptCache;
  }

  app.get("/widget.js", { schema: { hide: true } }, async (_request, reply) => {
    return reply
      .type("application/javascript")
      .header("Cache-Control", "public, max-age=3600")
      .send(getWidgetScript());
  });
```

- [ ] **Step 10: Verify manually**

```bash
pnpm dev
```

In another terminal:

```bash
curl -s http://localhost:4000/widget.js | head -c 200
```

Expected: minified/bundled JavaScript output (not an error), starting
with something like `(()=>{` (the IIFE wrapper).

- [ ] **Step 11: Run the full suite**

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Expected: all green — `pnpm build` now also runs `widget/build.mjs`,
confirming the widget bundle builds cleanly as part of the standard build.

- [ ] **Step 12: Commit**

```bash
git add widget/ src/app.ts package.json .gitignore
git commit -m "feat(widget): add the embeddable widget bundle, served at GET /widget.js"
```

---

### Task 7: Documentation

**Files:**
- Create: `docs/embeddable-widget.md`
- Modify: `docs/authentication.md`

- [ ] **Step 1: Write `docs/embeddable-widget.md`**

```markdown
# Embeddable widget

Paste one `<script>` tag onto any page and get a working chat bubble,
backed by this service's chat engine.

## Quick start

\`\`\`bash
pnpm create-tenant "Acme Pharmacy" acme-pharmacy
pnpm set-allowed-origins acme-pharmacy https://acme.com https://www.acme.com
pnpm issue-publishable-key acme-pharmacy
\`\`\`

Paste the printed key into a script tag on your page:

\`\`\`html
<script src="https://your-instance/widget.js"
        data-key="pk_live_..."
        data-color="#4f46e5"
        data-position="bottom-right"></script>
\`\`\`

That's it — a chat bubble appears, backed by whatever documents and
custom tools you've already configured for this tenant.

## Publishable vs. secret keys

A **publishable** key (`pk_live_…`) is meant to be public — it's going to
sit in your page's HTML source, visible to anyone who views it, exactly
like a Stripe publishable key or a Google Maps API key. That's by design,
not an oversight: the security boundary isn't secrecy of the key, it's the
**domain allowlist** you set with \`pnpm set-allowed-origins\`. A
publishable key only works from a browser sending one of those origins as
its \`Origin\` header — copy the key into a request from anywhere else and
it's rejected, regardless of how the key was obtained.

A publishable key also cannot read or write documents, register custom
tools, or do anything a secret key can — it only works against the two
\`/widget/*\` routes. Never put a **secret** key (\`sk_live_…\`) anywhere a
browser can see it; that one really is a secret. See
[authentication.md](authentication.md) for the full contrast.

## Customization

Read from attributes on the widget's own script tag — no dashboard, no
separate configuration step:

| Attribute | Default | Notes |
|---|---|---|
| `data-key` | — | Required. Your `pk_live_…` key. |
| `data-color` | `#4f46e5` | Bubble and accent color, any valid CSS color. |
| `data-position` | `bottom-right` | `bottom-right` or `bottom-left`. |

## How it works

- The widget mints a session once (`POST /widget/session`) and persists
  the returned id in `localStorage`, so a returning visitor keeps their
  conversation history across page loads.
- Every message goes to `POST /widget/chat` — the exact same SSE wire
  contract as `POST /v1/chat` (see [errors.md](errors.md)), just
  authenticated by the publishable key and restricted to allowed origins
  instead of a secret key.
- CORS is configured per-request based on your tenant's allowed origins,
  but that's only what lets a browser *read* the response — the actual
  authorization check happens server-side on every request, independent
  of CORS, so a copied key still can't be used from an unauthorized origin
  even by a non-browser client that ignores CORS entirely.

## What's not here yet

No dashboard for managing keys or origins visually — everything above is
CLI-driven for now. No color-scheme presets, no custom CSS injection, no
avatar/logo upload. A tenant dashboard is a later sprint.
```

- [ ] **Step 2: Add a cross-reference in `docs/authentication.md`**

Read the current file first (`docs/authentication.md`) to find where
secret keys are introduced, and add a short section after it — the exact
insertion point depends on the file's current structure, but the content
to add is:

```markdown
## Publishable keys

Sprint 4 adds a second key type, `pk_live_…`, for the [embeddable
widget](embeddable-widget.md). Unlike the secret keys above, a publishable
key is meant to be public — it's restricted by a per-tenant domain
allowlist instead of by secrecy, and it cannot access any `/v1/*` route
(documents, search, tools, or the secret-key chat endpoint). See
[embeddable-widget.md](embeddable-widget.md) for the full explanation and
setup steps.
```

- [ ] **Step 3: Verify the OpenAPI coverage test already passes**

Run: `pnpm vitest run` (the full suite) — the existing test asserting
every `/v1` route appears in the generated spec should be unaffected
(`/widget/*` routes are a different prefix, not `/v1`, so they're outside
that specific test's scope by design — this is expected, not a gap: the
widget routes are documented in `docs/embeddable-widget.md` and carry
their own OpenAPI schema blocks for `GET /docs`/`GET /openapi.json`, they
just aren't asserted by the `/v1`-specific coverage test).

- [ ] **Step 4: Commit**

```bash
git add docs/embeddable-widget.md docs/authentication.md
git commit -m "docs: add embeddable widget guide and publishable-key cross-reference"
```

---

## Verification

**Automated** — `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test`
all green. The tests that matter most for this sprint's exit gate:

- `widget.routes.test.ts`'s "/v1 routes reject publishable keys" and "a
  publishable key on /widget/session... [rejects a secret key]" — prove
  a publishable key cannot read/write documents (and a secret key cannot
  use the widget routes), directly from the exit gate's wording.
- `widget.routes.test.ts`'s origin-allowlist tests, especially the one
  asserting `Access-Control-Allow-Origin` is neither `*` nor the
  disallowed origin — proves the domain allowlist actually blocks a
  disallowed origin, both at the CORS layer and (via the 401 tests) at
  the real authorization layer.

**Manual, against a locally running service:**

```bash
pnpm db:reset && pnpm build:widget && pnpm dev
```

```bash
pnpm create-tenant "Acme" acme
pnpm set-allowed-origins acme http://localhost:5500
pnpm issue-publishable-key acme
```

Create a throwaway `test.html` anywhere, serve it on `localhost:5500`
(e.g. `npx serve -l 5500`), with:

```html
<script src="http://localhost:4000/widget.js" data-key="pk_live_...">
</script>
```

Open it in a browser, confirm the bubble appears, click it, send a
message, and confirm a reply streams in. Then change the served port to
anything else (so the origin no longer matches) and confirm the widget's
`fetch` calls fail (visible as a CORS error in the browser console, and a
401 in the Network tab) rather than silently working.
