import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { tenantTools, tenants, apiKeys } from "../db/schema";
import { createTenant, issueApiKey } from "../tenants/tenants.service";
import { buildApp } from "../app";

async function clean() {
  await db.delete(tenantTools);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

async function tenantWithKey(slug: string) {
  const tenant = await createTenant({ name: slug, slug });
  const { plaintext } = await issueApiKey(tenant.id, "test");
  return { tenant, key: plaintext };
}

const body = {
  name: "lookup_order",
  description: "Look up an order by ID",
  inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
  endpointUrl: "https://tenant.example.com/tool",
};

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

describe("POST /v1/tools", () => {
  it("registers a tool and returns the hmacSecret exactly once", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers: { authorization: `Bearer ${key}` },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.hmacSecret).toMatch(/^whsec_/);
    expect(res.json().data.name).toBe("lookup_order");
  });

  it("rejects the reserved name search_knowledge", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers: { authorization: `Bearer ${key}` },
      payload: { ...body, name: "search_knowledge" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("rejects a duplicate active name for the same tenant", async () => {
    const { key } = await tenantWithKey("acme");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${key}` }, payload: body });

    const res = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers: { authorization: `Bearer ${key}` },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/tools", payload: body });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/tools", () => {
  it("never includes the hmacSecret", async () => {
    const { key } = await tenantWithKey("acme");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${key}` }, payload: body });

    const res = await app.inject({ method: "GET", url: "/v1/tools", headers: { authorization: `Bearer ${key}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(JSON.stringify(res.json().data)).not.toMatch(/whsec_|hmacSecret/);
  });

  it("never returns another tenant's tools", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${a.key}` }, payload: body });

    const res = await app.inject({ method: "GET", url: "/v1/tools", headers: { authorization: `Bearer ${b.key}` } });

    expect(res.json().data).toHaveLength(0);
  });
});

describe("DELETE /v1/tools/:name", () => {
  it("revokes a tool, which then disappears from the list", async () => {
    const { key } = await tenantWithKey("acme");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${key}` }, payload: body });

    const del = await app.inject({
      method: "DELETE",
      url: "/v1/tools/lookup_order",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/v1/tools", headers: { authorization: `Bearer ${key}` } });
    expect(list.json().data).toHaveLength(0);
  });

  it("returns 404 for an unknown tool name", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/tools/no_such_tool",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 rather than revoking when the name belongs to another tenant", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await app.inject({ method: "POST", url: "/v1/tools", headers: { authorization: `Bearer ${a.key}` }, payload: body });

    const res = await app.inject({
      method: "DELETE",
      url: "/v1/tools/lookup_order",
      headers: { authorization: `Bearer ${b.key}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
