import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { chunks, documents, tenants } from "../db/schema";
import { upsertDocument } from "../documents/documents.service";
import { retrieve, rrfFuse } from "./retrieve";

// Deterministic stand-in embeddings: the vector leg is exercised end to end
// (the query runs against a real pgvector index) but ranking is driven by the
// keyword leg, so the assertions do not depend on a live embedding model.
vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  ),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
  rerank: vi.fn(),
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

describe("rrfFuse", () => {
  it("ranks an item appearing in both lists above one appearing in neither's top", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    const fused = rrfFuse([
      [b, a],
      [c, a],
    ]);
    expect(fused[0]!.id).toBe("a");
  });

  it("preserves first-list order on a tie", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    expect(rrfFuse([[a, b]]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("returns an empty array for no lists", () => {
    expect(rrfFuse([])).toEqual([]);
  });
});

describe("retrieve", () => {
  it("finds a chunk by keyword", async () => {
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, {
      externalId: "sku-1",
      title: "Paracetamol",
      content: "Paracetamol 500mg tablets relieve fever and headache.",
    });
    await upsertDocument(tenant.id, {
      externalId: "sku-2",
      title: "Bandage",
      content: "Sterile adhesive bandage for minor cuts.",
    });

    const results = await retrieve(tenant.id, "paracetamol fever", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.externalId).toBe("sku-1");
  });

  it("never returns another tenant's chunks", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    await upsertDocument(a.id, {
      externalId: "secret",
      content: "Tenant A confidential formulary notes.",
    });

    const results = await retrieve(b.id, "confidential formulary", 5);
    expect(results).toHaveLength(0);
  });

  it("respects topK", async () => {
    const tenant = await makeTenant("acme");
    for (let i = 0; i < 5; i++) {
      await upsertDocument(tenant.id, {
        externalId: `sku-${i}`,
        content: `Vitamin supplement number ${i} for daily wellness.`,
      });
    }

    const results = await retrieve(tenant.id, "vitamin supplement", 2);
    expect(results).toHaveLength(2);
  });

  it("returns an empty array when the tenant has no documents", async () => {
    const tenant = await makeTenant("empty");
    expect(await retrieve(tenant.id, "anything", 3)).toEqual([]);
  });
});

describe("retrieve with reranking", () => {
  it("defaults to plain hybrid mode when opts is omitted", async () => {
    const { rerank } = await import("../lib/voyage");
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "Paracetamol relieves fever." });

    await retrieve(tenant.id, "fever", 3);

    expect(rerank).not.toHaveBeenCalled();
  });

  it("calls rerank when mode is hybrid+rerank", async () => {
    const { rerank } = await import("../lib/voyage");
    vi.mocked(rerank).mockResolvedValue([0]);
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "Paracetamol relieves fever." });

    const results = await retrieve(tenant.id, "fever", 3, { mode: "hybrid+rerank" });

    expect(rerank).toHaveBeenCalledOnce();
    expect(results[0]!.externalId).toBe("sku-1");
  });

  it("degrades to fusion order when rerank throws", async () => {
    const { rerank } = await import("../lib/voyage");
    vi.mocked(rerank).mockRejectedValue(new Error("Voyage rerank request failed (500)"));
    const tenant = await makeTenant("acme");
    await upsertDocument(tenant.id, { externalId: "sku-1", content: "Paracetamol relieves fever." });

    const results = await retrieve(tenant.id, "fever", 3, { mode: "hybrid+rerank" });

    expect(results).toHaveLength(1);
    expect(results[0]!.externalId).toBe("sku-1");
  });
});
