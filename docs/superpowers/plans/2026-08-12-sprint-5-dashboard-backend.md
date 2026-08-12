# Sprint 5 Backend (Tenant Dashboard API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/dashboard/*` API to `ai-chat-service` that lets a tenant sign up, manage documents, manage secret keys, configure the Sprint 4 widget, and view usage — all authenticated by a Supabase Auth session instead of an API key.

**Architecture:** A new `dashboardAuthPlugin` verifies a Supabase-issued session token (via `supabase-js`'s `auth.getUser`) and resolves the caller's Supabase user id onto the request. A second, per-route preHandler (`requireDashboardTenant`) resolves that user id to a `tenants` row via a new `owner_user_id` column, mirroring how `authPlugin`/`publishableAuthPlugin` resolve a tenant from an API key. New route files under `src/dashboard/` are thin wrappers over existing (or lightly extended) service functions — no service-layer logic is duplicated.

**Tech Stack:** Fastify 5, Drizzle ORM, Zod (`fastify-type-provider-zod`), Vitest, `@supabase/supabase-js` (new dependency).

## Global Constraints

- **Tenant id comes only from `request.tenant.id`, resolved server-side** — never from a request body, query param, or path segment. This is Sprint 1's foundational invariant and applies identically here.
- **`fp`-wrapped auth plugins may safely `decorateRequest` the same property name (`tenant`) on sibling scopes.** Verified empirically in Sprint 4: `authPlugin` (on `/v1`) and `publishableAuthPlugin` (on `/widget`) both decorate `request.tenant` with no `FST_ERR_DEC_ALREADY_PRESENT` collision, because Fastify's decorator-collision check only walks a scope's own ancestor chain, and `/v1` and `/widget` are true siblings under the root. `dashboardAuthPlugin` on a third sibling scope (`/dashboard`) is expected to be equally safe by the same mechanism — no new verification needed, but if `FST_ERR_DEC_ALREADY_PRESENT` is somehow thrown at boot, that assumption was wrong and needs re-investigating before working around it.
- **`@fastify/cors` may only be registered once, app-wide**, via the single delegator already in `src/app.ts`. A second `.register(fastifyCors, ...)` anywhere in the app throws `FST_ERR_DEC_ALREADY_PRESENT` (see that registration's own comment for the full explanation). The `/dashboard` CORS branch this plan adds goes inside the *existing* delegator function, not a new registration.
- **API keys are SHA-256 hashed at rest and never stored reversibly.** A minted secret or publishable key is returned to the caller exactly once, at issuance. No new code path may store or re-display a raw key after that.
- **A new required config var breaks every test and CI until it's added to `config.test.ts`'s `valid` fixture and `.github/workflows/ci.yml`'s `env:` block.** Both files must be updated in the same task that adds the var.
- **Every `/dashboard/*` error response uses the existing `{ error: { code, message } }` shape** (Zod schema: `errorResponse` in `src/documents/documents.schema.ts`, reused directly — no new error schema).

---

## File Structure

**New files:**
- `src/lib/supabase.ts` — `verifySupabaseToken(token)`, wrapping a module-level `supabase-js` client.
- `src/plugins/dashboard-auth.ts` — `dashboardAuthPlugin` (decorates `request.dashboardUserId`) + exported `requireDashboardTenant` preHandler (decorates `request.tenant`).
- `src/plugins/dashboard-auth.test.ts`
- `src/dashboard/dashboard.schema.ts` — every Zod schema for `/dashboard/*`.
- `src/dashboard/tenant.routes.ts` — `GET /tenant`, `POST /signup`.
- `src/dashboard/tenant.routes.test.ts`
- `src/dashboard/documents.routes.ts` — `GET`/`PUT`/`DELETE /documents`, wrapping `documents.service.ts`.
- `src/dashboard/documents.routes.test.ts`
- `src/dashboard/keys.routes.ts` — `GET`/`POST /keys`, `DELETE /keys/:id`.
- `src/dashboard/keys.routes.test.ts`
- `src/dashboard/widget.routes.ts` — `GET /widget`, `POST /widget/publishable-key`, `PUT /widget/origins`. (Widget *configuration* management — not to be confused with `src/widget/widget.routes.ts`, the Sprint 4 file serving the actual `/widget/*` chat endpoints.)
- `src/dashboard/widget.routes.test.ts`
- `src/dashboard/usage.service.ts` — `getUsageSummary(tenantId, days)`.
- `src/dashboard/usage.service.test.ts`
- `src/dashboard/usage.routes.ts` — `GET /usage`.
- `src/dashboard/usage.routes.test.ts`
- `docs/dashboard-api.md` — guide for the new API surface.

**Modified files:**
- `src/db/schema.ts` — add `ownerUserId` to `tenants`.
- `src/config/index.ts` — add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DASHBOARD_URL`.
- `src/config/config.test.ts` — extend the `valid` fixture, add `DASHBOARD_URL` tests.
- `.github/workflows/ci.yml` — add the two new required vars.
- `src/tenants/tenants.service.ts` — add `getTenantByOwnerUserId`, widen `createTenant`'s input type, add `listApiKeys`, re-scope `revokeApiKey` to `(tenantId, keyId)`.
- `src/tenants/tenants.service.test.ts` — update the one call site using `revokeApiKey`'s old signature, add new tests.
- `src/documents/documents.routes.ts` — export `toPublicDocument` and `toIso` so `src/dashboard/documents.routes.ts` can reuse them without duplicating the timestamp-normalization logic.
- `src/app.ts` — register `/dashboard` prefix scope; add the CORS delegator's third branch.
- `src/app.openapi.test.ts` — not modified (stays `/v1`-scoped; this plan adds its own `/dashboard`-scoped equivalent instead, see Task 9).
- `package.json` — add `@supabase/supabase-js`.

---

### Task 1: `tenants.owner_user_id` schema + Supabase/dashboard config vars

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/config/index.ts`
- Modify: `src/config/config.test.ts`
- Modify: `.github/workflows/ci.yml`
- Create (via `pnpm db:generate`): a new file under `supabase/migrations/`

**Interfaces:**
- Produces: `tenants.ownerUserId: string | null` (Drizzle column, exposed on the `Tenant` type already exported from `src/db/schema.ts`).
- Produces: `config.SUPABASE_URL: string`, `config.SUPABASE_ANON_KEY: string`, `config.DASHBOARD_URL: string | undefined`.

- [ ] **Step 1: Add `ownerUserId` to the `tenants` table**

In `src/db/schema.ts`, add the column to the existing `tenants` table definition:

```ts
export const tenants = pgTable("tenants", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  ownerUserId: uuid("owner_user_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});
```

Nullable and unique-but-not-required: existing CLI-created tenants have no owner, and a tenant can have at most one dashboard owner.

- [ ] **Step 2: Generate and apply the migration**

Run: `pnpm db:generate`
Expected: a new timestamped file appears under `supabase/migrations/` containing `alter table "tenants" add column "owner_user_id" uuid; alter table "tenants" add constraint ... unique("owner_user_id");` (exact wording may vary — confirm it adds the column and a unique constraint, nothing else).

Run: `pnpm db:reset` (applies every migration to the local Supabase instance from scratch)
Expected: completes with no errors.

- [ ] **Step 3: Add the three new config vars**

In `src/config/index.ts`, add to `baseConfigSchema` (after `TOOL_SECRETS_ENCRYPTION_KEY`):

```ts
  // Used by src/lib/supabase.ts to verify a dashboard session token via
  // supabase-js's auth.getUser() — never a service-role secret, just the
  // project's public anon key.
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_ANON_KEY: z.string().min(1, "SUPABASE_ANON_KEY is required"),
  // The deployed dashboard's origin, allowed through CORS on /dashboard/*
  // (see src/app.ts's CORS delegator). Optional because local development
  // without a dashboard running yet is a valid state — that branch also
  // always allows http://localhost:5173 outside production.
  DASHBOARD_URL: z.string().url("DASHBOARD_URL must be a valid URL").optional(),
```

- [ ] **Step 4: Update `config.test.ts`'s fixture and add `DASHBOARD_URL` tests**

In `src/config/config.test.ts`, add the two new required keys to `valid`:

```ts
const valid = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
  VOYAGE_API_KEY: "pa-test-key",
  VOYAGE_EMBEDDING_MODEL: "voyage-3",
  PORT: "4000",
  NODE_ENV: "test",
  OPENROUTER_API_KEY: "or-test-key",
  TOOL_SECRETS_ENCRYPTION_KEY: "3eafa276356c2bcb2f139410c731b4da88aeca1b487b9544fae4b712a5d5a477",
  SUPABASE_URL: "https://test-project.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
};
```

Add a new `describe` block after the `PUBLIC_URL` block:

```ts
describe("DASHBOARD_URL", () => {
  it("is undefined when absent", () => {
    expect(parseConfig(valid).DASHBOARD_URL).toBeUndefined();
  });

  it("accepts a valid URL", () => {
    const config = parseConfig({ ...valid, DASHBOARD_URL: "https://dashboard.example.com" });
    expect(config.DASHBOARD_URL).toBe("https://dashboard.example.com");
  });

  it("rejects a non-URL value", () => {
    expect(() => parseConfig({ ...valid, DASHBOARD_URL: "not a url" })).toThrow(/DASHBOARD_URL/);
  });
});
```

Also add one assertion to the existing `"throws a readable error naming the missing variable"` test's neighborhood — add a new test:

```ts
it("requires SUPABASE_URL", () => {
  const { SUPABASE_URL: _s, ...rest } = valid;
  expect(() => parseConfig(rest)).toThrow(/SUPABASE_URL/);
});
```

- [ ] **Step 5: Run the config tests**

Run: `pnpm vitest run src/config/config.test.ts`
Expected: all pass.

- [ ] **Step 6: Add the two required vars to CI**

In `.github/workflows/ci.yml`, add to the `env:` block (after `NODE_ENV: test`):

```yaml
      # Throwaway values, not secrets — every test mocks supabase-js's
      # auth.getUser(), so this project is never actually contacted.
      SUPABASE_URL: https://ci-test.supabase.co
      SUPABASE_ANON_KEY: ci-test-anon-key
```

- [ ] **Step 7: Run the full test suite locally to confirm nothing else broke**

Run: `pnpm test`
Expected: all existing tests still pass (the new config vars are additive; no other test reads them yet).

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/config/index.ts src/config/config.test.ts .github/workflows/ci.yml supabase/migrations/
git commit -m "feat(dashboard): add tenants.owner_user_id and Supabase/dashboard config vars"
```

---

### Task 2: Supabase token verification (`src/lib/supabase.ts`)

**Files:**
- Create: `src/lib/supabase.ts`
- Create: `src/lib/supabase.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `config.SUPABASE_URL`, `config.SUPABASE_ANON_KEY` (Task 1).
- Produces: `verifySupabaseToken(token: string): Promise<{ id: string; email: string | null } | null>` — `null` for any invalid/expired/malformed token, never throws.

- [ ] **Step 1: Add the dependency**

Run: `pnpm add @supabase/supabase-js`
Expected: `package.json` and `pnpm-lock.yaml` update.

- [ ] **Step 2: Write the failing test**

Create `src/lib/supabase.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: getUserMock } })),
}));

describe("verifySupabaseToken", () => {
  it("returns the user's id and email for a valid token", async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: { id: "user-123", email: "owner@acme.com" } },
      error: null,
    });

    const { verifySupabaseToken } = await import("./supabase");
    const result = await verifySupabaseToken("valid-token");

    expect(result).toEqual({ id: "user-123", email: "owner@acme.com" });
  });

  it("returns null when Supabase reports an error", async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "invalid JWT" },
    });

    const { verifySupabaseToken } = await import("./supabase");
    expect(await verifySupabaseToken("bad-token")).toBeNull();
  });

  it("returns null if the underlying call throws", async () => {
    getUserMock.mockRejectedValueOnce(new Error("network error"));

    const { verifySupabaseToken } = await import("./supabase");
    expect(await verifySupabaseToken("whatever")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/supabase.test.ts`
Expected: FAIL — `Cannot find module './supabase'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/supabase.ts`:

```ts
import { createClient } from "@supabase/supabase-js";
import { config } from "../config";

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);

/**
 * Verifies a client-issued Supabase session token by asking Supabase's own
 * auth server, rather than validating a JWT signature locally — this is
 * the officially recommended pattern for a backend verifying a token it
 * did not issue, and it works identically for password and magic-link
 * sessions with no JWT-secret/JWKS management on our side.
 *
 * Never throws: any failure (invalid token, expired session, network
 * error) is treated as "not authenticated" rather than propagating an
 * exception into the caller's preHandler.
 */
export async function verifySupabaseToken(
  token: string,
): Promise<{ id: string; email: string | null } | null> {
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/supabase.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/supabase.ts src/lib/supabase.test.ts
git commit -m "feat(dashboard): add Supabase session-token verification"
```

---

### Task 3: Tenant service additions

**Files:**
- Modify: `src/tenants/tenants.service.ts`
- Modify: `src/tenants/tenants.service.test.ts`

**Interfaces:**
- Consumes: `Tenant` type, `apiKeys`/`tenants` tables (`src/db/schema.ts`).
- Produces:
  - `getTenantByOwnerUserId(ownerUserId: string): Promise<Tenant | null>`
  - `createTenant(input: { name: string; slug: string; ownerUserId?: string }): Promise<Tenant>` (widened from `{ name, slug }`)
  - `listApiKeys(tenantId: string): Promise<Array<{ id: string; name: string; keyPrefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }>>`
  - `revokeApiKey(tenantId: string, keyId: string): Promise<boolean>` (changed from `revokeApiKey(keyId: string): Promise<void>` — returns `true` iff a key matching both `tenantId` and `keyId` was found)

- [ ] **Step 1: Write the failing tests**

In `src/tenants/tenants.service.test.ts`, first fix the existing broken call site — change line 64 from `await revokeApiKey(row!.id);` to `await revokeApiKey(tenant.id, row!.id);`.

Then add these new `describe` blocks at the end of the file, before the final closing (keep the existing `import` line — just add `getTenantByOwnerUserId` and `listApiKeys` to it):

```ts
import {
  createTenant,
  flushApiKeyTouches,
  getTenantByOwnerUserId,
  getTenantBySlug,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  setAllowedOrigins,
  verifyApiKey,
  verifyPublishableApiKey,
} from "./tenants.service";
```

```ts
describe("createTenant with ownerUserId", () => {
  it("stores the owner", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });
    expect(tenant.ownerUserId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("still creates a tenant with no owner (the CLI path)", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    expect(tenant.ownerUserId).toBeNull();
  });
});

describe("getTenantByOwnerUserId", () => {
  it("returns the tenant owned by that user", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });
    expect((await getTenantByOwnerUserId("00000000-0000-0000-0000-000000000001"))?.id).toBe(tenant.id);
  });

  it("returns null when no tenant has that owner", async () => {
    expect(await getTenantByOwnerUserId("no-such-user")).toBeNull();
  });
});

describe("listApiKeys", () => {
  it("lists a tenant's keys without the hash", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await issueApiKey(tenant.id, "default");
    await issueApiKey(tenant.id, "ci");

    const keys = await listApiKeys(tenant.id);

    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.name).sort()).toEqual(["ci", "default"]);
    expect(keys[0]).not.toHaveProperty("keyHash");
  });

  it("never lists another tenant's keys", async () => {
    const tenantA = await createTenant({ name: "A", slug: "a" });
    const tenantB = await createTenant({ name: "B", slug: "b" });
    await issueApiKey(tenantA.id, "default");

    expect(await listApiKeys(tenantB.id)).toHaveLength(0);
  });
});

describe("revokeApiKey (tenant-scoped)", () => {
  it("revokes a key belonging to the tenant and returns true", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");
    const keys = await listApiKeys(tenant.id);

    const result = await revokeApiKey(tenant.id, keys[0]!.id);

    expect(result).toBe(true);
    expect(await verifyApiKey(plaintext)).toBeNull();
  });

  it("returns false and does not revoke another tenant's key", async () => {
    const tenantA = await createTenant({ name: "A", slug: "a" });
    const tenantB = await createTenant({ name: "B", slug: "b" });
    const { plaintext } = await issueApiKey(tenantA.id, "default");
    const keys = await listApiKeys(tenantA.id);

    const result = await revokeApiKey(tenantB.id, keys[0]!.id);

    expect(result).toBe(false);
    expect(await verifyApiKey(plaintext)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/tenants/tenants.service.test.ts`
Expected: FAIL — `getTenantByOwnerUserId`/`listApiKeys` are not exported, and the existing revoke test now fails on the wrong call signature.

- [ ] **Step 3: Implement**

In `src/tenants/tenants.service.ts`:

Widen `createTenant`'s input type (no body change needed — `db.insert(tenants).values(input)` already accepts any subset of insertable columns):

```ts
export async function createTenant(input: {
  name: string;
  slug: string;
  ownerUserId?: string;
}): Promise<Tenant> {
  const [tenant] = await db.insert(tenants).values(input).returning();
  return tenant!;
}
```

Add after `getTenantBySlug`:

```ts
export async function getTenantByOwnerUserId(ownerUserId: string): Promise<Tenant | null> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.ownerUserId, ownerUserId));
  return tenant ?? null;
}
```

Add after `issueApiKey`:

```ts
export async function listApiKeys(tenantId: string): Promise<
  Array<{
    id: string;
    name: string;
    keyPrefix: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }>
> {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId));
}
```

Replace `revokeApiKey`:

```ts
/**
 * Tenant-scoped: the WHERE clause requires both tenantId and keyId to
 * match, so a caller can never revoke another tenant's key by id alone —
 * the dashboard route that calls this only ever knows its own
 * request.tenant.id, never another tenant's.
 */
export async function revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)))
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/tenants/tenants.service.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run the full suite** (this function's old signature might be referenced elsewhere)

Run: `pnpm test`
Expected: all pass. `pnpm typecheck` also clean.

- [ ] **Step 6: Commit**

```bash
git add src/tenants/tenants.service.ts src/tenants/tenants.service.test.ts
git commit -m "feat(dashboard): add owner-scoped tenant lookup, key listing, and tenant-scoped key revocation"
```

---

### Task 4: `dashboardAuthPlugin` + `requireDashboardTenant` + `/dashboard` wiring + `GET /tenant` + `POST /signup`

**Files:**
- Create: `src/plugins/dashboard-auth.ts`
- Create: `src/plugins/dashboard-auth.test.ts`
- Create: `src/dashboard/dashboard.schema.ts`
- Create: `src/dashboard/tenant.routes.ts`
- Create: `src/dashboard/tenant.routes.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `verifySupabaseToken` (Task 2), `getTenantByOwnerUserId`/`createTenant`/`issueApiKey` (Task 3), `errorResponse` (`src/documents/documents.schema.ts`).
- Produces:
  - `request.dashboardUserId: string | null` (decorated by `dashboardAuthPlugin`)
  - `requireDashboardTenant(request, reply): Promise<void>` — a plain async preHandler function, exported for reuse by every later task's routes. Sets `request.tenant`; sends a 404 and returns early if none exists.
  - `signupBody`, `tenantResponse`, `signupResponse` (Zod schemas in `dashboard.schema.ts`, reused by later tasks' schema file for consistency of style — not imported elsewhere).

- [ ] **Step 1: Write the failing plugin test**

Create `src/plugins/dashboard-auth.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";

const verifySupabaseTokenMock = vi.fn();

vi.mock("../lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

let app: FastifyInstance;

beforeEach(async () => {
  await clean();
  vi.clearAllMocks();

  const { default: dashboardAuthPlugin, requireDashboardTenant } = await import("./dashboard-auth");

  app = Fastify();
  await app.register(
    async (dashboard) => {
      await dashboard.register(dashboardAuthPlugin);
      dashboard.get("/whoami", async (request) => ({ userId: request.dashboardUserId }));
      dashboard.get(
        "/tenant-only",
        { preHandler: requireDashboardTenant },
        async (request) => ({ tenantId: request.tenant!.id }),
      );
    },
    { prefix: "/dashboard" },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

describe("dashboardAuthPlugin", () => {
  it("resolves a valid token to a dashboardUserId", async () => {
    verifySupabaseTokenMock.mockResolvedValueOnce({ id: "00000000-0000-0000-0000-000000000001", email: "a@b.com" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/whoami",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/whoami" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects an invalid token", async () => {
    verifySupabaseTokenMock.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/whoami",
      headers: { authorization: "Bearer bad-token" },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("requireDashboardTenant", () => {
  it("resolves the tenant owned by the authenticated user", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });
    verifySupabaseTokenMock.mockResolvedValueOnce({ id: "00000000-0000-0000-0000-000000000001", email: "a@b.com" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant-only",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tenantId).toBe(tenant.id);
  });

  it("returns 404 when the authenticated user has no tenant", async () => {
    verifySupabaseTokenMock.mockResolvedValueOnce({ id: "00000000-0000-0000-0000-000000000099", email: "a@b.com" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant-only",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/plugins/dashboard-auth.test.ts`
Expected: FAIL — `Cannot find module './dashboard-auth'`.

- [ ] **Step 3: Write `dashboardAuthPlugin`**

Create `src/plugins/dashboard-auth.ts`:

```ts
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { verifySupabaseToken } from "../lib/supabase";
import { getTenantByOwnerUserId } from "../tenants/tenants.service";

declare module "fastify" {
  interface FastifyRequest {
    dashboardUserId: string | null;
  }
}

/**
 * Verifies a Supabase session token and pins the caller's Supabase user id
 * on the request. Deliberately does NOT resolve a tenant here — GET
 * /dashboard/tenant and POST /dashboard/signup are the only two routes
 * that must run before a tenant necessarily exists, so tenant resolution
 * is a separate, per-route preHandler (requireDashboardTenant, below)
 * rather than part of this scope-wide hook.
 *
 * Also decorates `tenant` (defaulting to null) even though this plugin's
 * own preHandler never sets it — decoration and assignment are separate
 * concerns in Fastify, and `requireDashboardTenant` (a plain function,
 * not its own `fp`-wrapped plugin) has nowhere else to declare it. `tenant`
 * is also decorated by authPlugin (/v1) and publishableAuthPlugin
 * (/widget) on their own sibling scopes — safe by the same mechanism
 * documented on those two decorateRequest calls.
 */
const dashboardAuthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("dashboardUserId", null);
  fastify.decorateRequest("tenant", null);

  fastify.addHook("preHandler", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Missing Bearer session token" } });
    }

    const user = await verifySupabaseToken(header.slice("Bearer ".length).trim());
    if (!user) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Invalid or expired session" } });
    }

    request.dashboardUserId = user.id;
  });
};

export default fp(dashboardAuthPlugin, { name: "dashboard-auth" });

/**
 * A per-route preHandler (passed via route options, not scope-wide) for
 * every /dashboard route except GET /tenant and POST /signup. Resolves
 * request.tenant from the already-verified dashboardUserId, or ends the
 * request with 404 if this account has no tenant yet.
 */
export async function requireDashboardTenant(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const tenant = await getTenantByOwnerUserId(request.dashboardUserId!);
  if (!tenant) {
    await reply
      .code(404)
      .send({ error: { code: "not_found", message: "No tenant found for this account" } });
    return;
  }
  request.tenant = tenant;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/plugins/dashboard-auth.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Write the schema file**

Create `src/dashboard/dashboard.schema.ts`:

```ts
import { z } from "zod";

export const signupBody = z.object({
  tenantName: z.string().min(1).max(255),
  tenantSlug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, and hyphens only"),
});

export const tenantResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
});

export const signupResponse = z.object({
  tenant: tenantResponse,
  apiKey: z.object({
    plaintext: z.string().describe("Shown exactly once — store it now, it cannot be retrieved again."),
    prefix: z.string(),
  }),
});
```

- [ ] **Step 6: Write the failing route test**

Create `src/dashboard/tenant.routes.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { buildApp } from "../app";

const verifySupabaseTokenMock = vi.fn();

vi.mock("../lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

let app: FastifyInstance;

beforeEach(async () => {
  await clean();
  vi.clearAllMocks();
  app = buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

function auth(userId: string) {
  verifySupabaseTokenMock.mockResolvedValueOnce({ id: userId, email: "owner@acme.com" });
  return { authorization: "Bearer valid-token" };
}

describe("GET /dashboard/tenant", () => {
  it("returns the tenant owned by the authenticated user", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(tenant.id);
    expect(res.json().data.slug).toBe("acme");
  });

  it("returns 404 when this user has no tenant yet", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant",
      headers: auth("00000000-0000-0000-0000-000000000099"),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /dashboard/signup", () => {
  it("creates a tenant and mints a default secret key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/dashboard/signup",
      headers: auth("00000000-0000-0000-0000-000000000002"),
      payload: { tenantName: "New Co", tenantSlug: "new-co" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.tenant.slug).toBe("new-co");
    expect(body.apiKey.plaintext).toMatch(/^sk_live_/);
  });

  it("returns 409 when this user already has a tenant", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/signup",
      headers: auth("00000000-0000-0000-0000-000000000001"),
      payload: { tenantName: "Second Co", tenantSlug: "second-co" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when the slug is already taken by a different owner", async () => {
    await createTenant({ name: "Acme", slug: "taken-slug" });

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/signup",
      headers: auth("00000000-0000-0000-0000-000000000002"),
      payload: { tenantName: "New Co", tenantSlug: "taken-slug" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("rejects an uppercase slug", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/dashboard/signup",
      headers: auth("00000000-0000-0000-0000-000000000002"),
      payload: { tenantName: "New Co", tenantSlug: "New-Co" },
    });

    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/dashboard/tenant.routes.test.ts`
Expected: FAIL — `/dashboard/tenant` and `/dashboard/signup` don't exist yet (404 from the app's own not-found handler, not the assertions above).

- [ ] **Step 8: Write the routes**

Create `src/dashboard/tenant.routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Tenant } from "../db/schema";
import { errorResponse } from "../documents/documents.schema";
import { createTenant, getTenantByOwnerUserId, issueApiKey } from "../tenants/tenants.service";
import { signupBody, signupResponse, tenantResponse } from "./dashboard.schema";

function toPublicTenant(tenant: Tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    createdAt: new Date(tenant.createdAt).toISOString(),
  };
}

const tenantRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/tenant",
    {
      schema: {
        operationId: "getDashboardTenant",
        tags: ["Dashboard"],
        summary: "The tenant owned by the authenticated dashboard user",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: tenantResponse }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const tenant = await getTenantByOwnerUserId(request.dashboardUserId!);
      if (!tenant) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "No tenant found for this account" } });
      }
      return reply.code(200).send({ data: toPublicTenant(tenant) });
    },
  );

  app.post(
    "/signup",
    {
      schema: {
        operationId: "dashboardSignup",
        tags: ["Dashboard"],
        summary: "Create a tenant for the authenticated dashboard user and mint its first secret key",
        description:
          "Called once, right after a Supabase Auth signup/login, for a user who has no tenant " +
          "yet. Mints a secret key named \"default\" — the same one-time-plaintext contract as " +
          "the create-tenant CLI script.",
        security: [{ bearerAuth: [] }],
        body: signupBody,
        response: { 200: z.object({ data: signupResponse }), 401: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const existing = await getTenantByOwnerUserId(request.dashboardUserId!);
      if (existing) {
        return reply
          .code(409)
          .send({ error: { code: "conflict", message: "This account already has a tenant" } });
      }

      let tenant: Tenant;
      try {
        tenant = await createTenant({
          name: request.body.tenantName,
          slug: request.body.tenantSlug,
          ownerUserId: request.dashboardUserId!,
        });
      } catch {
        // Either the slug is already taken, or a concurrent signup for this
        // same user won the owner_user_id unique constraint — both surface
        // here as an insert failure, and 409 is the right status for
        // either root cause without needing to parse the DB error.
        return reply.code(409).send({
          error: {
            code: "conflict",
            message: "Could not create this tenant — the slug may be taken, or this account may already have one",
          },
        });
      }

      const { plaintext, prefix } = await issueApiKey(tenant.id, "default");
      return reply.code(200).send({
        data: { tenant: toPublicTenant(tenant), apiKey: { plaintext, prefix } },
      });
    },
  );
};

export default tenantRoutes;
```

- [ ] **Step 9: Wire `/dashboard` into `app.ts`**

In `src/app.ts`, add the import:

```ts
import dashboardAuthPlugin from "./plugins/dashboard-auth";
import tenantRoutes from "./dashboard/tenant.routes";
```

Add the CORS delegator's third branch — inside the existing `delegator: async (request: FastifyRequest) => { ... }` function, before the final `if (request.url !== "/widget" ...)` check, insert:

```ts
      if (request.url === "/dashboard" || request.url.startsWith("/dashboard/")) {
        const origin = request.headers.origin;
        if (request.method === "OPTIONS") return { origin: origin ?? false };
        // Unlike /widget, this allowlist is NOT per-tenant — the dashboard
        // is one app with one deployed origin (plus localhost in dev), not
        // a domain a tenant configures.
        const allowed =
          (config.DASHBOARD_URL && origin === config.DASHBOARD_URL) ||
          (config.NODE_ENV !== "production" && origin === "http://localhost:5173");
        return { origin: allowed ? origin : false };
      }

```

Register the scope, after the existing `/widget` registration block:

```ts
  // A third sibling of /v1 and /widget. dashboardAuthPlugin resolves the
  // caller's Supabase user id; individual routes (via requireDashboardTenant,
  // applied per-route rather than scope-wide) resolve the tenant — see that
  // preHandler's own comment for why GET /tenant and POST /signup are the
  // two exceptions.
  void app.register(
    async (dashboard) => {
      await dashboard.register(dashboardAuthPlugin);
      await dashboard.register(tenantRoutes);
    },
    { prefix: "/dashboard" },
  );
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm vitest run src/dashboard/tenant.routes.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 11: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean. (The CORS test in `src/widget/widget.routes.test.ts` that asserts the anti-wildcard behavior must still pass unchanged — this task only adds a new branch, it does not touch the `/widget` branch's logic.)

- [ ] **Step 12: Commit**

```bash
git add src/plugins/dashboard-auth.ts src/plugins/dashboard-auth.test.ts src/dashboard/dashboard.schema.ts src/dashboard/tenant.routes.ts src/dashboard/tenant.routes.test.ts src/app.ts
git commit -m "feat(dashboard): add dashboardAuthPlugin, GET /dashboard/tenant, POST /dashboard/signup"
```

---

### Task 5: Dashboard documents routes

**Files:**
- Modify: `src/documents/documents.routes.ts` (export two helpers)
- Create: `src/dashboard/documents.routes.ts`
- Create: `src/dashboard/documents.routes.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `upsertDocument`/`listDocuments`/`deleteDocument` (`src/documents/documents.service.ts`, unchanged), `upsertDocumentBody`/`listDocumentsQuery`/`deleteDocumentParams`/`documentResponse`/`errorResponse` (`src/documents/documents.schema.ts`, unchanged), `requireDashboardTenant` (Task 4).
- Produces: `toPublicDocument`, `toIso` now exported from `src/documents/documents.routes.ts` for reuse.

- [ ] **Step 1: Export the two helpers from the existing file**

In `src/documents/documents.routes.ts`, change:

```ts
function toPublicDocument(doc: Document) {
```

to:

```ts
export function toPublicDocument(doc: Document) {
```

and change:

```ts
function toIso(timestamp: string): string {
```

to:

```ts
export function toIso(timestamp: string): string {
```

- [ ] **Step 2: Run the existing documents tests to confirm this export-only change is behavior-preserving**

Run: `pnpm vitest run src/documents/documents.routes.test.ts`
Expected: PASS, unchanged (adding `export` cannot change runtime behavior — this step is a sanity check, not a TDD red step).

- [ ] **Step 3: Write the failing test**

Create `src/dashboard/documents.routes.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, chunks, documents, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { buildApp } from "../app";

vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.01))),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
}));

