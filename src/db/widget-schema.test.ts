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
