import { and, asc, count, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { conversations, messages, type Conversation, type Message } from "../db/schema";

export async function createConversation(
  tenantId: string,
  externalUserId: string,
): Promise<Conversation> {
  const [conv] = await db.insert(conversations).values({ tenantId, externalUserId }).returning();
  return conv!;
}

/**
 * Returns null on ANY mismatch — wrong tenant, wrong external user, or a
 * genuinely nonexistent id — never distinguishing which. Matching Sprint 1's
 * anti-probing contract: a caller must not be able to tell "not yours" from
 * "doesn't exist".
 */
export async function getConversation(
  tenantId: string,
  externalUserId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.tenantId, tenantId),
        eq(conversations.externalUserId, externalUserId),
      ),
    );
  return conv ?? null;
}

export async function listConversations(
  tenantId: string,
  externalUserId: string,
  page: number,
  limit: number,
): Promise<{ data: Conversation[]; total: number }> {
  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.externalUserId, externalUserId)))
      .orderBy(desc(conversations.updatedAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ total: count() })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.externalUserId, externalUserId))),
  ]);

  return { data: rows, total: Number(totals!.total) };
}

export async function appendMessage(
  conversationId: string,
  tenantId: string,
  role: "user" | "assistant",
  content: string,
): Promise<Message> {
  const [msg] = await db.insert(messages).values({ conversationId, tenantId, role, content }).returning();
  await db
    .update(conversations)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(conversations.id, conversationId));
  return msg!;
}

/**
 * Ascending by createdAt — a chat log reads top-to-bottom. This is the
 * opposite default from Sprint 1's listDocuments (descending by updatedAt),
 * which is worth remembering rather than copying that precedent blindly.
 */
export async function listMessages(
  conversationId: string,
  page: number,
  limit: number,
): Promise<{ data: Message[]; total: number }> {
  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: count() }).from(messages).where(eq(messages.conversationId, conversationId)),
  ]);

  return { data: rows, total: Number(totals!.total) };
}

/** The last `limit` messages, returned oldest-of-the-window first — ready to
 *  append directly after a system/summary message when building model context. */
export async function getRecentMessages(conversationId: string, limit: number): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function getIntentSummary(conversationId: string): Promise<string | null> {
  const [conv] = await db
    .select({ intentSummary: conversations.intentSummary })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return conv?.intentSummary ?? null;
}

export async function updateIntentSummary(conversationId: string, summary: string): Promise<void> {
  await db
    .update(conversations)
    .set({ intentSummary: summary, updatedAt: new Date().toISOString() })
    .where(eq(conversations.id, conversationId));
}

export async function countUserMessages(conversationId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")));
  return Number(row!.total);
}

/**
 * Tenant-only ownership check, distinct from getConversation's three-way
 * check. GET /v1/conversations/:id/messages has no externalUserId in its
 * path — only POST /v1/chat's body carries one, since only that request
 * claims to act as a specific external user. Without this check in front of
 * listMessages, any tenant could read any other tenant's messages by
 * guessing a conversation id.
 */
export async function getConversationByIdForTenant(
  tenantId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
  return conv ?? null;
}