const verifySupabaseTokenMock = vi.fn();
vi.mock("../lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

async function clean() {
  await db.delete(chunks);
  await db.delete(documents);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

let app: FastifyInstance;

beforeEach(async () => {
  await clean();
  vi.clearAllMocks();
  app = buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

function auth(userId: string) {
  verifySupabaseTokenMock.mockResolvedValueOnce({ id: userId, email: "a@b.com" });
  return { authorization: "Bearer valid-token" };
}

describe("dashboard document routes", () => {
  it("creates, lists, and deletes a document scoped to the owner's tenant", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const put = await app.inject({
      method: "PUT",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-000000000001"),
      payload: { externalId: "doc-1", title: "Hello", content: "World" },
    });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].externalId).toBe("doc-1");

    const del = await app.inject({
      method: "DELETE",
      url: "/dashboard/documents/doc-1",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.deleted).toBe(true);

    void tenant;
  });

  it("never lists another tenant's documents", async () => {
    await createTenant({ name: "A", slug: "a", ownerUserId: "00000000-0000-0000-0000-00000000000a" });
    await createTenant({ name: "B", slug: "b", ownerUserId: "00000000-0000-0000-0000-00000000000b" });

    await app.inject({
      method: "PUT",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-00000000000a"),
      payload: { externalId: "doc-1", content: "A's document" },
    });

    const list = await app.inject({
      method: "GET",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-00000000000b"),
    });

    expect(list.json().data).toHaveLength(0);
  });

  it("returns 404 for a user with no tenant yet", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-000000000099"),
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run src/dashboard/documents.routes.test.ts`
Expected: FAIL — the routes don't exist.

- [ ] **Step 5: Write the routes**

Create `src/dashboard/documents.routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { toPublicDocument } from "../documents/documents.routes";
import {
  deleteDocumentParams,
  documentResponse,
  errorResponse,
  listDocumentsQuery,
  upsertDocumentBody,
} from "../documents/documents.schema";
import { deleteDocument, listDocuments, upsertDocument } from "../documents/documents.service";
import { requireDashboardTenant } from "../plugins/dashboard-auth";

/**
 * Thin wrappers over documents.service.ts — identical behavior to
 * /v1/documents, just authenticated by a dashboard session instead of a
 * secret key. toPublicDocument is imported rather than reimplemented so
 * the two response shapes cannot drift apart.
 */
const dashboardDocumentsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.put(
    "/documents",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "dashboardUpsertDocument",
        tags: ["Dashboard"],
        summary: "Create or replace a document (dashboard session auth)",
        security: [{ bearerAuth: [] }],
        body: upsertDocumentBody,
        response: { 200: z.object({ data: documentResponse }), 400: errorResponse, 401: errorResponse, 404: errorResponse },
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
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "dashboardListDocuments",
        tags: ["Dashboard"],
        summary: "List this tenant's documents (dashboard session auth)",
        security: [{ bearerAuth: [] }],
        querystring: listDocumentsQuery,
        response: {
          200: z.object({
            data: z.array(documentResponse),
            meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { page, limit } = request.query;
      const { data, total } = await listDocuments(request.tenant!.id, page, limit);
      return reply.code(200).send({ data: data.map(toPublicDocument), meta: { page, limit, total } });
    },
  );

  app.delete(
    "/documents/:externalId",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "dashboardDeleteDocument",
        tags: ["Dashboard"],
        summary: "Delete a document (dashboard session auth)",
        security: [{ bearerAuth: [] }],
        params: deleteDocumentParams,
        response: { 200: z.object({ data: z.object({ deleted: z.boolean() }) }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const deleted = await deleteDocument(request.tenant!.id, request.params.externalId);
      if (!deleted) {
        return reply.code(404).send({ error: { code: "not_found", message: "Document not found" } });
      }
      return reply.code(200).send({ data: { deleted: true } });
    },
  );
};

export default dashboardDocumentsRoutes;
```

- [ ] **Step 6: Wire it into `app.ts`**

In `src/app.ts`, add the import:

```ts
import dashboardDocumentsRoutes from "./dashboard/documents.routes";
```

Extend the `/dashboard` registration block from Task 4:

```ts
  void app.register(
    async (dashboard) => {
      await dashboard.register(dashboardAuthPlugin);
      await dashboard.register(tenantRoutes);
      await dashboard.register(dashboardDocumentsRoutes);
    },
    { prefix: "/dashboard" },
  );
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run src/dashboard/documents.routes.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add src/documents/documents.routes.ts src/dashboard/documents.routes.ts src/dashboard/documents.routes.test.ts src/app.ts
git commit -m "feat(dashboard): add dashboard-session document CRUD routes"
```

---

### Task 6: Dashboard key-management routes

**Files:**
- Create: `src/dashboard/keys.routes.ts`
- Create: `src/dashboard/keys.routes.test.ts`
- Modify: `src/dashboard/dashboard.schema.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `listApiKeys`/`issueApiKey`/`revokeApiKey` (Task 3), `requireDashboardTenant` (Task 4).
- Produces: `apiKeyResponse`, `createKeyBody`, `createKeyResponse`, `revokeKeyParams` (added to `dashboard.schema.ts`).

- [ ] **Step 1: Add the new schemas**

Append to `src/dashboard/dashboard.schema.ts`:

```ts
export const apiKeyResponse = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const createKeyBody = z.object({
  name: z.string().min(1).max(255),
});

export const createKeyResponse = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  plaintext: z.string().describe("Shown exactly once — store it now, it cannot be retrieved again."),
});

export const revokeKeyParams = z.object({
  id: z.string().uuid(),
});
```

- [ ] **Step 2: Write the failing test**

Create `src/dashboard/keys.routes.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { buildApp } from "../app";

const verifySupabaseTokenMock = vi.fn();
vi.mock("../lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

let app: FastifyInstance;

beforeEach(async () => {
  await clean();
  vi.clearAllMocks();
  app = buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

function auth(userId: string) {
  verifySupabaseTokenMock.mockResolvedValueOnce({ id: userId, email: "a@b.com" });
  return { authorization: "Bearer valid-token" };
}

describe("dashboard key routes", () => {
  it("creates, lists, and revokes a secret key", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const create = await app.inject({
      method: "POST",
      url: "/dashboard/keys",
      headers: auth("00000000-0000-0000-0000-000000000001"),
      payload: { name: "production" },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().data.plaintext).toMatch(/^sk_live_/);
    const keyId = create.json().data.id as string;

    const list = await app.inject({ method: "GET", url: "/dashboard/keys", headers: auth("00000000-0000-0000-0000-000000000001") });
    expect(list.json().data.some((k: { name: string }) => k.name === "production")).toBe(true);
    expect(JSON.stringify(list.json())).not.toContain("sk_live_");

    const revoke = await app.inject({
      method: "DELETE",
      url: `/dashboard/keys/${keyId}`,
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });
    expect(revoke.statusCode).toBe(200);
  });

  it("returns 404 when revoking a key that isn't this tenant's", async () => {
    await createTenant({ name: "A", slug: "a", ownerUserId: "00000000-0000-0000-0000-00000000000a" });
    await createTenant({ name: "B", slug: "b", ownerUserId: "00000000-0000-0000-0000-00000000000b" });

    const create = await app.inject({
      method: "POST",
      url: "/dashboard/keys",
      headers: auth("00000000-0000-0000-0000-00000000000a"),
      payload: { name: "a-key" },
    });
    const keyId = create.json().data.id as string;

    const revoke = await app.inject({
      method: "DELETE",
      url: `/dashboard/keys/${keyId}`,
      headers: auth("00000000-0000-0000-0000-00000000000b"),
    });
    expect(revoke.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/dashboard/keys.routes.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 4: Write the routes**

Create `src/dashboard/keys.routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponse } from "../documents/documents.schema";
import { requireDashboardTenant } from "../plugins/dashboard-auth";
import { issueApiKey, listApiKeys, revokeApiKey } from "../tenants/tenants.service";
import { apiKeyResponse, createKeyBody, createKeyResponse, revokeKeyParams } from "./dashboard.schema";

function toIso(timestamp: string | null): string | null {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

const dashboardKeysRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/keys",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "listDashboardKeys",
        tags: ["Dashboard"],
        summary: "List this tenant's secret keys",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: z.array(apiKeyResponse) }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const keys = await listApiKeys(request.tenant!.id);
      return reply.code(200).send({
        data: keys.map((k) => ({
          id: k.id,
          name: k.name,
          keyPrefix: k.keyPrefix,
          lastUsedAt: toIso(k.lastUsedAt),
          revokedAt: toIso(k.revokedAt),
          createdAt: toIso(k.createdAt)!,
        })),
      });
    },
  );

  app.post(
    "/keys",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "createDashboardKey",
        tags: ["Dashboard"],
        summary: "Issue a new named secret key",
        security: [{ bearerAuth: [] }],
        body: createKeyBody,
        response: { 200: z.object({ data: createKeyResponse }), 400: errorResponse, 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      // issueApiKey only returns { plaintext, prefix } — not the row's id —
      // so the created row is looked up by its (unique) prefix afterwards.
      const { plaintext, prefix } = await issueApiKey(request.tenant!.id, request.body.name);
      const [created] = (await listApiKeys(request.tenant!.id)).filter((k) => k.keyPrefix === prefix);
      return reply
        .code(200)
        .send({ data: { id: created!.id, name: request.body.name, keyPrefix: prefix, plaintext } });
    },
  );

  app.delete(
    "/keys/:id",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "revokeDashboardKey",
        tags: ["Dashboard"],
        summary: "Revoke a secret key",
        security: [{ bearerAuth: [] }],
        params: revokeKeyParams,
        response: { 200: z.object({ data: z.object({ revoked: z.boolean() }) }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const revoked = await revokeApiKey(request.tenant!.id, request.params.id);
      if (!revoked) {
        return reply.code(404).send({ error: { code: "not_found", message: "Key not found" } });
      }
      return reply.code(200).send({ data: { revoked: true } });
    },
  );
};

export default dashboardKeysRoutes;
```

- [ ] **Step 5: Wire it into `app.ts`**

Add the import:

```ts
import dashboardKeysRoutes from "./dashboard/keys.routes";
```

Extend the registration block:

```ts
      await dashboard.register(dashboardKeysRoutes);
```

(added after `dashboardDocumentsRoutes`, same block as Task 5).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/dashboard/keys.routes.test.ts`
Expected: PASS, both tests.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/dashboard.schema.ts src/dashboard/keys.routes.ts src/dashboard/keys.routes.test.ts src/app.ts
git commit -m "feat(dashboard): add secret key list/create/revoke routes"
```

---

### Task 7: Dashboard widget-configuration routes

**Files:**
- Create: `src/dashboard/widget.routes.ts`
- Create: `src/dashboard/widget.routes.test.ts`
- Modify: `src/dashboard/dashboard.schema.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `setAllowedOrigins`/`issueApiKey`/`listApiKeys` (existing/Task 3), `requireDashboardTenant` (Task 4).
- Produces: `widgetConfigResponse`, `setOriginsBody`, `mintPublishableKeyResponse` (added to `dashboard.schema.ts`).

- [ ] **Step 1: Add the new schemas**

Append to `src/dashboard/dashboard.schema.ts`:

```ts
export const widgetConfigResponse = z.object({
  allowedOrigins: z.array(z.string()),
  publishableKeyPrefix: z.string().nullable(),
  hasPublishableKey: z.boolean(),
});

export const setOriginsBody = z.object({
  origins: z.array(z.string().url()),
});

export const mintPublishableKeyResponse = z.object({
  plaintext: z.string().describe("Shown exactly once — store it now, it cannot be retrieved again."),
  prefix: z.string(),
});
```

- [ ] **Step 2: Write the failing test**

Create `src/dashboard/widget.routes.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { buildApp } from "../app";

const verifySupabaseTokenMock = vi.fn();
vi.mock("../lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

let app: FastifyInstance;

beforeEach(async () => {
  await clean();
  vi.clearAllMocks();
  app = buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

function auth(userId: string) {
  verifySupabaseTokenMock.mockResolvedValueOnce({ id: userId, email: "a@b.com" });
  return { authorization: "Bearer valid-token" };
}

describe("dashboard widget-config routes", () => {
  it("starts with no allowed origins and no publishable key", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({ method: "GET", url: "/dashboard/widget", headers: auth("00000000-0000-0000-0000-000000000001") });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.allowedOrigins).toEqual([]);
    expect(res.json().data.publishableKeyPrefix).toBeNull();
    expect(res.json().data.hasPublishableKey).toBe(false);
  });

  it("sets allowed origins", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const put = await app.inject({
      method: "PUT",
      url: "/dashboard/widget/origins",
      headers: auth("00000000-0000-0000-0000-000000000001"),
      payload: { origins: ["https://acme.com"] },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/dashboard/widget", headers: auth("00000000-0000-0000-0000-000000000001") });
    expect(get.json().data.allowedOrigins).toEqual(["https://acme.com"]);
  });

  it("mints a publishable key and reflects its prefix afterwards", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const mint = await app.inject({
      method: "POST",
      url: "/dashboard/widget/publishable-key",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });
    expect(mint.statusCode).toBe(200);
    expect(mint.json().data.plaintext).toMatch(/^pk_live_/);

    const get = await app.inject({ method: "GET", url: "/dashboard/widget", headers: auth("00000000-0000-0000-0000-000000000001") });
    expect(get.json().data.publishableKeyPrefix).toBe(mint.json().data.prefix);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/dashboard/widget.routes.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 4: Write the routes**

Create `src/dashboard/widget.routes.ts`:

```ts
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db";
import { apiKeys } from "../db/schema";
import { errorResponse } from "../documents/documents.schema";
import { requireDashboardTenant } from "../plugins/dashboard-auth";
import { issueApiKey, setAllowedOrigins } from "../tenants/tenants.service";
import { mintPublishableKeyResponse, setOriginsBody, widgetConfigResponse } from "./dashboard.schema";

/**
 * The most recent non-revoked publishable key's prefix, or null if none
 * has been minted yet. Only the prefix — the raw key is hashed at rest
 * and shown exactly once, at POST /widget/publishable-key.
 */
async function currentPublishableKeyPrefix(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ keyPrefix: apiKeys.keyPrefix })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.kind, "publishable"), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  return row?.keyPrefix ?? null;
}

const dashboardWidgetRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/widget",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "getDashboardWidgetConfig",
        tags: ["Dashboard"],
        summary: "This tenant's widget configuration",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: widgetConfigResponse }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const publishableKeyPrefix = await currentPublishableKeyPrefix(request.tenant!.id);
      return reply.code(200).send({
        data: {
          allowedOrigins: request.tenant!.allowedOrigins,
          publishableKeyPrefix,
          hasPublishableKey: publishableKeyPrefix !== null,
        },
      });
    },
  );

  app.put(
    "/widget/origins",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "setDashboardWidgetOrigins",
        tags: ["Dashboard"],
        summary: "Replace this tenant's allowed widget origins",
        security: [{ bearerAuth: [] }],
        body: setOriginsBody,
        response: { 200: z.object({ data: z.object({ allowedOrigins: z.array(z.string()) }) }), 400: errorResponse, 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      await setAllowedOrigins(request.tenant!.id, request.body.origins);
      return reply.code(200).send({ data: { allowedOrigins: request.body.origins } });
    },
  );

  app.post(
    "/widget/publishable-key",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "mintDashboardPublishableKey",
        tags: ["Dashboard"],
        summary: "Mint (or re-mint) this tenant's publishable widget key",
        description:
          "A publishable key is hashed at rest exactly like a secret key, so a lost one cannot " +
          "be retrieved — this always mints a fresh one. The old one (if any) keeps working " +
          "until separately revoked; this route does not revoke it.",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: mintPublishableKeyResponse }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { plaintext, prefix } = await issueApiKey(request.tenant!.id, "widget", "publishable");
      return reply.code(200).send({ data: { plaintext, prefix } });
    },
  );
};

