import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
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

    await revokeApiKey(tenant.id, row!.id);

    expect(await verifyApiKey(plaintext)).toBeNull();
  });

  it("records last_used_at on successful verification", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    await verifyApiKey(plaintext);
    // last_used_at is written fire-and-forget, so wait for it to settle rather
    // than racing it — the production path deliberately does not await it.
    await flushApiKeyTouches();

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenant.id));
    expect(row!.lastUsedAt).not.toBeNull();
  });
});

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

describe("createTenant with ownerUserId", () => {
  it("stores the owner", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: userId });
    expect(tenant.ownerUserId).toBe(userId);
  });

  it("still creates a tenant with no owner (the CLI path)", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    expect(tenant.ownerUserId).toBeNull();
  });
});

describe("getTenantByOwnerUserId", () => {
  it("returns the tenant owned by that user", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: userId });
    expect((await getTenantByOwnerUserId(userId))?.id).toBe(tenant.id);
  });

  it("returns null when no tenant has that owner", async () => {
    expect(await getTenantByOwnerUserId("00000000-0000-0000-0000-000000000099")).toBeNull();
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
