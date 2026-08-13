import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import { db } from "../db";
import { chatMetrics, conversations, messages } from "../db/schema";

export type UsagePoint = { date: string; messages: number; tokens: number };
export type UsageSummary = {
  data: UsagePoint[];
  totals: { conversations: number; messages: number; tokens: number };
};

/**
 * Messages and tokens are two separate grouped queries rather than one
 * join: chat_metrics has one row per assistant turn (the only place
 * token counts live), while messages has one row per user AND assistant
 * message — a join would either double-count or silently drop rows,
 * depending on which side it favored. Merging by date in JS afterwards
 * is simpler and correct either way.
 */
export async function getUsageSummary(tenantId: string, days: number): Promise<UsageSummary> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceIso = since.toISOString();

  const [messagesByDay, tokensByDay, [convTotal], [msgTotal], [tokenTotal]] = await Promise.all([
    db
      .select({
        date: sql<string>`date_trunc('day', ${messages.createdAt})::date::text`,
        count: count(),
      })
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), gte(messages.createdAt, sinceIso)))
      .groupBy(sql`date_trunc('day', ${messages.createdAt})`),
    db
      .select({
        date: sql<string>`date_trunc('day', ${chatMetrics.createdAt})::date::text`,
        tokens: sum(chatMetrics.totalTokens),
      })
      .from(chatMetrics)
      .where(and(eq(chatMetrics.tenantId, tenantId), gte(chatMetrics.createdAt, sinceIso)))
      .groupBy(sql`date_trunc('day', ${chatMetrics.createdAt})`),
    db.select({ total: count() }).from(conversations).where(eq(conversations.tenantId, tenantId)),
    db.select({ total: count() }).from(messages).where(eq(messages.tenantId, tenantId)),
    db.select({ total: sum(chatMetrics.totalTokens) }).from(chatMetrics).where(eq(chatMetrics.tenantId, tenantId)),
  ]);

  const byDate = new Map<string, UsagePoint>();
  for (const row of messagesByDay) {
    byDate.set(row.date, { date: row.date, messages: Number(row.count), tokens: 0 });
  }
  for (const row of tokensByDay) {
    const existing = byDate.get(row.date) ?? { date: row.date, messages: 0, tokens: 0 };
    existing.tokens = Number(row.tokens ?? 0);
    byDate.set(row.date, existing);
  }

  return {
    data: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals: {
      conversations: Number(convTotal!.total),
      messages: Number(msgTotal!.total),
      tokens: Number(tokenTotal!.total ?? 0),
    },
  };
}
