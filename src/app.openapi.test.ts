import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

/** Fastify route params are `:externalId`; OpenAPI paths are `{externalId}`. */
function toOpenApiPath(url: string): string {
  return url.replace(/:(\w+)/g, "{$1}");
}

describe("OpenAPI spec", () => {
  it("serves a spec naming the service and its security scheme", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBeTruthy();
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  it("documents every registered /v1 route", async () => {
    const app = buildApp({ logger: false });

    // `register` is deferred until ready(), so a hook added here still sees
    // every route the plugins go on to register.
    const registered: string[] = [];
    app.addHook("onRoute", (route) => {
      if (route.url.startsWith("/v1") && route.method !== "HEAD") {
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

  // Path presence alone is NOT enough: @fastify/swagger auto-includes a route
  // that has no schema at all, inventing a bare 200 response for it. So the
  // real "cannot ship undocumented" guard is that every /v1 operation carries
  // the things only a hand-written schema block produces — a summary and a
  // declared security requirement.
  it("gives every /v1 operation a summary and declared security", async () => {
    const app = buildApp({ logger: false });
    await app.ready();

    const spec = app.swagger() as unknown as {
      paths: Record<
        string,
        Record<string, { summary?: string; security?: unknown; operationId?: string }>
      >;
    };
    await app.close();

    const v1Paths = Object.entries(spec.paths).filter(([path]) => path.startsWith("/v1"));
    expect(v1Paths.length).toBeGreaterThan(0);

    for (const [path, operations] of v1Paths) {
      for (const [method, operation] of Object.entries(operations)) {
        expect(operation.summary, `${method.toUpperCase()} ${path} has no summary`).toBeTruthy();
        expect(
          operation.security,
          `${method.toUpperCase()} ${path} declares no security`,
        ).toBeDefined();
        // operationId is what client generators turn into a method name — an
        // endpoint without one produces `putV1Documents` in every SDK.
        expect(
          operation.operationId,
          `${method.toUpperCase()} ${path} has no operationId`,
        ).toBeTruthy();
      }
    }
  });

  it("declares a servers entry", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    await app.close();

    // Required by the OpenAPI spec; without it a generated client has no base
    // URL. Redocly's no-empty-servers rule fails the spec outright.
    expect(res.json().servers?.length).toBeGreaterThan(0);
  });

  it("describes the request body of PUT /v1/documents", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    await app.close();

    const spec = res.json();
    const body = spec.paths["/v1/documents"].put.requestBody.content["application/json"].schema;
    expect(body.required).toContain("externalId");
    expect(body.required).toContain("content");
  });

  it("serves the browsable UI without authentication", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/docs" });
    await app.close();

    // swagger-ui redirects /docs -> /docs/static/index.html
    expect([200, 302]).toContain(res.statusCode);
  });
});
