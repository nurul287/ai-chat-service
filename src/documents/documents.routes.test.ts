import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, chunks, documents, tenants } from "../db/schema";
import { createTenant, issueApiKey } from "../tenants/tenants.service";
import { buildApp } from "../app";

vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  ),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
}));

async function clean() {
  await db.delete(chunks);
  await db.delete(documents);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

async function tenantWithKey(slug: string) {
  const tenant = await createTenant({ name: slug, slug });
  const { plaintext } = await issueApiKey(tenant.id, "test");
  return { tenant, key: plaintext };
}

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

function put(key: string, body: unknown) {
  return app.inject({
    method: "PUT",
    url: "/v1/documents",
    headers: { authorization: `Bearer ${key}` },
    payload: body as object,
  });
}

describe("PUT /v1/documents", () => {
  it("creates a document", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await put(key, {
      externalId: "sku-1",
      title: "Paracetamol",
      content: "Relieves fever.",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.externalId).toBe("sku-1");
  });

  it("does not leak tenantId in the response body", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await put(key, { externalId: "sku-1", content: "x" });

    expect(res.json().data).not.toHaveProperty("tenantId");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/documents",
      payload: { externalId: "sku-1", content: "x" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects a body missing content", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await put(key, { externalId: "sku-1" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });
});

describe("GET /v1/documents", () => {
  it("lists only the calling tenant's documents", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await put(a.key, { externalId: "a-1", content: "alpha" });
    await put(b.key, { externalId: "b-1", content: "beta" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/documents",
      headers: { authorization: `Bearer ${a.key}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].externalId).toBe("a-1");
    expect(res.json().meta.total).toBe(1);
  });
});

describe("DELETE /v1/documents/:externalId", () => {
  it("deletes the tenant's own document", async () => {
    const { key } = await tenantWithKey("acme");
    await put(key, { externalId: "sku-1", content: "x" });

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/documents/sku-1",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(200);
    expect(await db.select().from(documents)).toHaveLength(0);
  });

  it("returns 404 for another tenant's document", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await put(a.key, { externalId: "sku-1", content: "x" });

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/documents/sku-1",
      headers: { authorization: `Bearer ${b.key}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(await db.select().from(documents)).toHaveLength(1);
  });
});

describe("POST /v1/search", () => {
  it("returns matching chunks for the calling tenant", async () => {
    const { key } = await tenantWithKey("acme");
    await put(key, {
      externalId: "sku-1",
      title: "Paracetamol",
      content: "Paracetamol relieves fever.",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: { authorization: `Bearer ${key}` },
      payload: { query: "paracetamol fever" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThan(0);
    expect(res.json().data[0].externalId).toBe("sku-1");
  });

  it("never returns another tenant's chunks", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await put(a.key, { externalId: "secret", content: "Confidential formulary notes." });

    const res = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: { authorization: `Bearer ${b.key}` },
      payload: { query: "confidential formulary" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });

  it("rejects an empty query", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: { authorization: `Bearer ${key}` },
      payload: { query: "" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /health", () => {
  it("reports ok without authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});

describe("unknown routes", () => {
  it("returns the documented not_found error shape", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});
