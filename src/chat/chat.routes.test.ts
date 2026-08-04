import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiKeys, chatMetrics, conversations, messages, tenants } from "../db/schema";
import { createTenant, issueApiKey } from "../tenants/tenants.service";
import { buildApp } from "../app";

// No route test in this file creates a document, but runChat's tool-use loop
// still resolves search_knowledge's dependency chain down to lib/voyage — mock
// it so a mistaken real network call fails loudly instead of hanging on a
// real API key that test env deliberately doesn't have.
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

// Only the tables this file actually touches — chunks/documents are never
// created here, since every test either mocks streamText entirely or hits
// routes that don't ingest content.
async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

async function tenantWithKey(slug: string) {
  const tenant = await createTenant({ name: slug, slug });
  const { plaintext } = await issueApiKey(tenant.id, "test");
  return { tenant, key: plaintext };
}

function fakeStreamTextResult(parts: unknown[], providerMetadata?: unknown) {
  async function* stream() {
    for (const part of parts) yield part;
  }
  return { stream: stream(), finalStep: Promise.resolve({ providerMetadata }) };
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

describe("POST /v1/chat", () => {
  it("returns a plain 404 without ever starting an SSE stream, for an unknown conversationId", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${key}` },
      payload: { externalUserId: "customer-482", conversationId: crypto.randomUUID(), message: "hi" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { externalUserId: "u1", message: "hi" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a body missing externalUserId", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${key}` },
      payload: { message: "hi" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("streams token, sources, and done events for a new conversation", async () => {
    const { key } = await tenantWithKey("acme");
    const { streamText } = await import("ai");
    vi.mocked(streamText).mockReturnValue(
      fakeStreamTextResult([
        { type: "text-delta", id: "1", text: "Paracetamol" },
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search_knowledge",
          input: {},
          output: [{ externalId: "sku-1" }],
        },
        { type: "finish", totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      ]) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" },
      payload: { externalUserId: "customer-482", message: "Do you have anything for a headache?" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: token");
    expect(res.body).toContain('"text":"Paracetamol"');
    expect(res.body).toContain("event: sources");
    expect(res.body).toContain("event: done");
  });

  it("yields a mid-stream error SSE event, after the 200 has already started, and persists no assistant message", async () => {
    const { key, tenant } = await tenantWithKey("acme");
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant.id, externalUserId: "customer-482" })
      .returning();
    const { streamText } = await import("ai");
    vi.mocked(streamText).mockReturnValue(
      fakeStreamTextResult([{ type: "error", error: new Error("rate limited") }]) as never,
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" },
      payload: { externalUserId: "customer-482", conversationId: conv!.id, message: "hi" },
    });

    // The status can never change once SSE headers are sent, even though the
    // turn itself failed — see docs/errors.md's pre-stream vs. mid-stream split.
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: error");
    expect(res.body).toContain(`"conversationId":"${conv!.id}"`);
    expect(res.body).toContain('"code":"internal_error"');

    const persisted = await db.select().from(messages).where(eq(messages.conversationId, conv!.id));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.role).toBe("user");
  });
});

describe("GET /v1/conversations", () => {
  it("requires externalUserId", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it("lists only the given external user's conversations", async () => {
    const { key, tenant } = await tenantWithKey("acme");
    await db.insert(conversations).values([
      { tenantId: tenant.id, externalUserId: "customer-482" },
      { tenantId: tenant.id, externalUserId: "customer-999" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/v1/conversations?externalUserId=customer-482",
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].externalUserId).toBe("customer-482");
  });

  it("never returns another tenant's conversations", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    await db.insert(conversations).values({ tenantId: a.tenant.id, externalUserId: "customer-482" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/conversations?externalUserId=customer-482",
      headers: { authorization: `Bearer ${b.key}` },
    });

    expect(res.json().data).toHaveLength(0);
  });
});

describe("GET /v1/conversations/:id/messages", () => {
  it("returns the message log in ascending order", async () => {
    const { key, tenant } = await tenantWithKey("acme");
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant.id, externalUserId: "customer-482" })
      .returning();
    await db.insert(messages).values([
      { conversationId: conv!.id, tenantId: tenant.id, role: "user", content: "first" },
      { conversationId: conv!.id, tenantId: tenant.id, role: "assistant", content: "second" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conv!.id}/messages`,
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((m: { content: string }) => m.content)).toEqual(["first", "second"]);
  });

  it("returns 404 for another tenant's conversation", async () => {
    const a = await tenantWithKey("a");
    const b = await tenantWithKey("b");
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: a.tenant.id, externalUserId: "customer-482" })
      .returning();

    const res = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conv!.id}/messages`,
      headers: { authorization: `Bearer ${b.key}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("returns 404 for a genuinely nonexistent conversation, indistinguishable from the above", async () => {
    const { key } = await tenantWithKey("acme");

    const res = await app.inject({
      method: "GET",
      url: `/v1/conversations/${crypto.randomUUID()}/messages`,
      headers: { authorization: `Bearer ${key}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
