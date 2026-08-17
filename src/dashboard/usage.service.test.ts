import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { apiKeys, chatMetrics, conversations, messages, tenants } from "../db/schema";
import { createTenant } from "../tenants/tenants.service";
import { getUsageSummary } from "./usage.service";

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(apiKeys);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

describe("getUsageSummary", () => {
  it("totals messages, conversations, and tokens for the tenant", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const [conversation] = await db
      .insert(conversations)
      .values({ tenantId: tenant.id, externalUserId: "visitor-1" })
      .returning();
    const [userMsg] = await db
      .insert(messages)
      .values({ conversationId: conversation!.id, tenantId: tenant.id, role: "user", content: "Hi" })
      .returning();
    const [assistantMsg] = await db
      .insert(messages)
      .values({ conversationId: conversation!.id, tenantId: tenant.id, role: "assistant", content: "Hello" })
      .returning();
    await db.insert(chatMetrics).values({
      conversationId: conversation!.id,
      messageId: assistantMsg!.id,
      tenantId: tenant.id,
      modelId: "test-model",
      latencyMs: 100,
      totalTokens: 42,
    });

    const summary = await getUsageSummary(tenant.id, 30);

    expect(summary.totals.conversations).toBe(1);
    expect(summary.totals.messages).toBe(2);
    expect(summary.totals.tokens).toBe(42);
    expect(summary.data.length).toBeGreaterThan(0);
    expect(summary.data[0]!.messages).toBe(2);
    expect(summary.data[0]!.tokens).toBe(42);

    void userMsg;
  });

  it("never includes another tenant's usage", async () => {
    const tenantA = await createTenant({ name: "A", slug: "a" });
    const tenantB = await createTenant({ name: "B", slug: "b" });
    const [conversation] = await db
      .insert(conversations)
      .values({ tenantId: tenantA.id, externalUserId: "visitor-1" })
      .returning();
    await db
      .insert(messages)
      .values({ conversationId: conversation!.id, tenantId: tenantA.id, role: "user", content: "Hi" });

    const summary = await getUsageSummary(tenantB.id, 30);

    expect(summary.totals.messages).toBe(0);
    expect(summary.totals.conversations).toBe(0);
    expect(summary.data).toHaveLength(0);
  });

  it("returns zeroed totals for a tenant with no activity", async () => {
    const tenant = await createTenant({ name: "Acme", slug: "acme" });
    const summary = await getUsageSummary(tenant.id, 30);

    expect(summary.totals).toEqual({ conversations: 0, messages: 0, tokens: 0 });
    expect(summary.data).toEqual([]);
  });
});
