import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

const verifySupabaseTokenMock = vi.fn();
vi.mock("./lib/supabase", () => ({
  verifySupabaseToken: (token: string) => verifySupabaseTokenMock(token) as unknown,
}));

function toOpenApiPath(url: string): string {
  return url.replace(/:(\w+)/g, "{$1}");
}

/**
 * The two routes that must run before a tenant necessarily exists — see
 * requireDashboardTenant's own comment in src/plugins/dashboard-auth.ts.
 * Every other /dashboard route is expected to carry that preHandler.
 */
const NO_TENANT_REQUIRED = new Set(["GET /dashboard/tenant", "POST /dashboard/signup"]);

/**
 * Fixtures for routes whose schema requires a body or a URL param before
 * Fastify's own validation would even let the request reach a preHandler.
 * Values are arbitrary but schema-valid — this sweep only cares whether
 * request.tenant gets resolved, never what these routes actually do.
 */
const ROUTE_FIXTURES: Record<string, { payload?: Record<string, unknown>; params?: Record<string, string> }> = {
  "PUT /dashboard/documents": { payload: { externalId: "sweep-doc", content: "sweep content" } },
  "DELETE /dashboard/documents/:externalId": { params: { externalId: "sweep-doc" } },
  "POST /dashboard/keys": { payload: { name: "sweep-key" } },
  "DELETE /dashboard/keys/:id": { params: { id: "00000000-0000-0000-0000-000000000000" } },
  "PUT /dashboard/widget/origins": { payload: { origins: [] } },
};

describe("OpenAPI spec — /dashboard coverage", () => {
  it("documents every registered /dashboard route", async () => {
    const app = buildApp({ logger: false });

    const registered: string[] = [];
    app.addHook("onRoute", (route) => {
      if (route.url.startsWith("/dashboard") && route.method !== "HEAD") {
        registered.push(toOpenApiPath(route.url));
      }
    });
    await app.ready();

    const spec = app.swagger() as unknown as { paths: Record<string, unknown> };
    const documented = Object.keys(spec.paths);
    await app.close();

    expect(registered.length).toBeGreaterThan(0);
    for (const path of registered) {
      expect(documented).toContain(path);
    }
  });

  it("gives every /dashboard operation a summary and declared security", async () => {
    const app = buildApp({ logger: false });
    await app.ready();

    const spec = app.swagger() as unknown as {
      paths: Record<string, Record<string, { summary?: string; security?: unknown; operationId?: string }>>;
    };
    await app.close();

    const dashboardPaths = Object.entries(spec.paths).filter(([path]) => path.startsWith("/dashboard"));
    expect(dashboardPaths.length).toBeGreaterThan(0);

    for (const [path, operations] of dashboardPaths) {
      for (const [method, operation] of Object.entries(operations)) {
        expect(operation.summary, `${method.toUpperCase()} ${path} has no summary`).toBeTruthy();
        expect(operation.security, `${method.toUpperCase()} ${path} declares no security`).toBeDefined();
        expect(operation.operationId, `${method.toUpperCase()} ${path} has no operationId`).toBeTruthy();
      }
    }
  });

  it("enforces requireDashboardTenant on every /dashboard route except GET /tenant and POST /signup", async () => {
    const app = buildApp({ logger: false });

    const registered: { method: string; url: string }[] = [];
    app.addHook("onRoute", (route) => {
      if (route.url.startsWith("/dashboard") && route.method !== "HEAD") {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const method of methods) registered.push({ method, url: route.url });
      }
    });
    await app.ready();

    expect(registered.length).toBeGreaterThan(0);

    const noTenantUserId = "00000000-0000-0000-0000-0000000000fe";

    for (const { method, url } of registered) {
      const key = `${method} ${url}`;
      if (NO_TENANT_REQUIRED.has(key)) continue;

      const fixture = ROUTE_FIXTURES[key];
      let injectUrl = url;
      for (const [name, value] of Object.entries(fixture?.params ?? {})) {
        injectUrl = injectUrl.replace(`:${name}`, value);
      }

      verifySupabaseTokenMock.mockResolvedValueOnce({ id: noTenantUserId, email: "no-tenant@example.com" });

      const res = await app.inject({
        method: method as "GET" | "POST" | "PUT" | "DELETE",
        url: injectUrl,
        headers: { authorization: "Bearer valid-token" },
        payload: fixture?.payload,
      });

      expect(res.statusCode, `${key} did not 404 for a caller with no tenant`).toBe(404);
    }

    await app.close();
  });
});