export default dashboardWidgetRoutes;
```

- [ ] **Step 5: Wire it into `app.ts`**

Add the import:

```ts
import dashboardWidgetRoutes from "./dashboard/widget.routes";
```

Extend the registration block:

```ts
      await dashboard.register(dashboardWidgetRoutes);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/dashboard/widget.routes.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/dashboard.schema.ts src/dashboard/widget.routes.ts src/dashboard/widget.routes.test.ts src/app.ts
git commit -m "feat(dashboard): add widget allowed-origins and publishable-key routes"
```

---

### Task 8: Usage aggregation + `GET /dashboard/usage`

**Files:**
- Create: `src/dashboard/usage.service.ts`
- Create: `src/dashboard/usage.service.test.ts`
- Create: `src/dashboard/usage.routes.ts`
- Create: `src/dashboard/usage.routes.test.ts`
- Modify: `src/dashboard/dashboard.schema.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `chatMetrics`/`conversations`/`messages` tables (`src/db/schema.ts`, unchanged), `requireDashboardTenant` (Task 4).
- Produces: `getUsageSummary(tenantId: string, days: number): Promise<{ data: Array<{ date: string; messages: number; tokens: number }>; totals: { conversations: number; messages: number; tokens: number } }>`, `usageQuery`/`usageResponse` schemas.

