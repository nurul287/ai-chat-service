import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant, issueApiKey, setAllowedOrigins } from "../tenants/tenants.service";
import { buildApp } from "../app";

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

async function tenantWithPublishableKey(slug: string, allowedOrigins: string[]) {
  const tenant = await createTenant({ name: slug, slug });
  await setAllowedOrigins(tenant.id, allowedOrigins);
  const { plaintext } = await issueApiKey(tenant.id, "widget", "publishable");
  return { tenant, key: plaintext };
}

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

describe("POST /widget/session", () => {
  it("mints a fresh externalUserId for an allowed origin", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().externalUserId).toBe("string");
    expect(res.json().externalUserId.length).toBeGreaterThan(0);
  });

  it("mints a different id on each call", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);
    const headers = { authorization: `Bearer ${key}`, origin: "https://acme.com" };

    const first = await app.inject({ method: "POST", url: "/widget/session", headers });
    const second = await app.inject({ method: "POST", url: "/widget/session", headers });

    expect(first.json().externalUserId).not.toBe(second.json().externalUserId);
  });

  it("rejects a request from an origin not on the tenant's allowlist", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}`, origin: "https://evil.example.com" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a request with no Origin header at all", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a secret key, even one that would pass on /v1", async () => {
    const tenant = await createTenant({ name: "acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    const res = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${plaintext}`, origin: "https://acme.com" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("sends Access-Control-Allow-Origin only for the allowed origin, echoing the request Origin", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const allowed = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://acme.com");

    const denied = await app.inject({
      method: "POST",
      url: "/widget/session",
      headers: { authorization: `Bearer ${key}`, origin: "https://evil.example.com" },
    });
    // The critical assertion: CORS must NOT just be "*" or reflect a
    // disallowed origin — a wildcard here would mean the delegate wasn't
    // actually wired up (see this plan's Global Constraints).
    expect(denied.headers["access-control-allow-origin"]).not.toBe("*");
    expect(denied.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
  });

  it("answers a CORS preflight (OPTIONS) without requiring the Authorization header", async () => {
    await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "OPTIONS",
      url: "/widget/session",
      headers: {
        origin: "https://acme.com",
        "access-control-request-method": "POST",
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("https://acme.com");
  });
});

describe("/v1 routes reject publishable keys", () => {
  it("a publishable key on /v1/documents is rejected exactly like an invalid key", async () => {
    const tenant = await createTenant({ name: "acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "widget", "publishable");

    const res = await app.inject({
      method: "GET",
      url: "/v1/documents",
      headers: { authorization: `Bearer ${plaintext}` },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("CORS delegator path-boundary", () => {
  it("does not give a /widget-lookalike path the per-tenant CORS treatment", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    // A plain `startsWith("/widget")` check would incorrectly match this —
    // it starts with the same characters as "/widget" but is not "/widget"
    // itself or anything nested under it. No route needs to exist at this
    // path: the CORS delegator runs on every request regardless of whether
    // it ultimately 404s, so this only exercises the delegator's routing
    // logic, not real route matching.
    const res = await app.inject({
      method: "GET",
      url: "/widget-lookalike",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com" },
    });

    expect(res.headers["access-control-allow-origin"]).not.toBe("https://acme.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not give a /widgets path the per-tenant CORS treatment", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "GET",
      url: "/widgets",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com" },
    });

    expect(res.headers["access-control-allow-origin"]).not.toBe("https://acme.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
