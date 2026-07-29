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
