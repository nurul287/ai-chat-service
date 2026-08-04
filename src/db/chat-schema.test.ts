import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { chatMetrics, conversations, messages, tenants } from "./schema";

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(tenants);
}

beforeEach(clean);
afterAll(clean);

describe("conversations, messages, chat_metrics schema", () => {
  it("allows many conversations for the same (tenant, external_user_id)", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    await db.insert(conversations).values({ tenantId: tenant!.id, externalUserId: "u1" });
    await db.insert(conversations).values({ tenantId: tenant!.id, externalUserId: "u1" });

    const rows = await db.select().from(conversations);
    expect(rows).toHaveLength(2);
  });

  it("cascades message deletion when its conversation is deleted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();
    await db.insert(messages).values({
      conversationId: conv!.id,
      tenantId: tenant!.id,
      role: "user",
      content: "hi",
    });

    await db.delete(conversations).where(eq(conversations.id, conv!.id));

    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("rejects a message role outside user/assistant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();

    await expect(
      db.insert(messages).values({
        conversationId: conv!.id,
        tenantId: tenant!.id,
        role: "system" as "user",
        content: "x",
      }),
    ).rejects.toThrow();
  });

  it("cascades chat_metrics deletion when its message is deleted", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "A", slug: "a" }).returning();
    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenant!.id, externalUserId: "u1" })
      .returning();
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, tenantId: tenant!.id, role: "assistant", content: "hi" })
      .returning();
    await db.insert(chatMetrics).values({
      conversationId: conv!.id,
      messageId: msg!.id,
      tenantId: tenant!.id,
      modelId: "deepseek/deepseek-r1:free",
      latencyMs: 500,
    });

    await db.delete(messages).where(eq(messages.id, msg!.id));

    expect(await db.select().from(chatMetrics)).toHaveLength(0);
  });
});
