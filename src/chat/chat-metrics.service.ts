import { db } from "../db";
import { chatMetrics } from "../db/schema";

export type RecordChatMetricsInput = {
  conversationId: string;
  messageId: string;
  tenantId: string;
  modelId: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costCredits: number | null;
  toolCallCount: number;
  retrievedChunkCount: number;
};

export async function recordChatMetrics(input: RecordChatMetricsInput): Promise<void> {
  await db.insert(chatMetrics).values({
    conversationId: input.conversationId,
    messageId: input.messageId,
    tenantId: input.tenantId,
    modelId: input.modelId,
    latencyMs: input.latencyMs,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.totalTokens,
    costCredits: input.costCredits === null ? null : String(input.costCredits),
    toolCallCount: input.toolCallCount,
    retrievedChunkCount: input.retrievedChunkCount,
  });
}
