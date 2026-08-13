import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, chatMetrics, conversations, messages, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { buildApp } from "../app";

const verifySupabaseTokenMock = vi.fn();
vi.mock("../lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
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

describe("GET /dashboard/usage", () => {
  it("returns usage totals for the authenticated tenant", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({ method: "GET", url: "/dashboard/usage", headers: auth("00000000-0000-0000-0000-000000000001") });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.totals).toEqual({ conversations: 0, messages: 0, tokens: 0 });
  });

  it("respects the days query param", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/usage?days=7",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for a user with no tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/usage",
      headers: auth("00000000-0000-0000-0000-000000000099"),
    });
    expect(res.statusCode).toBe(404);
  });
});
