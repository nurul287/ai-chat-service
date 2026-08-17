import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, chunks, documents, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { buildApp } from "../app";

vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => Array.from({ length: 1024 }, () => 0.01))),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
}));

const verifySupabaseTokenMock = vi.fn();
vi.mock("../lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

async function clean() {
  await db.delete(chunks);
  await db.delete(documents);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

let app: FastifyInstance;

beforeEach(async () => {
  await clean();
  vi.clearAllMocks();
  app = buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

function auth(userId: string) {
  verifySupabaseTokenMock.mockResolvedValueOnce({ id: userId, email: "a@b.com" });
  return { authorization: "Bearer valid-token" };
}

describe("dashboard document routes", () => {
  it("creates, lists, and deletes a document scoped to the owner's tenant", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const put = await app.inject({
      method: "PUT",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-000000000001"),
      payload: { externalId: "doc-1", title: "Hello", content: "World" },
    });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].externalId).toBe("doc-1");

    const del = await app.inject({
      method: "DELETE",
      url: "/dashboard/documents/doc-1",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.deleted).toBe(true);

    void tenant;
  });

  it("never lists another tenant's documents", async () => {
    await createTenant({ name: "A", slug: "a", ownerUserId: "00000000-0000-0000-0000-00000000000a" });
    await createTenant({ name: "B", slug: "b", ownerUserId: "00000000-0000-0000-0000-00000000000b" });

    await app.inject({
      method: "PUT",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-00000000000a"),
      payload: { externalId: "doc-1", content: "A's document" },
    });

    const list = await app.inject({
      method: "GET",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-00000000000b"),
    });

    expect(list.json().data).toHaveLength(0);
  });

  it("returns 404 for a user with no tenant yet", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/documents",
      headers: auth("00000000-0000-0000-0000-000000000099"),
    });
    expect(res.statusCode).toBe(404);
  });
});
