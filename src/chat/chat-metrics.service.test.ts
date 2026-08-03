import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chatMetrics, conversations, messages, tenants } from "../db/schema";
import { recordChatMetrics } from "./chat-metrics.service";

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

describe("recordChatMetrics", () => {
  it("writes a row with all provided fields", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, tenantId: tenant!.id, role: "assistant", content: "hi" })
      .returning();

    await recordChatMetrics({
      conversationId: conv!.id,
      messageId: msg!.id,
      tenantId: tenant!.id,
      modelId: "deepseek/deepseek-r1:free",
      latencyMs: 842,
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165,
      costCredits: 0,
      toolCallCount: 1,
      retrievedChunkCount: 3,
    });

    const [row] = await db.select().from(chatMetrics).where(eq(chatMetrics.messageId, msg!.id));
    expect(row!.modelId).toBe("deepseek/deepseek-r1:free");
    expect(row!.latencyMs).toBe(842);
    expect(row!.promptTokens).toBe(120);
    expect(row!.toolCallCount).toBe(1);
    expect(row!.retrievedChunkCount).toBe(3);
  });

  it("accepts null for token/cost fields when the provider did not report them", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, tenantId: tenant!.id, role: "assistant", content: "hi" })
      .returning();

    await recordChatMetrics({
      conversationId: conv!.id,
      messageId: msg!.id,
      tenantId: tenant!.id,
      modelId: "some-model",
      latencyMs: 300,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costCredits: null,
      toolCallCount: 0,
      retrievedChunkCount: 0,
    });

    const [row] = await db.select().from(chatMetrics).where(eq(chatMetrics.messageId, msg!.id));
    expect(row!.promptTokens).toBeNull();
    expect(row!.costCredits).toBeNull();
  });
});
