import { generateText } from "ai";
import { trackBackgroundWork } from "../lib/background-work";
import { getRecentMessages, updateIntentSummary } from "./conversations.service";
import { chatModel } from "./model";

const SUMMARY_TURN_INTERVAL = 3;
const SUMMARY_WINDOW = 12;

/**
 * Fire-and-forget, same discipline as verifyApiKey's last_used_at write in
 * Sprint 1: never awaited by the caller, never allowed to fail or delay the
 * actual chat reply. Runs through the SAME chat model/provider as the main
 * conversation — not a separate config — since splitting them isn't earning
 * its keep while both are free (see the design spec's rationale).
 */
export function maybeRefreshIntentSummary(conversationId: string, userTurnCount: number): void {
  if (userTurnCount % SUMMARY_TURN_INTERVAL !== 0) return;

  trackBackgroundWork(refresh(conversationId).catch(() => {}));
}

async function refresh(conversationId: string): Promise<void> {
  const recent = await getRecentMessages(conversationId, SUMMARY_WINDOW);
  const transcript = recent.map((m) => `${m.role}: ${m.content}`).join("\n");

  const { text } = await generateText({
    model: chatModel,
    prompt: `Summarize the customer's intent and key facts from this conversation in one or two short sentences, for use as context in later turns:\n\n${transcript}`,
  });

  await updateIntentSummary(conversationId, text.trim());
}
