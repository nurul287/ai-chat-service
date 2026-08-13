import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant, verifyApiKey } from "../tenants/tenants.service";
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
  verifySupabaseTokenMock.mockResolvedValueOnce({ id: userId, email: "owner@acme.com" });
  return { authorization: "Bearer valid-token" };
}

describe("GET /dashboard/tenant", () => {
  it("returns the tenant owned by the authenticated user", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant",
      headers: auth("00000000-0000-0000-0000-000000000001"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(tenant.id);
    expect(res.json().data.slug).toBe("acme");
  });

  it("returns 404 when this user has no tenant yet", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant",
      headers: auth("00000000-0000-0000-0000-000000000099"),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /dashboard/signup", () => {
  it("creates a tenant and mints a default secret key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/dashboard/signup",
      headers: auth("00000000-0000-0000-0000-000000000002"),
      payload: { tenantName: "New Co", tenantSlug: "new-co" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.tenant.slug).toBe("new-co");
    expect(body.apiKey.plaintext).toMatch(/^sk_live_/);
    // Proves the key isn't just correctly-shaped but actually works —
    // both inserts from the signup transaction landed, not just the
    // tenant row.
    expect((await verifyApiKey(body.apiKey.plaintext))?.id).toBe(body.tenant.id);
  });

  it("returns 409 when this user already has a tenant", async () => {
    await createTenant({ name: "Acme", slug: "acme", ownerUserId: "00000000-0000-0000-0000-000000000001" });

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/signup",
      headers: auth("00000000-0000-0000-0000-000000000001"),
      payload: { tenantName: "Second Co", tenantSlug: "second-co" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when the slug is already taken by a different owner", async () => {
    await createTenant({ name: "Acme", slug: "taken-slug" });

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/signup",
      headers: auth("00000000-0000-0000-0000-000000000002"),
      payload: { tenantName: "New Co", tenantSlug: "taken-slug" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("rejects an uppercase slug", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/dashboard/signup",
      headers: auth("00000000-0000-0000-0000-000000000002"),
      payload: { tenantName: "New Co", tenantSlug: "New-Co" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("CORS for /dashboard/*", () => {
  // NODE_ENV is "test" in this suite (never "production"), so the
  // delegator's dev-only http://localhost:5173 fallback is the branch
  // exercised here. DASHBOARD_URL itself isn't set in local dev/test env,
  // so this is the one of the two allowed-origin checks that's reachable
  // without mocking config — but both checks share the same `allowed`
  // expression in src/app.ts, so exercising one exercises the branch logic
  // (as opposed to, say, a stale wildcard `*` origin, which is the actual
  // regression class this guards against — see the equivalent /widget
  // test in src/widget/widget.routes.test.ts).
  it("echoes back the allowed dev origin (http://localhost:5173) in Access-Control-Allow-Origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant",
      headers: { ...auth("00000000-0000-0000-0000-000000000001"), origin: "http://localhost:5173" },
    });

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("does not echo back a disallowed origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/tenant",
      headers: { ...auth("00000000-0000-0000-0000-000000000001"), origin: "https://evil.example.com" },
    });

    // The critical assertion: CORS must NOT just be "*" or reflect a
    // disallowed origin — a wildcard here would mean the delegate wasn't
    // actually wired up for this branch.
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
  });

  it("answers a CORS preflight (OPTIONS) without requiring the Authorization header", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/dashboard/tenant",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});
