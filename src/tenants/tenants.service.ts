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
