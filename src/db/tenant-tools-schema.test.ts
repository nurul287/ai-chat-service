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
