import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chunks, documents, tenants } from "../db/schema";
import { deleteDocument, listDocuments, upsertDocument } from "./documents.service";

vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  ),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
}));

async function clean() {
  await db.delete(chunks);
  await db.delete(documents);
  await db.delete(tenants);
}

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(tenants).values({ name: slug, slug }).returning();
  return tenant!;
}

beforeEach(clean);
afterAll(clean);

describe("upsertDocument", () => {
  it("creates a document and its chunks", async () => {
    const tenant = await makeTenant("acme");
    const doc = await upsertDocument(tenant.id, {
      externalId: "sku-1",
      title: "Paracetamol",
      content: "Paracetamol 500mg. Used for fever and mild pain.",
    });

    expect(doc.externalId).toBe("sku-1");
    const rows = await db.select().from(chunks).where(eq(chunks.documentId, doc.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.tenantId).toBe(tenant.id);
  });

  it("replaces chunks on re-upsert rather than duplicating them", async () => {
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "first version" });
    const doc = await upsertDocument(tenant.id, { externalId: "sku-1", content: "second version" });

    const rows = await db.select().from(chunks).where(eq(chunks.documentId, doc.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("second version");

    const allDocs = await db.select().from(documents);
    expect(allDocs).toHaveLength(1);
  });

  it("keeps two tenants' same-externalId documents separate", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");

    await upsertDocument(a.id, { externalId: "sku-1", content: "tenant a content" });
    await upsertDocument(b.id, { externalId: "sku-1", content: "tenant b content" });

    const aChunks = await db.select().from(chunks).where(eq(chunks.tenantId, a.id));
    const bChunks = await db.select().from(chunks).where(eq(chunks.tenantId, b.id));
    expect(aChunks[0]!.content).toBe("tenant a content");
    expect(bChunks[0]!.content).toBe("tenant b content");
  });
});

describe("deleteDocument", () => {
  it("deletes the document and returns true", async () => {
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "x" });

    expect(await deleteDocument(tenant.id, "sku-1")).toBe(true);
    expect(await db.select().from(documents)).toHaveLength(0);
    expect(await db.select().from(chunks)).toHaveLength(0);
  });

  it("returns false for an unknown externalId", async () => {
    const tenant = await makeTenant("acme");
    expect(await deleteDocument(tenant.id, "nope")).toBe(false);
  });

  it("refuses to delete another tenant's document", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    await upsertDocument(a.id, { externalId: "sku-1", content: "a content" });

    expect(await deleteDocument(b.id, "sku-1")).toBe(false);
    expect(await db.select().from(documents)).toHaveLength(1);
  });
});

describe("listDocuments", () => {
  it("returns only the calling tenant's documents", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    await upsertDocument(a.id, { externalId: "a-1", content: "x" });
    await upsertDocument(b.id, { externalId: "b-1", content: "y" });

    const result = await listDocuments(a.id, 1, 10);
    expect(result.total).toBe(1);
    expect(result.data[0]!.externalId).toBe("a-1");
  });
});
