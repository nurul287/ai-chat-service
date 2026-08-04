import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { chatMetrics, conversations, messages, tenants } from "../db/schema";
import {
  appendMessage,
  countUserMessages,
  createConversation,
  getConversation,
  getConversationByIdForTenant,
  getIntentSummary,
  getRecentMessages,
  listConversations,
  listMessages,
  updateIntentSummary,
} from "./conversations.service";

async function clean() {
  await db.delete(chatMetrics);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(tenants);
}

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(tenants).values({ name: slug, slug }).returning();
  return tenant!;
}

beforeEach(clean);
afterAll(clean);

describe("createConversation / getConversation", () => {
  it("creates and then retrieves a conversation for the same tenant + external user", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    const found = await getConversation(tenant.id, "customer-482", conv.id);
    expect(found?.id).toBe(conv.id);
  });

  it("returns null for another tenant's conversation", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    const conv = await createConversation(a.id, "customer-482");

    expect(await getConversation(b.id, "customer-482", conv.id)).toBeNull();
  });

  it("returns null for another external user's conversation within the same tenant", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    expect(await getConversation(tenant.id, "customer-999", conv.id)).toBeNull();
  });

  it("returns null for a genuinely nonexistent id, indistinguishable from the above", async () => {
    const tenant = await makeTenant("acme");
    expect(await getConversation(tenant.id, "customer-482", crypto.randomUUID())).toBeNull();
  });

  it("allows many conversations for the same (tenant, externalUserId)", async () => {
    const tenant = await makeTenant("acme");
    await createConversation(tenant.id, "customer-482");
    await createConversation(tenant.id, "customer-482");

    const { total } = await listConversations(tenant.id, "customer-482", 1, 20);
    expect(total).toBe(2);
  });
});

describe("listConversations", () => {
  it("returns only the given tenant + external user's threads", async () => {
    const tenant = await makeTenant("acme");
    await createConversation(tenant.id, "customer-482");
    await createConversation(tenant.id, "customer-999");

    const { data, total } = await listConversations(tenant.id, "customer-482", 1, 20);
    expect(total).toBe(1);
    expect(data[0]!.externalUserId).toBe("customer-482");
  });
});

describe("messages", () => {
  it("appendMessage writes a row with the given role and content", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    const msg = await appendMessage(conv.id, tenant.id, "user", "Do you have anything for a headache?");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Do you have anything for a headache?");
  });

  it("appendMessage bumps the parent conversation updatedAt so listConversations reflects recent activity", async () => {
    const tenant = await makeTenant("acme");
    const older = await createConversation(tenant.id, "customer-482");
    const newer = await createConversation(tenant.id, "customer-482");

    let { data } = await listConversations(tenant.id, "customer-482", 1, 20);
    expect(data[0]!.id).toBe(newer.id);

    await appendMessage(older.id, tenant.id, "user", "wake up");

    ({ data } = await listConversations(tenant.id, "customer-482", 1, 20));
    expect(data[0]!.id).toBe(older.id);
  });

  it("listMessages returns ascending order (oldest first)", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");
    await appendMessage(conv.id, tenant.id, "user", "first");
    await appendMessage(conv.id, tenant.id, "assistant", "second");

    const { data } = await listMessages(conv.id, 1, 20);
    expect(data.map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("getRecentMessages returns at most `limit` messages, oldest-of-the-window first", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");
    for (let i = 0; i < 5; i++) {
      await appendMessage(conv.id, tenant.id, "user", `turn-${i}`);
    }

    const recent = await getRecentMessages(conv.id, 3);
    expect(recent.map((m) => m.content)).toEqual(["turn-2", "turn-3", "turn-4"]);
  });
});

describe("countUserMessages", () => {
  it("counts only user-role messages, not assistant replies", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");
    await appendMessage(conv.id, tenant.id, "user", "first");
    await appendMessage(conv.id, tenant.id, "assistant", "reply");
    await appendMessage(conv.id, tenant.id, "user", "second");

    expect(await countUserMessages(conv.id)).toBe(2);
  });
});

describe("getConversationByIdForTenant", () => {
  it("returns the conversation for the owning tenant, regardless of external user", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    const found = await getConversationByIdForTenant(tenant.id, conv.id);
    expect(found?.id).toBe(conv.id);
  });

  it("returns null for another tenant's conversation", async () => {
    const a = await makeTenant("a");
    const b = await makeTenant("b");
    const conv = await createConversation(a.id, "customer-482");

    expect(await getConversationByIdForTenant(b.id, conv.id)).toBeNull();
  });

  it("returns null for a genuinely nonexistent id, indistinguishable from the above", async () => {
    const tenant = await makeTenant("acme");
    expect(await getConversationByIdForTenant(tenant.id, crypto.randomUUID())).toBeNull();
  });
});

describe("intent summary", () => {
  it("is null until explicitly set", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    expect(await getIntentSummary(conv.id)).toBeNull();
  });

  it("updateIntentSummary sets it, and getIntentSummary reads it back", async () => {
    const tenant = await makeTenant("acme");
    const conv = await createConversation(tenant.id, "customer-482");

    await updateIntentSummary(conv.id, "Customer is asking about headache remedies.");

    expect(await getIntentSummary(conv.id)).toBe("Customer is asking about headache remedies.");
  });
});
