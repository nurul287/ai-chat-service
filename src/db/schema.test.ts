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
    const [tenant] = await db.insert(tenants).values({ name: "Acme", slug: "acme" }).returning();
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
