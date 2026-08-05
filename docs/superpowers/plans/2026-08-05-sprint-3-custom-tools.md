# Sprint 3: Custom Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant register their own HTTPS endpoint as a tool the chat
model can call mid-conversation for live data, alongside `search_knowledge`,
with every outgoing call HMAC-signed and a slow/failing tenant endpoint
degrading gracefully instead of hanging the chat turn.

**Architecture:** A new `tenant_tools` table stores each tool's JSON Schema,
endpoint URL, and an HMAC secret (encrypted at rest — a new reversible
encryption primitive, since API keys' one-way hash doesn't fit here). A new
`/v1/tools` REST surface lets a tenant register/list/revoke tools. At chat
time, `chat.service.ts` fetches this tenant's active tools fresh, converts
each one into an AI SDK `dynamicTool()` (using the SDK's own `jsonSchema()`
helper — no schema-conversion library needed), and merges them into the same
`tools` object `search_knowledge` already lives in. Every call to a tenant's
endpoint is HMAC-signed, 5-second-timeout-bounded, and never throws — failure
degrades to a message the model can react to.

**Tech Stack:** Same as Sprint 1/2 — Fastify 5, Drizzle ORM, Zod, Vitest
against real local Postgres, Vercel AI SDK v7. New: `ajv` (JSON Schema
validation at registration time), Node's built-in `node:crypto` (AES-256-GCM)
and `node:http` (test-only local server for the HMAC contract test).

## Global Constraints

- **`tenantId` comes only from the authenticated API key** — unchanged
  invariant from Sprint 1/2, extended: a tool's `tenantId` scoping follows
  the exact same rule as every other table.
- **Reversible secrets are new and must stay that way deliberately.** The
  HMAC secret and optional auth header value are encrypted (`src/lib/crypto.ts`),
  never hashed — decrypted only in memory, only for the lifetime of building
  one chat turn's tool set, never logged, never serialized in any HTTP
  response.
- **`GET /v1/tools` never touches the secret columns at all** — the query
  backing it does not select `hmac_secret_encrypted` or
  `auth_header_value_encrypted`, so there is no decrypt-then-strip step that
  could be gotten wrong. Data minimization at the query, not the serializer.
- **`callTenantEndpoint` never throws.** Timeout or non-2xx always resolves
  to a structured failure result — the chat turn must always reach `done`.
- **External HTTP is mocked in every test, except one deliberate exception:**
  the HMAC contract test in Task 5 uses a real local `node:http` server, not
  a mock — a mocked HTTP call cannot prove a real signature verifies, which
  is the entire point of that test. Every other test (Voyage, the chat
  model, and every other tenant-endpoint scenario) continues to mock.
- **Tests run against real local Postgres** (`127.0.0.1:55322`),
  `fileParallelism: false` — unchanged from Sprint 1/2.
- Conventional commit messages. Commit at the end of every task.

---

### Task 1: Reversible secret encryption

**Files:**
- Create: `src/lib/crypto.ts`
- Test: `src/lib/crypto.test.ts`
- Modify: `src/config/index.ts`
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `config` from `src/config/index.ts` (existing).
- Produces: `encryptSecret(plaintext: string): string`,
  `decryptSecret(stored: string): string`. Task 3 uses both directly.

- [ ] **Step 1: Write the failing test**

Create `src/lib/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

describe("crypto", () => {
  it("round-trips a secret through encrypt then decrypt", () => {
    const plaintext = "whsec_abc123";
    const stored = encryptSecret(plaintext);
    expect(decryptSecret(stored)).toBe(plaintext);
  });

  it("never stores the plaintext as-is", () => {
    const plaintext = "whsec_abc123";
    const stored = encryptSecret(plaintext);
    expect(stored).not.toContain(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const plaintext = "whsec_abc123";
    expect(encryptSecret(plaintext)).not.toBe(encryptSecret(plaintext));
  });

  it("throws when the stored value has been tampered with", () => {
    const stored = encryptSecret("whsec_abc123");
    const tampered = stored.slice(0, -4) + "abcd";
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/crypto.test.ts`
Expected: FAIL — `Cannot find module './crypto'`

- [ ] **Step 3: Add the config variable**

Modify `src/config/index.ts` — add to `baseConfigSchema` (after
`ANTHROPIC_API_KEY`):

```ts
  // AES-256-GCM key for tenant tool secrets (the HMAC secret and optional
  // auth header value) — these must be readable back to sign/authenticate
  // outgoing requests, unlike api_keys.key_hash which only ever needs
  // one-way comparison. 64 hex characters = 32 bytes.
  TOOL_SECRETS_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "must be a 64-character hex string (32 bytes)"),
```

- [ ] **Step 4: Implement `src/lib/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

function getKey(): Buffer {
  return Buffer.from(config.TOOL_SECRETS_ENCRYPTION_KEY, "hex");
}

/**
 * AES-256-GCM, not a one-way hash: unlike api_keys.key_hash, this must be
 * readable back to sign an outgoing request or set an outgoing header.
 * Stored as `iv:authTag:ciphertext`, each segment base64. A random IV per
 * call means the same plaintext never produces the same ciphertext twice.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const [ivB64, authTagB64, ciphertextB64] = stored.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted secret: expected iv:authTag:ciphertext");
  }

  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/lib/crypto.test.ts`
Expected: PASS (4 tests). Note: this will fail at import time until
`TOOL_SECRETS_ENCRYPTION_KEY` is set in your local `.env` — add this line
(a fixed, non-secret test value, same class as `VOYAGE_API_KEY=ci-test-key`):

```
TOOL_SECRETS_ENCRYPTION_KEY=3eafa276356c2bcb2f139410c731b4da88aeca1b487b9544fae4b712a5d5a477
```

- [ ] **Step 6: Add the same value to `.env.example` and CI**

Modify `.env.example` — add near the other chat-engine variables:

```
# 32-byte (64 hex char) AES-256-GCM key for tenant tool secrets.
# Generate your own for a real deployment: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
TOOL_SECRETS_ENCRYPTION_KEY=
```

Modify `.github/workflows/ci.yml` — add to the `env:` block (this is a
throwaway CI value, not a production secret, same as the other test-only
keys already there):

