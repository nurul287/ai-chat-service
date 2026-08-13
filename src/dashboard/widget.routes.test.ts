import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { buildApp } from "../app";

const verifySupabaseTokenMock = vi.fn();
vi.mock("../lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

async function clean() {
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

describe("dashboard widget-config routes", () => {
  it("starts with no allowed origins and no publishable key", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({ method: "GET", url: "/dashboard/widget", headers: auth("00000000-0000-0000-0000-000000000001") });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.allowedOrigins).toEqual([]);
    expect(res.json().data.publishableKeyPrefix).toBeNull();
    expect(res.json().data.hasPublishableKey).toBe(false);
  });

  it("sets allowed origins", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const put = await app.inject({
      method: "PUT",
      url: "/dashboard/widget/origins",
      headers: auth("00000000-0000-0000-0000-000000000001"),
      payload: { origins: ["https://acme.com"] },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({ method: "GET", url: "/dashboard/widget", headers: auth("00000000-0000-0000-0000-000000000001") });
    expect(get.json().data.allowedOrigins).toEqual(["https://acme.com"]);
  });

  it("mints a publishable key and reflects its prefix afterwards", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const mint = await app.inject({
      method: "POST",
      url: "/dashboard/widget/publishable-key",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });
    expect(mint.statusCode).toBe(200);
    expect(mint.json().data.plaintext).toMatch(/^pk_live_/);

    const get = await app.inject({ method: "GET", url: "/dashboard/widget", headers: auth("00000000-0000-0000-0000-000000000001") });
    expect(get.json().data.publishableKeyPrefix).toBe(mint.json().data.prefix);
  });
});