- [ ] **Step 1: Add the schemas**

Append to `src/dashboard/dashboard.schema.ts`:

```ts
export const usageQuery = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
});

export const usagePoint = z.object({
  date: z.string(),
  messages: z.number(),
  tokens: z.number(),
});

export const usageResponse = z.object({
  data: z.array(usagePoint),
  totals: z.object({
    conversations: z.number(),
    messages: z.number(),
    tokens: z.number(),
  }),
});
```

- [ ] **Step 2: Write the failing service test**

Create `src/dashboard/usage.service.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { apiKeys, chatMetrics, conversations, messages, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { getUsageSummary } from "./usage.service";

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

describe("getUsageSummary", () => {
  it("totals messages, conversations, and tokens for the tenant", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const [conversation] = await db
      .insert(conversations)
      .values({ tenantId: tenant.id, externalUserId: "visitor-1" })
      .returning();
    const [userMsg] = await db
      .insert(messages)
      .values({ conversationId: conversation!.id, tenantId: tenant.id, role: "user", content: "Hi" })
      .returning();
    const [assistantMsg] = await db
      .insert(messages)
      .values({ conversationId: conversation!.id, tenantId: tenant.id, role: "assistant", content: "Hello" })
      .returning();
    await db.insert(chatMetrics).values({
      conversationId: conversation!.id,
      messageId: assistantMsg!.id,
      tenantId: tenant.id,
      modelId: "test-model",
      latencyMs: 100,
      totalTokens: 42,
    });

    const summary = await getUsageSummary(tenant.id, 30);

    expect(summary.totals.conversations).toBe(1);
    expect(summary.totals.messages).toBe(2);
    expect(summary.totals.tokens).toBe(42);
    expect(summary.data.length).toBeGreaterThan(0);
    expect(summary.data[0]!.messages).toBe(2);
    expect(summary.data[0]!.tokens).toBe(42);

    void userMsg;
  });

  it("never includes another tenant's usage", async () => {
    const tenantA = await createTenant({ name: "A", slug: "a" });
    const tenantB = await createTenant({ name: "B", slug: "b" });
    const [conversation] = await db
      .insert(conversations)
      .values({ tenantId: tenantA.id, externalUserId: "visitor-1" })
      .returning();
    await db
      .insert(messages)
      .values({ conversationId: conversation!.id, tenantId: tenantA.id, role: "user", content: "Hi" });

    const summary = await getUsageSummary(tenantB.id, 30);

    expect(summary.totals.messages).toBe(0);
    expect(summary.totals.conversations).toBe(0);
    expect(summary.data).toHaveLength(0);
  });

  it("returns zeroed totals for a tenant with no activity", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const summary = await getUsageSummary(tenant.id, 30);

    expect(summary.totals).toEqual({ conversations: 0, messages: 0, tokens: 0 });
    expect(summary.data).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/dashboard/usage.service.test.ts`