```yaml
      TOOL_SECRETS_ENCRYPTION_KEY: 3eafa276356c2bcb2f139410c731b4da88aeca1b487b9544fae4b712a5d5a477
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/crypto.ts src/lib/crypto.test.ts src/config/index.ts .env.example .github/workflows/ci.yml
git commit -m "feat(lib): add AES-256-GCM secret encryption for tenant tool credentials"
```

---

### Task 2: `tenant_tools` schema

**Files:**
- Modify: `src/db/schema.ts`
- Test: `src/db/tenant-tools-schema.test.ts`
- Generated (not hand-written): a new file under `supabase/migrations/`,
  produced by `pnpm db:generate` in Step 4.

**Interfaces:**
- Consumes: `tenants` (existing).
- Produces: table object `tenantTools`; row type
  `TenantTool = typeof tenantTools.$inferSelect`. Task 3 consumes both.

- [ ] **Step 1: Write the failing test**

Create `src/db/tenant-tools-schema.test.ts`, mirroring the style of
`src/db/chat-schema.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { tenants, tenantTools } from "./schema";

async function clean() {
  await db.delete(tenantTools);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

function baseTool(tenantId: string, overrides: Partial<typeof tenantTools.$inferInsert> = {}) {
  return {
    tenantId,
    name: "lookup_order",
    description: "Look up an order by ID",
    inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
    endpointUrl: "https://tenant.example.com/tool",
    hmacSecretEncrypted: "iv:tag:ciphertext",
    ...overrides,
  };
}

describe("tenant_tools schema", () => {
  it("allows two different tenants to register a tool with the same name", async () => {
    const [a] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [b] = await db.insert(tenants).values({ name: "B", slug: "b" }).returning();

    await db.insert(tenantTools).values(baseTool(a!.id));
    await db.insert(tenantTools).values(baseTool(b!.id));

    expect(await db.select().from(tenantTools)).toHaveLength(2);
  });

  it("rejects two ACTIVE tools with the same name for the same tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    await db.insert(tenantTools).values(baseTool(tenant!.id));

    await expect(db.insert(tenantTools).values(baseTool(tenant!.id))).rejects.toThrow();
  });

  it("allows re-registering a name once the earlier tool with that name is revoked", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [first] = await db.insert(tenantTools).values(baseTool(tenant!.id)).returning();
    await db
      .update(tenantTools)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(tenantTools.id, first!.id));

    await expect(db.insert(tenantTools).values(baseTool(tenant!.id))).resolves.not.toThrow();
  });

  it("cascades tool deletion when its tenant is deleted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    await db.insert(tenantTools).values(baseTool(tenant!.id));

    await db.delete(tenants).where(eq(tenants.id, tenant!.id));

    expect(await db.select().from(tenantTools)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/tenant-tools-schema.test.ts`
Expected: FAIL — `tenantTools` is not exported from `./schema`

- [ ] **Step 3: Add the table to the Drizzle schema**

Modify `src/db/schema.ts` — add `uniqueIndex` to the existing
`drizzle-orm/pg-core` import:

```ts
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
```

Then append this after `chatMetrics` (and its `ChatMetric` type export):

```ts
export const tenantTools = pgTable(
  "tenant_tools",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull(),
    inputSchema: jsonb("input_schema").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    hmacSecretEncrypted: text("hmac_secret_encrypted").notNull(),
    authHeaderName: text("auth_header_name"),
    authHeaderValueEncrypted: text("auth_header_value_encrypted"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_tenant_tools_tenant").on(table.tenantId),
    // Partial unique index, not a table-level unique() constraint — unique()
    // has no .where(), and a revoked tool must not block re-registering the
    // same name. Verified against drizzle-orm/pg-core/indexes.d.ts.
    uniqueIndex("idx_tenant_tools_tenant_name_active")
      .on(table.tenantId, table.name)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export type TenantTool = typeof tenantTools.$inferSelect;
```

- [ ] **Step 4: Generate the migration**

```bash
pnpm db:generate
```

A new file appears under `supabase/migrations/`. Open it and confirm it
contains exactly one `CREATE TABLE "tenant_tools"` statement, its two
indexes (one plain, one `UNIQUE ... WHERE`), and its foreign key — nothing
about `tenants`, `api_keys`, `documents`, `chunks`, `conversations`,
`messages`, or `chat_metrics` (those already exist; Drizzle Kit only diffs
what changed since its last generation).

- [ ] **Step 5: Apply it locally**

```bash
pnpm db:reset
```

Expected: all migrations apply cleanly, ending with the new one.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/db/tenant-tools-schema.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/tenant-tools-schema.test.ts supabase/migrations/
git commit -m "feat(db): add tenant_tools schema for Sprint 3 custom tools"
```

---

### Task 3: Registration schema and service

**Files:**
- Create: `src/tools/tools.schema.ts`
- Create: `src/tools/tenant-tools.service.ts`
- Test: `src/tools/tenant-tools.service.test.ts`

**Interfaces:**
- Consumes: `tenantTools`, `TenantTool` from `src/db/schema.ts` (Task 2);
  `encryptSecret`, `decryptSecret` from `src/lib/crypto.ts` (Task 1).
- Produces:
  - `registerToolBody`, `toolNameParams`, `toolResponse`, `registerToolResponse`
    (Zod schemas) — Task 4 consumes these.
  - `registerTool(tenantId, input): Promise<RegisteredTool>`
  - `listPublicTools(tenantId): Promise<PublicTool[]>`
  - `listActiveTools(tenantId): Promise<ActiveTool[]>`
  - `revokeTool(tenantId, name): Promise<boolean>`
  - `ToolNameConflictError` (thrown by `registerTool` on a duplicate active name)

  Task 4 (routes) consumes `registerTool`, `listPublicTools`, `revokeTool`,
  and `ToolNameConflictError`. Task 7 (runtime integration) consumes
  `listActiveTools` and the `ActiveTool` type.

- [ ] **Step 1: Install `ajv`**

```bash
pnpm add ajv
```

- [ ] **Step 2: Write the failing tests**

Create `src/tools/tools.schema.ts` is covered by the schema tests below, and
`src/tools/tenant-tools.service.test.ts` covers the service. Write both test
files first.

Create `src/tools/tools.schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { registerToolBody } from "./tools.schema";

