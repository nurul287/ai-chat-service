vi.mock("../lib/voyage", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  ),
  embedQuery: vi.fn(async () => Array.from({ length: 1024 }, () => 0.01)),
  rerank: vi.fn(async (_q: string, texts: string[]) => texts.map((_t, i) => i)),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: vi.fn(), generateText: vi.fn() };
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, conversations, messages, tenants } from "../db/schema";
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

describe("POST /widget/chat", () => {
  it("streams a reply for an allowed origin, using a fresh session id", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);
    const { streamText } = await import("ai");
    vi.mocked(streamText).mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", id: "1", text: "Hello" };
        yield { type: "finish", totalUsage: {} };
      })(),
      finalStep: Promise.resolve({ providerMetadata: undefined }),
    } as never);

    const res = await app.inject({
      method: "POST",
      url: "/widget/chat",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com", accept: "text/event-stream" },
      payload: { externalUserId: "visitor-1", message: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: token");
    expect(res.body).toContain("event: done");
  });

  it("withholds the sources and tool_call events that /v1/chat streams, without dropping token/done", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);
    const { streamText } = await import("ai");
    // The same shape chat.routes.test.ts's "streams token, sources, and
    // done events" test uses — asserted in the opposite direction here,
    // because this route's caller is an anonymous browser rather than the
    // tenant's own backend.
    vi.mocked(streamText).mockReturnValue({
      stream: (async function* () {
        yield { type: "text-delta", id: "1", text: "Paracetamol" };
        yield {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search_knowledge",
          input: {},
          // `content` and `metadata` are the two fields that must never
          // reach a public browser — metadata is arbitrary tenant JSON.
          output: [
            {
              externalId: "sku-1",
              content: "INTERNAL-CHUNK-CONTENT",
              metadata: { costPrice: "SECRET-COST-PRICE" },
            },
          ],
        };
        yield {
          type: "tool-result",
          toolCallId: "c2",
          toolName: "lookup_order",
          input: { orderId: "A-1" },
          // A Sprint 3 custom tool's RAW upstream response body.
          output: { status: "shipped", internalNote: "SECRET-CRM-PAYLOAD" },
        };
        yield { type: "finish", totalUsage: {} };
      })(),
      finalStep: Promise.resolve({ providerMetadata: undefined }),
    } as never);

    const res = await app.inject({
      method: "POST",
      url: "/widget/chat",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com", accept: "text/event-stream" },
      payload: { externalUserId: "visitor-1", message: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    // Still streamed — the widget client needs all of these.
    expect(res.body).toContain("event: token");
    expect(res.body).toContain('"text":"Paracetamol"');
    expect(res.body).toContain("event: done");

    // Withheld.
    expect(res.body).not.toContain("event: sources");
    expect(res.body).not.toContain("event: tool_call");
    // Not just the frame names — the payloads themselves must be absent.
    expect(res.body).not.toContain("INTERNAL-CHUNK-CONTENT");
    expect(res.body).not.toContain("SECRET-COST-PRICE");
    expect(res.body).not.toContain("SECRET-CRM-PAYLOAD");
    expect(res.body).not.toContain("lookup_order");
  });

  it("still streams a mid-stream error event, which the widget needs to show a failure", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);
    const { streamText } = await import("ai");
    vi.mocked(streamText).mockReturnValue({
      stream: (async function* () {
        yield { type: "error", error: new Error("rate limited") };
      })(),
      finalStep: Promise.resolve({ providerMetadata: undefined }),
    } as never);

    const res = await app.inject({
      method: "POST",
      url: "/widget/chat",
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com", accept: "text/event-stream" },
      payload: { externalUserId: "visitor-1", message: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: error");
  });

  it("rejects a request from a disallowed origin before ever starting a stream", async () => {
    const { key } = await tenantWithPublishableKey("acme", ["https://acme.com"]);

    const res = await app.inject({
      method: "POST",
      url: "/widget/chat",
      headers: { authorization: `Bearer ${key}`, origin: "https://evil.example.com" },
      payload: { externalUserId: "visitor-1", message: "hi" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
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

describe("GET /widget/conversations/:id/messages", () => {
  it("returns the message log for the conversation's own visitor", async () => {
    const { key, tenant } = await tenantWithPublishableKey("acme", ["https://acme.com"]);
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant.id, externalUserId: "visitor-1" })
      .returning();
    await db.insert(messages).values([
      { conversationId: conv!.id, tenantId: tenant.id, role: "user", content: "hi" },
      { conversationId: conv!.id, tenantId: tenant.id, role: "assistant", content: "hello!" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/widget/conversations/${conv!.id}/messages?externalUserId=visitor-1`,
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((m: { content: string }) => m.content)).toEqual(["hi", "hello!"]);
  });

  it("returns 404 when the externalUserId does not match the conversation's own visitor", async () => {
    const { key, tenant } = await tenantWithPublishableKey("acme", ["https://acme.com"]);
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant.id, externalUserId: "visitor-1" })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/widget/conversations/${conv!.id}/messages?externalUserId=visitor-2`,
      headers: { authorization: `Bearer ${key}`, origin: "https://acme.com" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a conversation belonging to another tenant", async () => {
    const a = await tenantWithPublishableKey("a", ["https://a.example.com"]);
    const b = await tenantWithPublishableKey("b", ["https://b.example.com"]);
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: a.tenant.id, externalUserId: "visitor-1" })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/widget/conversations/${conv!.id}/messages?externalUserId=visitor-1`,
      headers: { authorization: `Bearer ${b.key}`, origin: "https://b.example.com" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects a request from a disallowed origin", async () => {
    const { key, tenant } = await tenantWithPublishableKey("acme", ["https://acme.com"]);
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant.id, externalUserId: "visitor-1" })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/widget/conversations/${conv!.id}/messages?externalUserId=visitor-1`,
      headers: { authorization: `Bearer ${key}`, origin: "https://evil.example.com" },
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