Expected: FAIL — `Cannot find module './usage.service'`.

- [ ] **Step 4: Write the implementation**

Create `src/dashboard/usage.service.ts`:

```ts
import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import { db } from "../db";
import { chatMetrics, conversations, messages } from "../db/schema";

export type UsagePoint = { date: string; messages: number; tokens: number };
export type UsageSummary = {
  data: UsagePoint[];
  totals: { conversations: number; messages: number; tokens: number };
};

/**
 * Messages and tokens are two separate grouped queries rather than one
 * join: chat_metrics has one row per assistant turn (the only place
 * token counts live), while messages has one row per user AND assistant
 * message — a join would either double-count or silently drop rows,
 * depending on which side it favored. Merging by date in JS afterwards
 * is simpler and correct either way.
 */
export async function getUsageSummary(tenantId: string, days: number): Promise<UsageSummary> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceIso = since.toISOString();

  const [messagesByDay, tokensByDay, [convTotal], [msgTotal], [tokenTotal]] = await Promise.all([
    db
      .select({
        date: sql<string>`date_trunc('day', ${messages.createdAt})::date::text`,
        count: count(),
      })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), gte(messages.createdAt, sinceIso)))
      .groupBy(sql`date_trunc('day', ${messages.createdAt})`),
    db
      .select({
        date: sql<string>`date_trunc('day', ${chatMetrics.createdAt})::date::text`,
        tokens: sum(chatMetrics.totalTokens),
      })
      .from(chatMetrics)
      .where(and(eq(chatMetrics.tenantId, tenantId), gte(chatMetrics.createdAt, sinceIso)))
      .groupBy(sql`date_trunc('day', ${chatMetrics.createdAt})`),
    db.select({ total: count() }).from(conversations).where(eq(conversations.tenantId, tenantId)),
    db.select({ total: count() }).from(messages).where(eq(messages.tenantId, tenantId)),
    db.select({ total: sum(chatMetrics.totalTokens) }).from(chatMetrics).where(eq(chatMetrics.tenantId, tenantId)),
  ]);

  const byDate = new Map<string, UsagePoint>();
  for (const row of messagesByDay) {
    byDate.set(row.date, { date: row.date, messages: Number(row.count), tokens: 0 });
  }
  for (const row of tokensByDay) {
    const existing = byDate.get(row.date) ?? { date: row.date, messages: 0, tokens: 0 };
    existing.tokens = Number(row.tokens ?? 0);
    byDate.set(row.date, existing);
  }

  return {
    data: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals: {
      conversations: Number(convTotal!.total),
      messages: Number(msgTotal!.total),
      tokens: Number(tokenTotal!.total ?? 0),
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/dashboard/usage.service.test.ts`
Expected: PASS, all 3 tests. If the `date_trunc(...)::date::text` cast produces a type or grouping error against the real local Postgres, adjust the `sql<string>` template to match what actually comes back (e.g. drop the `::text` cast and instead `.toString()` in JS) — the grouping column and the selected column must be the same expression either way.