const validBody = {
  name: "lookup_order",
  description: "Look up an order by ID",
  inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  endpointUrl: "https://tenant.example.com/tool",
};

describe("registerToolBody", () => {
  it("accepts a well-formed registration", () => {
    expect(registerToolBody.safeParse(validBody).success).toBe(true);
  });

  it("rejects the reserved name search_knowledge", () => {
    const result = registerToolBody.safeParse({ ...validBody, name: "search_knowledge" });
    expect(result.success).toBe(false);
  });

  it("rejects a name that is not a valid identifier", () => {
    const result = registerToolBody.safeParse({ ...validBody, name: "look up order" });
    expect(result.success).toBe(false);
  });

  it("rejects an inputSchema whose root type is not object", () => {
    const result = registerToolBody.safeParse({
      ...validBody,
      inputSchema: { type: "string" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an inputSchema that is not valid JSON Schema", () => {
    const result = registerToolBody.safeParse({
      ...validBody,
      inputSchema: { type: "object", properties: { orderId: { type: "not-a-real-type" } } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an optional authHeader", () => {
    const result = registerToolBody.safeParse({
      ...validBody,
      authHeader: { name: "Authorization", value: "Bearer xyz" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-HTTPS endpointUrl loosely — still requires a valid URL", () => {
    const result = registerToolBody.safeParse({ ...validBody, endpointUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });
});
```

Create `src/tools/tenant-tools.service.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { tenants, tenantTools } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import {
  listActiveTools,
  listPublicTools,
  registerTool,
  revokeTool,
  ToolNameConflictError,
} from "./tenant-tools.service";

async function clean() {
  await db.delete(tenantTools);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

const input = {
  name: "lookup_order",
  description: "Look up an order by ID",
  inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
  endpointUrl: "https://tenant.example.com/tool",
};

describe("registerTool", () => {
  it("returns the hmacSecret in plaintext exactly once", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const registered = await registerTool(tenant.id, input);

    expect(registered.hmacSecret).toMatch(/^whsec_/);
  });

  it("stores the hmacSecret encrypted, never as plaintext", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const registered = await registerTool(tenant.id, input);

    const stored = (await db.select().from(tenantTools))[0]!;
    expect(stored.hmacSecretEncrypted).not.toContain(registered.hmacSecret);
  });

  it("throws ToolNameConflictError when the same tenant registers the same active name twice", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await registerTool(tenant.id, input);

    await expect(registerTool(tenant.id, input)).rejects.toThrow(ToolNameConflictError);
  });

  it("allows re-registering a name after the earlier tool is revoked", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const first = await registerTool(tenant.id, input);
    await revokeTool(tenant.id, first.name);

    await expect(registerTool(tenant.id, input)).resolves.toBeDefined();
  });
});

describe("listPublicTools", () => {
  it("never includes the hmacSecret or authHeader value", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await registerTool(tenant.id, { ...input, authHeader: { name: "Authorization", value: "secret" } });

    const list = await listPublicTools(tenant.id);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("secret");
    expect(JSON.stringify(list)).not.toMatch(/hmacSecret|whsec_/);
  });

  it("excludes revoked tools", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const registered = await registerTool(tenant.id, input);
    await revokeTool(tenant.id, registered.name);

    expect(await listPublicTools(tenant.id)).toHaveLength(0);
  });

  it("never returns another tenant's tools", async () => {
    const a = await createTenant({ name: "A", slug: "a" });
    const b = await createTenant({ name: "B", slug: "b" });
    await registerTool(a.id, input);

    expect(await listPublicTools(b.id)).toHaveLength(0);
  });
});

describe("listActiveTools", () => {
  it("decrypts the hmacSecret back to its original plaintext", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const registered = await registerTool(tenant.id, input);

    const [active] = await listActiveTools(tenant.id);
    expect(active!.hmacSecret).toBe(registered.hmacSecret);
  });

  it("decrypts the authHeader value when one was set", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await registerTool(tenant.id, { ...input, authHeader: { name: "Authorization", value: "Bearer xyz" } });

    const [active] = await listActiveTools(tenant.id);
    expect(active!.authHeader).toEqual({ name: "Authorization", value: "Bearer xyz" });
  });

  it("returns null authHeader when none was set", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    await registerTool(tenant.id, input);

    const [active] = await listActiveTools(tenant.id);
    expect(active!.authHeader).toBeNull();
  });
});

describe("revokeTool", () => {
  it("returns false for a tool that does not exist", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    expect(await revokeTool(tenant.id, "no_such_tool")).toBe(false);
  });

  it("returns false when the name belongs to another tenant", async () => {
    const a = await createTenant({ name: "A", slug: "a" });
    const b = await createTenant({ name: "B", slug: "b" });
    await registerTool(a.id, input);

    expect(await revokeTool(b.id, input.name)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/tools/tools.schema.test.ts src/tools/tenant-tools.service.test.ts`
Expected: FAIL — neither `./tools.schema` nor `./tenant-tools.service` exists
yet.

- [ ] **Step 4: Implement `src/tools/tools.schema.ts`**

```ts
import Ajv from "ajv";
import { z } from "zod";

const ajv = new Ajv({ strict: false });

// search_knowledge is Sprint 2's built-in tool name — a tenant registering
// the same name would silently shadow it in the tools object passed to
// streamText, which is confusing at best and a correctness bug at worst.
const RESERVED_TOOL_NAMES = new Set(["search_knowledge"]);

const jsonSchemaObject = z
  .record(z.string(), z.unknown())
  .refine((schema) => schema.type === "object", {
    message: 'inputSchema must have "type": "object" at its root — a tool\'s parameters are always an object',
  })
  .refine(
    (schema) => {
      try {
        ajv.compile(schema);
        return true;
      } catch {
        return false;
      }
    },
    { message: "inputSchema is not a valid JSON Schema" },
  );

export const registerToolBody = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid identifier: letters, numbers, underscores, not starting with a digit")
    .refine((name) => !RESERVED_TOOL_NAMES.has(name), { message: "this name is reserved" })
    .describe("The tool name the model will see and call, e.g. lookup_order."),
  description: z.string().min(1).max(1000).describe("Shown to the model — be specific about what this tool does."),
  inputSchema: jsonSchemaObject.describe("A JSON Schema (draft-07) object describing this tool's parameters."),
  endpointUrl: z.string().url(),
  authHeader: z
    .object({ name: z.string().min(1), value: z.string().min(1) })
    .optional()
    .describe("One static header (e.g. Authorization) sent on every call to your endpoint."),
});

export const toolNameParams = z.object({ name: z.string().min(1) });

export const toolResponse = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  endpointUrl: z.string(),
  createdAt: z.string(),
});

export const registerToolResponse = toolResponse.extend({
  hmacSecret: z.string().describe("Shown exactly once. Store it now — it verifies every call to your endpoint."),
});
```

- [ ] **Step 5: Implement `src/tools/tenant-tools.service.ts`**

```ts
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db";
import { tenantTools, type TenantTool } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";

export class ToolNameConflictError extends Error {
  constructor(name: string) {
    super(`A tool named "${name}" is already registered for this tenant`);
    this.name = "ToolNameConflictError";
  }
}

export type RegisterToolInput = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpointUrl: string;
  authHeader?: { name: string; value: string };
};

export type RegisteredTool = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpointUrl: string;
  hmacSecret: string;
  createdAt: string;
};

export type PublicTool = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpointUrl: string;
  createdAt: string;
};

