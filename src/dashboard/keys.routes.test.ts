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

describe("dashboard key routes", () => {
  it("creates, lists, and revokes a secret key", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const create = await app.inject({
      method: "POST",
      url: "/dashboard/keys",
      headers: auth("00000000-0000-0000-0000-000000000001"),
      payload: { name: "production" },
    });
    expect(create.statusCode).toBe(200);
    const plaintext = create.json().data.plaintext as string;
    expect(plaintext).toMatch(/^sk_live_/);
    const keyId = create.json().data.id as string;

    const list = await app.inject({ method: "GET", url: "/dashboard/keys", headers: auth("00000000-0000-0000-0000-000000000001") });
    expect(list.json().data.some((k: { name: string }) => k.name === "production")).toBe(true);
    expect(JSON.stringify(list.json())).not.toContain(plaintext);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/dashboard/keys/${keyId}`,
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });
    expect(revoke.statusCode).toBe(200);
  });

  it("returns 404 when revoking a key that isn't this tenant's", async () => {
    await createTenant({ name: "A", slug: "a", ownerUserId: "00000000-0000-0000-0000-00000000000a" });
    await createTenant({ name: "B", slug: "b", ownerUserId: "00000000-0000-0000-0000-00000000000b" });

    const create = await app.inject({
      method: "POST",
      url: "/dashboard/keys",
      headers: auth("00000000-0000-0000-0000-00000000000a"),
      payload: { name: "a-key" },
    });
    const keyId = create.json().data.id as string;

    const revoke = await app.inject({
      method: "DELETE",
      url: `/dashboard/keys/${keyId}`,
      headers: auth("00000000-0000-0000-0000-00000000000b"),
    });
    expect(revoke.statusCode).toBe(404);
  });

  it("lists only secret keys, not publishable keys", async () => {
    const { issueApiKey } = await import("../tenants/tenants.service");
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });
    const tenant = await import("../tenants/tenants.service").then((m) =>
      m.getTenantByOwnerUserId("00000000-0000-0000-0000-000000000001"),
    );

    // Issue one secret key and one publishable key
    await issueApiKey(tenant!.id, "secret-key", "secret");
    await issueApiKey(tenant!.id, "publishable-key", "publishable");

    const list = await app.inject({
      method: "GET",
      url: "/dashboard/keys",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });
    expect(list.statusCode).toBe(200);
    const keys = list.json().data as Array<{ name: string }>;
    expect(keys.some((k) => k.name === "secret-key")).toBe(true);
    expect(keys.some((k) => k.name === "publishable-key")).toBe(false);
  });
});