- [ ] **Step 6: Write the failing route test**

Create `src/dashboard/usage.routes.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, chatMetrics, conversations, messages, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { buildApp } from "../app";

const verifySupabaseTokenMock = vi.fn();
vi.mock("../lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

let app: FastifyInstance;

beforeEach(async () => {
  await clean();
  vi.clearAllMocks();
  app = buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

function auth(userId: string) {
  verifySupabaseTokenMock.mockResolvedValueOnce({ id: userId, email: "a@b.com" });
  return { authorization: "Bearer valid-token" };
}

describe("GET /dashboard/usage", () => {
  it("returns usage totals for the authenticated tenant", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({ method: "GET", url: "/dashboard/usage", headers: auth("00000000-0000-0000-0000-000000000001") });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.totals).toEqual({ conversations: 0, messages: 0, tokens: 0 });
  });

  it("respects the days query param", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/usage?days=7",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for a user with no tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/usage",
      headers: auth("00000000-0000-0000-0000-000000000099"),
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm vitest run src/dashboard/usage.routes.test.ts`
Expected: FAIL — the route doesn't exist.

- [ ] **Step 8: Write the route**

Create `src/dashboard/usage.routes.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponse } from "../documents/documents.schema";
import { requireDashboardTenant } from "../plugins/dashboard-auth";
import { usageQuery, usageResponse } from "./dashboard.schema";
import { getUsageSummary } from "./usage.service";

const dashboardUsageRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/usage",
    {
      preHandler: requireDashboardTenant,
      schema: {
        operationId: "getDashboardUsage",
        tags: ["Dashboard"],
        summary: "Messages and token usage over time for this tenant",
        security: [{ bearerAuth: [] }],
        querystring: usageQuery,
        response: { 200: z.object({ data: usageResponse }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const summary = await getUsageSummary(request.tenant!.id, request.query.days);
      return reply.code(200).send({ data: summary });
    },
  );
};

export default dashboardUsageRoutes;
```