export type ActiveTool = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpointUrl: string;
  hmacSecret: string;
  authHeader: { name: string; value: string } | null;
};

/**
 * Postgres's unique_violation SQLSTATE, translated to a domain error rather
 * than parsed by callers. Pre-checking for an existing name first would
 * still race a concurrent registration; catching the constraint at insert
 * time has no such window.
 */
const UNIQUE_VIOLATION = "23505";

export async function registerTool(tenantId: string, input: RegisterToolInput): Promise<RegisteredTool> {
  const hmacSecret = `whsec_${randomBytes(32).toString("base64url")}`;

  try {
    const [row] = await db
      .insert(tenantTools)
      .values({
        tenantId,
        name: input.name,
        description: input.description,
        inputSchema: input.inputSchema,
        endpointUrl: input.endpointUrl,
        hmacSecretEncrypted: encryptSecret(hmacSecret),
        authHeaderName: input.authHeader?.name ?? null,
        authHeaderValueEncrypted: input.authHeader ? encryptSecret(input.authHeader.value) : null,
      })
      .returning();

    const tool = row!;
    return {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      endpointUrl: tool.endpointUrl,
      hmacSecret,
      createdAt: tool.createdAt,
    };
  } catch (err) {
    if (err instanceof postgres.PostgresError && err.code === UNIQUE_VIOLATION) {
      throw new ToolNameConflictError(input.name);
    }
    throw err;
  }
}

export async function listPublicTools(tenantId: string): Promise<PublicTool[]> {
  const rows = await db
    .select({
      id: tenantTools.id,
      name: tenantTools.name,
      description: tenantTools.description,
      inputSchema: tenantTools.inputSchema,
      endpointUrl: tenantTools.endpointUrl,
      createdAt: tenantTools.createdAt,
    })
    .from(tenantTools)
    .where(and(eq(tenantTools.tenantId, tenantId), isNull(tenantTools.revokedAt)));

  return rows.map((row) => ({ ...row, inputSchema: row.inputSchema as Record<string, unknown> }));
}

export async function listActiveTools(tenantId: string): Promise<ActiveTool[]> {
  const rows: TenantTool[] = await db
    .select()
    .from(tenantTools)
    .where(and(eq(tenantTools.tenantId, tenantId), isNull(tenantTools.revokedAt)));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    inputSchema: row.inputSchema as Record<string, unknown>,
    endpointUrl: row.endpointUrl,
    hmacSecret: decryptSecret(row.hmacSecretEncrypted),
    authHeader:
      row.authHeaderName && row.authHeaderValueEncrypted
        ? { name: row.authHeaderName, value: decryptSecret(row.authHeaderValueEncrypted) }
        : null,
  }));
}

export async function revokeTool(tenantId: string, name: string): Promise<boolean> {
  const revoked = await db
    .update(tenantTools)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(tenantTools.tenantId, tenantId), eq(tenantTools.name, name), isNull(tenantTools.revokedAt)))
    .returning({ id: tenantTools.id });
  return revoked.length > 0;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/tools/tools.schema.test.ts src/tools/tenant-tools.service.test.ts`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add src/tools/tools.schema.ts src/tools/tenant-tools.service.ts src/tools/tools.schema.test.ts src/tools/tenant-tools.service.test.ts package.json pnpm-lock.yaml
git commit -m "feat(tools): add tool registration schema and service"
```

---

### Task 4: `/v1/tools` routes

