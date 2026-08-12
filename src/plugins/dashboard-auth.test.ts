import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";

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

  const { default: dashboardAuthPlugin, requireDashboardTenant } = await import("./dashboard-auth");

  app = Fastify();
  await app.register(
    async (dashboard) => {
      await dashboard.register(dashboardAuthPlugin);
      dashboard.get("/whoami", async (request) => ({ userId: request.dashboardUserId }));
      dashboard.get(
        "/tenant-only",
        { preHandler: requireDashboardTenant },
        async (request) => ({ tenantId: request.tenant!.id }),
      );
    },
    { prefix: "/dashboard" },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

describe("dashboardAuthPlugin", () => {
  it("resolves a valid token to a dashboardUserId", async () => {
    verifySupabaseTokenMock.mockResolvedValueOnce({ id: "00000000-0000-0000-0000-000000000001", email: "a@b.com" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/whoami",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/whoami" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects an invalid token", async () => {
    verifySupabaseTokenMock.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/whoami",
      headers: { authorization: "Bearer bad-token" },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("requireDashboardTenant", () => {
  it("resolves the tenant owned by the authenticated user", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });
    verifySupabaseTokenMock.mockResolvedValueOnce({ id: "00000000-0000-0000-0000-000000000001", email: "a@b.com" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant-only",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tenantId).toBe(tenant.id);
  });

  it("returns 404 when the authenticated user has no tenant", async () => {
    verifySupabaseTokenMock.mockResolvedValueOnce({ id: "00000000-0000-0000-0000-000000000099", email: "a@b.com" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant-only",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(res.statusCode).toBe(404);
  });
});
