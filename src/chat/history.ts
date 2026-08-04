import type { ModelMessage } from "ai";
import { getIntentSummary, getRecentMessages } from "./conversations.service";

const HISTORY_WINDOW = 6;

/**
 * A sliding window of recent turns plus a rolling summary, not the full
 * transcript — bounds token cost as a conversation grows, so turn 50 costs
 * roughly what turn 6 costs. Every message is still preserved in full in the
 * database (see conversations.service) — this is only what gets SENT to the
 * model on each call, never what gets stored.
 */
export async function buildContext(conversationId: string): Promise<ModelMessage[]> {
  const [recent, summary] = await Promise.all([
    getRecentMessages(conversationId, HISTORY_WINDOW),
    getIntentSummary(conversationId),
  ]);

  const recentMessages: ModelMessage[] = recent.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (!summary) return recentMessages;

  return [{ role: "system", content: `Earlier context: ${summary}` }, ...recentMessages];
}
