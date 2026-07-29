import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import {
  createTenant,
  flushApiKeyTouches,
  issueApiKey,
  revokeApiKey,
  verifyApiKey,
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

    await revokeApiKey(row!.id);

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
