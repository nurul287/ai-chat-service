import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

function toOpenApiPath(url: string): string {
  return url.replace(/:(\w+)/g, "{$1}");
}

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
});