- [ ] **Step 9: Wire it into `app.ts`**

Add the import:

```ts
import dashboardUsageRoutes from "./dashboard/usage.routes";
```

Extend the registration block:

```ts
      await dashboard.register(dashboardUsageRoutes);
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm vitest run src/dashboard/usage.routes.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 11: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean.

- [ ] **Step 12: Commit**

```bash
git add src/dashboard/dashboard.schema.ts src/dashboard/usage.service.ts src/dashboard/usage.service.test.ts src/dashboard/usage.routes.ts src/dashboard/usage.routes.test.ts src/app.ts
git commit -m "feat(dashboard): add usage aggregation and GET /dashboard/usage"
```

---

### Task 9: OpenAPI coverage for `/dashboard/*` + documentation

**Files:**
- Create: `src/app.dashboard-openapi.test.ts`
- Create: `docs/dashboard-api.md`

**Interfaces:**
- Consumes: the full `buildApp()` (all previous tasks).
- Produces: nothing new — this task only verifies and documents.

- [ ] **Step 1: Write the failing OpenAPI coverage test**

Create `src/app.dashboard-openapi.test.ts` (mirrors `src/app.openapi.test.ts`'s `/v1` coverage tests, scoped to `/dashboard`):

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

function toOpenApiPath(url: string): string {
  return url.replace(/:(\w+)/g, "{$1}");
}

describe("OpenAPI spec — /dashboard coverage", () => {
  it("documents every registered /dashboard route", async () => {
    const app = buildApp({ logger: false });

    const registered: string[] = [];
    app.addHook("onRoute", (route) => {
      if (route.url.startsWith("/dashboard") && route.method !== "HEAD") {
        registered.push(toOpenApiPath(route.url));
      }
    });
    await app.ready();

    const spec = app.swagger() as unknown as { paths: Record<string, unknown> };
    const documented = Object.keys(spec.paths);
    await app.close();

    expect(registered.length).toBeGreaterThan(0);
    for (const path of registered) {
      expect(documented).toContain(path);
    }
  });

  it("gives every /dashboard operation a summary and declared security", async () => {
    const app = buildApp({ logger: false });
    await app.ready();

    const spec = app.swagger() as unknown as {
      paths: Record<string, Record<string, { summary?: string; security?: unknown; operationId?: string }>>;
    };
    await app.close();

    const dashboardPaths = Object.entries(spec.paths).filter(([path]) => path.startsWith("/dashboard"));
    expect(dashboardPaths.length).toBeGreaterThan(0);

    for (const [path, operations] of dashboardPaths) {
      for (const [method, operation] of Object.entries(operations)) {
        expect(operation.summary, `${method.toUpperCase()} ${path} has no summary`).toBeTruthy();
        expect(operation.security, `${method.toUpperCase()} ${path} declares no security`).toBeDefined();
        expect(operation.operationId, `${method.toUpperCase()} ${path} has no operationId`).toBeTruthy();
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `pnpm vitest run src/app.dashboard-openapi.test.ts`
Expected: given every route added in Tasks 4–8 already carries a full `schema` block with `summary`/`security`/`operationId`, this should PASS immediately — this step exists to *prove* that coverage, not to drive new implementation. If it fails, find the route missing a `schema` field and add it.

- [ ] **Step 3: Write the documentation**

Create `docs/dashboard-api.md`:

```markdown
# Dashboard API

The `/dashboard/*` routes power the self-serve tenant dashboard (see the
`ai-chat-dashboard` frontend repo). Unlike `/v1/*` (secret key) and
`/widget/*` (publishable key), these routes are authenticated by a
**Supabase Auth session token** — the same token `supabase-js` hands you
after `signInWithPassword`, `signInWithOtp`, or a successful `signUp`.

Send it exactly like an API key:

```
Authorization: Bearer <supabase-access-token>
```

## First-time signup

A Supabase Auth account has no tenant until `POST /dashboard/signup` is
called once — typically right after the frontend detects `GET
/dashboard/tenant` returning 404. Signup mints the account's first secret
key in the same response; that plaintext key is shown exactly once and
cannot be retrieved again (see [authentication.md](authentication.md)).

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/dashboard/tenant` | The tenant owned by the authenticated account. 404 before signup. |
| `POST` | `/dashboard/signup` | Create the tenant + mint its first secret key. 409 if one already exists. |
| `GET` / `PUT` / `DELETE` | `/dashboard/documents` | Same behavior as `/v1/documents`, dashboard-session authenticated. |
| `GET` | `/dashboard/keys` | List this tenant's secret keys (never the raw key). |
| `POST` | `/dashboard/keys` | Issue a new named secret key. |
| `DELETE` | `/dashboard/keys/:id` | Revoke a secret key. |
| `GET` | `/dashboard/widget` | This tenant's widget config (allowed origins, publishable key prefix). |
| `PUT` | `/dashboard/widget/origins` | Replace the allowed-origins list. |
| `POST` | `/dashboard/widget/publishable-key` | Mint (or re-mint) the publishable key. |
| `GET` | `/dashboard/usage?days=30` | Messages/tokens over time plus all-time totals. |

## CORS

`/dashboard/*` is reachable from exactly one browser origin: the deployed
dashboard (`DASHBOARD_URL`), plus `http://localhost:5173` outside
production. Unlike `/widget/*`, this allowlist is not per-tenant — the
dashboard is one app, not something each tenant configures.

Full schemas and try-it-out are always available at `/docs`.
```

- [ ] **Step 4: Run the full suite one final time**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add src/app.dashboard-openapi.test.ts docs/dashboard-api.md
git commit -m "docs(dashboard): add /dashboard API guide and OpenAPI coverage test"
```