**Files:**
- Create: `src/tools/tools.routes.ts`
- Test: `src/tools/tools.routes.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `registerTool`, `listPublicTools`, `revokeTool`,
  `ToolNameConflictError` from `src/tools/tenant-tools.service.ts` (Task 3);
  `registerToolBody`, `toolNameParams`, `toolResponse`, `registerToolResponse`
  from `src/tools/tools.schema.ts` (Task 3); `errorResponse` from
  `src/documents/documents.schema.ts` (existing).
- Produces: `toolsRoutes` (default export), registered under `/v1` in
  `app.ts`. Nothing later depends on this beyond the running server.

- [ ] **Step 1: Write the failing tests**

Create `src/tools/tools.routes.test.ts`, mirroring
`src/documents/documents.routes.test.ts`'s style:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { tenantTools, tenants, apiKeys } from "../db/schema";
import { createTenant, issueApiKey } from "../tenants/tenants.service";
import { buildApp } from "../app";

async function clean() {
  await db.delete(tenantTools);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

async function tenantWithKey(slug: string) {
  const tenant = await createTenant({ name: slug, slug });
  const { plaintext } = await issueApiKey(tenant.id, "test");
  return { tenant, key: plaintext };
}

const body = {
  name: "lookup_order",
  description: "Look up an order by ID",
  inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
  endpointUrl: "https://tenant.example.com/tool",
};

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

describe("POST /v1/tools", () => {
  it("registers a tool and returns the hmacSecret exactly once", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers: { authorization: `Bearer ${key}` },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.hmacSecret).toMatch(/^whsec_/);
    expect(res.json().data.name).toBe("lookup_order");
  });

  it("rejects the reserved name search_knowledge", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers: { authorization: `Bearer ${key}` },
      payload: { ...body, name: "search_knowledge" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("rejects a duplicate active name for the same tenant", async () => {
    const { key } = await tenantWithKey("acme");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${key}` }, payload: body });

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers: { authorization: `Bearer ${key}` },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/tools", payload: body });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/tools", () => {
  it("never includes the hmacSecret", async () => {
    const { key } = await tenantWithKey("acme");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${key}` }, payload: body });

    const res = await app.inject({ method: "GET", url: "/v1/tools", headers: { authorization: `Bearer ${key}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(JSON.stringify(res.json().data)).not.toMatch(/whsec_|hmacSecret/);
  });

  it("never returns another tenant's tools", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${a.key}` }, payload: body });

    const res = await app.inject({ method: "GET", url: "/v1/tools", headers: { authorization: `Bearer ${b.key}` } });

    expect(res.json().data).toHaveLength(0);
  });
});

describe("DELETE /v1/tools/:name", () => {
  it("revokes a tool, which then disappears from the list", async () => {
    const { key } = await tenantWithKey("acme");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${key}` }, payload: body });

    const del = await app.inject({
      method: "DELETE",
      url: "/v1/tools/lookup_order",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/v1/tools", headers: { authorization: `Bearer ${key}` } });
    expect(list.json().data).toHaveLength(0);
  });

  it("returns 404 for an unknown tool name", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/tools/no_such_tool",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 rather than revoking when the name belongs to another tenant", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${a.key}` }, payload: body });

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/tools/lookup_order",
      headers: { authorization: `Bearer ${b.key}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/tools/tools.routes.test.ts`
Expected: FAIL — `/v1/tools` returns 404 (route not registered yet)

- [ ] **Step 3: Implement `src/tools/tools.routes.ts`**

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponse } from "../documents/documents.schema";
import { listPublicTools, registerTool, revokeTool, ToolNameConflictError } from "./tenant-tools.service";
import { registerToolBody, registerToolResponse, toolNameParams, toolResponse } from "./tools.schema";

function toIso(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

const toolsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/tools",
    {
      schema: {
        operationId: "registerTool",
        tags: ["Tools"],
        summary: "Register a custom tool the chat model can call mid-conversation",
        description:
          "The response includes an HMAC secret shown exactly once — store it immediately. " +
          "It signs every request this service sends to your endpoint. See docs/custom-tools.md.",
        security: [{ bearerAuth: [] }],
        body: registerToolBody,
        response: { 200: z.object({ data: registerToolResponse }), 400: errorResponse, 401: errorResponse },
      },
    },
    async (request, reply) => {
      try {
        const tool = await registerTool(request.tenant!.id, request.body);
        return reply.code(200).send({
          data: {
            id: tool.id,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            endpointUrl: tool.endpointUrl,
            hmacSecret: tool.hmacSecret,
            createdAt: toIso(tool.createdAt),
          },
        });
      } catch (err) {
        if (err instanceof ToolNameConflictError) {
          return reply.code(400).send({ error: { code: "invalid_request", message: err.message } });
        }
        throw err;
      }
    },
  );

  app.get(
    "/tools",
    {
      schema: {
        operationId: "listTools",
        tags: ["Tools"],
        summary: "List this tenant's registered tools",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: z.array(toolResponse) }), 401: errorResponse },
      },
    },
    async (request, reply) => {
      const tools = await listPublicTools(request.tenant!.id);
      return reply.code(200).send({
        data: tools.map((t) => ({ ...t, createdAt: toIso(t.createdAt) })),
      });
    },
  );

  app.delete(
    "/tools/:name",
    {
      schema: {
        operationId: "revokeTool",
        tags: ["Tools"],
        summary: "Revoke a registered tool",
        security: [{ bearerAuth: [] }],
        params: toolNameParams,
        response: {
          200: z.object({ data: z.object({ revoked: z.boolean() }) }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const revoked = await revokeTool(request.tenant!.id, request.params.name);
      if (!revoked) {
        return reply.code(404).send({ error: { code: "not_found", message: "Tool not found" } });
      }
      return reply.code(200).send({ data: { revoked: true } });
    },
  );
};

export default toolsRoutes;
```

- [ ] **Step 4: Wire it into `app.ts`**

Modify `src/app.ts` — add the import near the other route imports:

```ts
import toolsRoutes from "./tools/tools.routes";
```

And register it alongside the existing routes inside the `/v1` block:

```ts
  void app.register(
    async (v1) => {
      await v1.register(authPlugin);
      await v1.register(documentsRoutes);
      await v1.register(chatRoutes);
      await v1.register(toolsRoutes);
    },
    { prefix: "/v1" },
  );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/tools/tools.routes.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.routes.ts src/tools/tools.routes.test.ts src/app.ts
git commit -m "feat(api): add /v1/tools registration, list, and revoke routes"
```

---

### Task 5: HMAC-signed outbound call

**Files:**
- Create: `src/tools/call-tenant-endpoint.ts`
- Test: `src/tools/call-tenant-endpoint.test.ts`

**Interfaces:**
- Consumes: `ActiveTool` from `src/tools/tenant-tools.service.ts` (Task 3).
- Produces: `callTenantEndpoint(tool: ActiveTool, args: unknown, conversationId: string): Promise<TenantToolCallResult>`
  where `TenantToolCallResult = { ok: true; data: unknown } | { ok: false; reason: string }`.
  Task 7 consumes this directly.

This is the task that proves the exit gate — read it carefully. It uses a
real local `node:http` server rather than a mock, because the whole point is
proving a genuine third party could verify the signature.

- [ ] **Step 1: Write the failing tests**

Create `src/tools/call-tenant-endpoint.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { callTenantEndpoint } from "./call-tenant-endpoint";
import type { ActiveTool } from "./tenant-tools.service";

function fakeTool(overrides: Partial<ActiveTool> = {}): ActiveTool {
  return {
    id: "tool-1",
    name: "lookup_order",
    description: "Look up an order",
    inputSchema: { type: "object", properties: {} },
    endpointUrl: "http://127.0.0.1:1",
    hmacSecret: "whsec_test_secret",
    authHeader: null,
    ...overrides,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("callTenantEndpoint", () => {
  it("signs the request so an independent HMAC verification succeeds", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody = "";

    server = createServer((req, res) => {
      receivedHeaders = req.headers;
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        receivedBody = raw;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "shipped" }));
      });
    });
    const port = await listen(server);

    const tool = fakeTool({ endpointUrl: `http://127.0.0.1:${port}` });
    const result = await callTenantEndpoint(tool, { orderId: "123" }, "conv-1");

    expect(result).toEqual({ ok: true, data: { status: "shipped" } });

    // The exact verification a real tenant would implement, using nothing
    // but the secret returned at registration, the timestamp header, and the
    // raw body this service actually sent.
    const timestamp = receivedHeaders["x-webhook-timestamp"];
    const signature = receivedHeaders["x-webhook-signature"];
    const expectedSignature = createHmac("sha256", tool.hmacSecret)
      .update(`${String(timestamp)}.${receivedBody}`)
      .digest("hex");

    expect(signature).toBe(expectedSignature);
    expect(JSON.parse(receivedBody)).toEqual({
      toolName: "lookup_order",
      arguments: { orderId: "123" },
      conversationId: "conv-1",
    });
  });

  it("sends the configured static auth header", async () => {
    let receivedAuth: string | undefined;
    server = createServer((req, res) => {
      receivedAuth = req.headers["authorization"] as string | undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const port = await listen(server);

    const tool = fakeTool({
      endpointUrl: `http://127.0.0.1:${port}`,
      authHeader: { name: "Authorization", value: "Bearer tenant-key" },
    });
    await callTenantEndpoint(tool, {}, "conv-1");

    expect(receivedAuth).toBe("Bearer tenant-key");
  });

  it("degrades gracefully instead of hanging when the endpoint never responds", async () => {
    server = createServer(() => {
      // deliberately never responds
    });
    const port = await listen(server);

    const tool = fakeTool({ endpointUrl: `http://127.0.0.1:${port}` });
    const start = Date.now();
    const result = await callTenantEndpoint(tool, {}, "conv-1");
    const elapsedMs = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(6000);
  }, 10_000);

  it("degrades gracefully on a non-2xx response", async () => {
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const port = await listen(server);

    const tool = fakeTool({ endpointUrl: `http://127.0.0.1:${port}` });
    const result = await callTenantEndpoint(tool, {}, "conv-1");

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("500") });
  });

  it("degrades gracefully when the endpoint is unreachable", async () => {
    const tool = fakeTool({ endpointUrl: "http://127.0.0.1:1" }); // nothing listens on port 1
    const result = await callTenantEndpoint(tool, {}, "conv-1");

    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/tools/call-tenant-endpoint.test.ts`
Expected: FAIL — `Cannot find module './call-tenant-endpoint'`

- [ ] **Step 3: Implement `src/tools/call-tenant-endpoint.ts`**

```ts
import { createHmac } from "node:crypto";
import type { ActiveTool } from "./tenant-tools.service";

const TIMEOUT_MS = 5000;

export type TenantToolCallResult = { ok: true; data: unknown } | { ok: false; reason: string };

/**
 * Never throws. A tenant's endpoint being slow, down, or erroring is an
 * expected, ordinary outcome — not a service-level failure — so it always
 * resolves to a result the chat turn can react to and finish cleanly.
 */
export async function callTenantEndpoint(
  tool: ActiveTool,
  args: unknown,
  conversationId: string,
): Promise<TenantToolCallResult> {
  const body = JSON.stringify({ toolName: tool.name, arguments: args, conversationId });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", tool.hmacSecret).update(`${timestamp}.${body}`).digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature": signature,
  };
  if (tool.authHeader) headers[tool.authHeader.name] = tool.authHeader.value;

  try {
    const res = await fetch(tool.endpointUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      return { ok: false, reason: `Tool endpoint responded with status ${res.status}` };
    }

    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: "Tool endpoint did not respond in time or the request failed" };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/tools/call-tenant-endpoint.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tools/call-tenant-endpoint.ts src/tools/call-tenant-endpoint.test.ts
git commit -m "feat(tools): add HMAC-signed, timeout-bounded outbound tool calls"
```

---

### Task 6: Extend the wire protocol for tool visibility

**Files:**
- Modify: `src/chat/stream-adapter.ts`
- Modify: `src/chat/stream-adapter.test.ts`
- Modify: `src/chat/chat.service.ts`
- Modify: `src/chat/chat.service.test.ts`

**Interfaces:**
- Consumes: nothing new — this task only extends existing types.
- Produces: a new `ChatStreamEvent` variant
  `{ type: "tool_call"; toolName: string; arguments: unknown; result: unknown }`
  and a new `ChatWireEvent` variant
  `{ event: "tool_call"; data: { toolName: string; arguments: unknown; result: unknown } }`.
  Task 7 relies on this: once a custom tool is wired into the loop, its
  result now has a real event type to surface through.

This task is deliberately independent of whether any custom tool exists yet
— it proves the wire protocol change using a fake tool-result from ANY
non-`search_knowledge` name, exactly the scenario that used to be silently
dropped.

- [ ] **Step 1: Write the failing test**

Modify `src/chat/stream-adapter.test.ts` — replace the existing
`"ignores tool-results from any tool other than search_knowledge"` test
(behavior is intentionally changing) with:

```ts
  it("emits a tool_call event for a tool-result from any tool other than search_knowledge", async () => {
    const events = await collect(
      adaptStream(
        fakeStream([
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup_order",
            input: { orderId: "123" },
            output: { status: "shipped" },
          },
        ]) as never,
      ),
    );
    expect(events).toEqual([
      {
        type: "tool_call",
        toolName: "lookup_order",
        arguments: { orderId: "123" },
        result: { status: "shipped" },
      },
    ]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/chat/stream-adapter.test.ts`
Expected: FAIL — the current code yields nothing for a non-search_knowledge
tool-result, so `events` is `[]`, not the expected single `tool_call` event.

- [ ] **Step 3: Implement it**

Modify `src/chat/stream-adapter.ts` — add the new variant to `ChatStreamEvent`:

```ts
export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "sources"; documents: RetrievedChunk[] }
  | { type: "tool_call"; toolName: string; arguments: unknown; result: unknown }
  | {
      type: "finish";
      usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    }
  | { type: "error"; code: "internal_error"; message: string };
```

And change the `tool-result` case:

```ts
      case "tool-result":
        if (part.toolName === "search_knowledge") {
          yield { type: "sources", documents: part.output as RetrievedChunk[] };
        } else {
          yield { type: "tool_call", toolName: part.toolName, arguments: part.input, result: part.output };
        }
        break;
```

Update the doc comment above `adaptStream` — the line about "a result from
any other tool name is silently ignored... since there is nothing else
registered to produce one yet" is no longer true as of Sprint 3. Replace it:

```ts
 * `search_knowledge`'s tool-result becomes a `sources` event; every other
 * tool's result becomes a `tool_call` event — that's how a tenant's custom
 * tool (Sprint 3) becomes visible to the client, the same transparency
 * principle as search_knowledge's citations.
```

Now modify `src/chat/chat.service.ts` — add the new `ChatWireEvent` variant:

```ts
export type ChatWireEvent =
  | { event: "token"; data: { text: string } }
  | { event: "sources"; data: { documents: RetrievedChunk[] } }
  | { event: "tool_call"; data: { toolName: string; arguments: unknown; result: unknown } }
  | { event: "done"; data: { conversationId: string; messageId: string } }
  | {
      event: "error";
      data: { conversationId: string; error: { code: string; message: string } };
    };
```

And add a case in the `for await` switch, alongside the existing `"sources"`
case:

```ts
      case "tool_call":
        toolCallCount += 1;
        yield {
          event: "tool_call",
          data: { toolName: event.toolName, arguments: event.arguments, result: event.result },
        };
        break;
```

- [ ] **Step 4: Add a chat.service.ts-level test for the new event**

Modify `src/chat/chat.service.test.ts` — add this test (it uses a fake
`tool-result` from a non-search_knowledge name, same as Task 7's real custom
tools will produce, without depending on Task 7's runtime wiring):

```ts
  it("yields a tool_call event for a non-search_knowledge tool result", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(streamText).mockReturnValue(
      fakeResult([
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "lookup_order",
          input: { orderId: "123" },
          output: { status: "shipped" },
        },
        { type: "finish", totalUsage: {} },
      ]) as never,
    );

    const { runChat } = await import("./chat.service");
    const events = await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    expect(events).toContainEqual({
      event: "tool_call",
      data: { toolName: "lookup_order", arguments: { orderId: "123" }, result: { status: "shipped" } },
    });
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/chat/stream-adapter.test.ts src/chat/chat.service.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add src/chat/stream-adapter.ts src/chat/stream-adapter.test.ts src/chat/chat.service.ts src/chat/chat.service.test.ts
git commit -m "feat(chat): surface non-search_knowledge tool calls as a tool_call SSE event"
```

---

### Task 7: Runtime integration into the chat loop

**Files:**
- Create: `src/chat/tools/custom-tool.ts`
- Modify: `src/chat/chat.service.ts`
- Modify: `src/chat/chat.service.test.ts`

**Interfaces:**
- Consumes: `listActiveTools`, `ActiveTool` from
  `src/tools/tenant-tools.service.ts` (Task 3); `callTenantEndpoint` from
  `src/tools/call-tenant-endpoint.ts` (Task 5); the `tool_call` wire event
  from Task 6.
- Produces: `buildCustomTool(tool: ActiveTool, conversationId: string): DynamicTool`.
  Nothing later in this plan depends on it — this is the integration point.

- [ ] **Step 1: Write the failing test**

Modify `src/chat/chat.service.test.ts` — add the mock for the new service
dependency near the other `vi.mock` calls at the top of the file:

```ts
vi.mock("../tools/tenant-tools.service", () => ({ listActiveTools: vi.fn(async () => []) }));
```

Then add this test:

```ts
  it("includes a tenant's registered custom tools alongside search_knowledge in the same turn", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { listActiveTools } = await import("../tools/tenant-tools.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(listActiveTools).mockResolvedValue([
      {
        id: "tool-1",
        name: "lookup_order",
        description: "Looks up an order",
        inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
        endpointUrl: "https://tenant.example.com/tool",
        hmacSecret: "whsec_x",
        authHeader: null,
      },
    ] as never);
    vi.mocked(streamText).mockReturnValue(fakeResult([{ type: "finish", totalUsage: {} }]) as never);

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    const callArgs = vi.mocked(streamText).mock.calls[0]![0] as { tools: Record<string, unknown> };
    expect(Object.keys(callArgs.tools)).toEqual(
      expect.arrayContaining(["search_knowledge", "lookup_order"]),
    );
  });

  it("does not include a revoked or another tenant's tool", async () => {
    const { getConversation, appendMessage } = await import("./conversations.service");
    const { listActiveTools } = await import("../tools/tenant-tools.service");
    const { streamText } = await import("ai");
    vi.mocked(getConversation).mockResolvedValue({ id: "conv-1" } as never);
    vi.mocked(appendMessage).mockResolvedValue({ id: "msg-1" } as never);
    vi.mocked(listActiveTools).mockResolvedValue([]); // the service itself already excludes these
    vi.mocked(streamText).mockReturnValue(fakeResult([{ type: "finish", totalUsage: {} }]) as never);

    const { runChat } = await import("./chat.service");
    await collect(
      runChat({ tenantId: "t1", externalUserId: "u1", conversationId: "conv-1", message: "hi" }),
    );

    const callArgs = vi.mocked(streamText).mock.calls[0]![0] as { tools: Record<string, unknown> };
    expect(Object.keys(callArgs.tools)).toEqual(["search_knowledge"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/chat/chat.service.test.ts`
Expected: FAIL — `tools` only ever contains `search_knowledge`; the first new
test's `arrayContaining(["search_knowledge", "lookup_order"])` assertion
fails.

- [ ] **Step 3: Implement it**

Create `src/chat/tools/custom-tool.ts`:

```ts
import { dynamicTool, jsonSchema } from "ai";
import { callTenantEndpoint } from "../../tools/call-tenant-endpoint";
import type { ActiveTool } from "../../tools/tenant-tools.service";

/**
 * jsonSchema() wraps the tenant's raw JSON Schema directly as a valid tool
 * schema — confirmed against @ai-sdk/provider-utils's real type declarations,
 * no schema-conversion library needed. dynamicTool() (rather than tool()) is
 * for exactly this case: a tool whose input shape isn't known until runtime.
 */
export function buildCustomTool(tool: ActiveTool, conversationId: string) {
  return dynamicTool({
    description: tool.description,
    inputSchema: jsonSchema(tool.inputSchema),
    execute: async (args) => {
      const result = await callTenantEndpoint(tool, args, conversationId);
      return result.ok ? result.data : { error: result.reason };
    },
  });
}
```

Modify `src/chat/chat.service.ts` — add the imports:

```ts
import { buildCustomTool } from "./tools/custom-tool";
import { listActiveTools } from "../tools/tenant-tools.service";
```

And change how `tools` is built for `streamText`. Replace:

```ts
  const result = streamText({
    model: chatModel,
    messages: [...context, { role: "user", content: input.message }],
    tools: { search_knowledge: searchKnowledgeTool(input.tenantId) },
    stopWhen: isStepCount(MAX_TOOL_LOOP_STEPS),
  });
```

with:

```ts
  const customTools = await listActiveTools(input.tenantId);
  const tools = {
    search_knowledge: searchKnowledgeTool(input.tenantId),
    ...Object.fromEntries(customTools.map((t) => [t.name, buildCustomTool(t, conversation.id)])),
  };

  const result = streamText({
    model: chatModel,
    messages: [...context, { role: "user", content: input.message }],
    tools,
    stopWhen: isStepCount(MAX_TOOL_LOOP_STEPS),
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/chat/chat.service.test.ts`
Expected: PASS (all tests, including every test from Sprint 2 — this proves
nothing regressed)

- [ ] **Step 5: Run the full suite**

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/chat/tools/custom-tool.ts src/chat/chat.service.ts src/chat/chat.service.test.ts
git commit -m "feat(chat): wire tenant-registered custom tools into the tool-use loop"
```

---

### Task 8: Documentation

**Files:**
- Create: `docs/custom-tools.md`
- Test: none (documentation only; the existing OpenAPI-coverage test already
  asserts every `/v1` route appears in the generated spec, covering the
  three new routes automatically)

- [ ] **Step 1: Write `docs/custom-tools.md`**

```markdown
# Custom tools

A custom tool is your own HTTPS endpoint, registered once, that the chat
model can call mid-conversation for data ingestion can't cover — order
status, inventory, account lookups. It works alongside the built-in
`search_knowledge` tool in every chat turn.

## Register a tool

\`\`\`bash
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
\`\`\`

The response includes an `hmacSecret` (`whsec_...`) — **store it now.** It is
never shown again, and it's what proves a request calling your endpoint
really came from this service.

`inputSchema` is standard JSON Schema (draft-07), describing the arguments
the model will pass. It must be an object schema (`"type": "object"` at the
root) — that's what a tool's parameters always are.

An optional `authHeader` sends one static header (commonly `Authorization`)
on every call, if your endpoint needs its own auth on top of signature
verification:

\`\`\`json
{ "authHeader": { "name": "Authorization", "value": "Bearer your-internal-key" } }
\`\`\`

## Verify the signature

Every call to your endpoint carries two headers:

| Header | Contents |
|---|---|
| `X-Webhook-Timestamp` | Unix seconds when the request was signed |
| `X-Webhook-Signature` | `hex(HMAC-SHA256(hmacSecret, "${timestamp}.${rawBody}"))` |

Verify it (Node.js):

\`\`\`js
const crypto = require("node:crypto");

function verify(rawBody, timestamp, signature, hmacSecret) {
  const expected = crypto
    .createHmac("sha256", hmacSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const withinWindow = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300; // 5 minutes
  return withinWindow && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
\`\`\`

**Reject anything outside a ±5 minute window** — that's your replay
protection. We're the caller here, not the verifier, so an old captured
request replayed later is only stopped by your own timestamp check.

The request body:

\`\`\`json
{ "toolName": "lookup_order", "arguments": { "orderId": "12345" }, "conversationId": "..." }
\`\`\`

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

\`\`\`bash
curl https://your-instance/v1/tools -H "Authorization: Bearer sk_live_..."
curl -X DELETE https://your-instance/v1/tools/lookup_order -H "Authorization: Bearer sk_live_..."
\`\`\`

There is no update-in-place yet — to change a URL or rotate a secret, revoke
and register again under a new name.
```

- [ ] **Step 2: Verify the OpenAPI coverage test already passes**

Run: `pnpm vitest run` (the full suite) — the existing test asserting every
`/v1` route appears in the generated spec with a `summary`/`security`/
`operationId` should already pass for the three new routes without any
changes, since Task 4 gave every route a full `schema` block. If it fails,
the gap is almost certainly a missing field on one of the three route
schemas in `src/tools/tools.routes.ts` — fix there, not in the test.

- [ ] **Step 3: Commit**

```bash
git add docs/custom-tools.md
git commit -m "docs: add custom tools registration and signature verification guide"
```

---

## Verification

**Automated** — `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test`
all green, matching every prior sprint's bar. The tests that matter most for
this sprint's exit gate specifically:

- `call-tenant-endpoint.test.ts`'s "signs the request so an independent HMAC
  verification succeeds" — proves the HMAC scheme end-to-end against a real
  HTTP server, not a mock.
- `call-tenant-endpoint.test.ts`'s two degradation tests (never-responds,
  non-2xx) — prove a slow/failing tenant endpoint never hangs or crashes the
  turn.
- `tenant-tools.service.test.ts`'s isolation and secret-hygiene tests — prove
  no tenant can see or collide with another's tools, and no route ever
  serializes a decrypted secret.

**Manual, against a locally running service:**

```bash
pnpm db:reset && pnpm dev
pnpm create-tenant "Acme Pharmacy" acme-pharmacy
```

Register a tool pointed at a throwaway local echo server (or
https://webhook.site for a quick manual check), send a chat message that
should trigger it, and confirm a `tool_call` SSE event appears in the stream
carrying the real result — then revoke it and confirm a further chat turn no
longer offers that tool to the model.
