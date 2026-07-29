import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, tenants } from "../db/schema";
import { createTenant, issueApiKey } from "../tenants/tenants.service";
import authPlugin from "./auth";

async function clean() {
  await db.delete(apiKeys);
  await db.delete(tenants);
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();

  // Deliberately registered on the ROOT instance, outside the /v1 scope.
  app.get("/health", async () => ({ status: "ok" }));

  await app.register(
    async (v1) => {
      await v1.register(authPlugin);
      v1.get("/whoami", async (request) => ({ tenantId: request.tenant!.id }));
    },
    { prefix: "/v1" },
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await clean();
});

beforeEach(clean);

describe("auth plugin", () => {
  it("resolves a valid key to its tenant", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");

    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${plaintext}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tenantId).toBe(tenant.id);
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/whoami" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: "sk_live_no-bearer-prefix" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: "Bearer sk_live_nope" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked key", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const { plaintext } = await issueApiKey(tenant.id, "default");
    const [row] = await db.select().from(apiKeys);
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, row!.id));

    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${plaintext}` },
    });

    expect(res.statusCode).toBe(401);
  });

  // The scoping guarantee: the preHandler must not leak outside /v1.
  it("leaves routes outside the /v1 scope unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});
