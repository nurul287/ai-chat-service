import { isStepCount, streamText } from "ai";
import { config } from "../config";
import type { RetrievedChunk } from "../retrieval/retrieve";
import { recordChatMetrics } from "./chat-metrics.service";
import {
  appendMessage,
  countUserMessages,
  createConversation,
  getConversation,
} from "./conversations.service";
import { buildContext } from "./history";
import { maybeRefreshIntentSummary } from "./intent-summary";
import { chatModel } from "./model";
import { adaptStream } from "./stream-adapter";
import { searchKnowledgeTool } from "./tools/search-knowledge";

export class ConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found for this tenant and external user");
    this.name = "ConversationNotFoundError";
  }
}

export type RunChatInput = {
  tenantId: string;
  externalUserId: string;
  conversationId: string | null;
  message: string;
};

export type ChatWireEvent =
  | { event: "token"; data: { text: string } }
  | { event: "sources"; data: { documents: RetrievedChunk[] } }
  | { event: "tool_call"; data: { toolName: string; arguments: unknown; result: unknown } }
  | { event: "done"; data: { conversationId: string; messageId: string } }
  | {
      event: "error";
      data: { conversationId: string; error: { code: string; message: string } };
    };

const MAX_TOOL_LOOP_STEPS = 4;

export async function* runChat(input: RunChatInput): AsyncGenerator<ChatWireEvent> {
  const startedAt = Date.now();

  const conversation = input.conversationId
    ? await requireOwnedConversation(input.tenantId, input.externalUserId, input.conversationId)
    : await createConversation(input.tenantId, input.externalUserId);

  const context = await buildContext(conversation.id);

  await appendMessage(conversation.id, input.tenantId, "user", input.message);
  const userTurnCount = await countUserMessages(conversation.id);

  const result = streamText({
    model: chatModel,
    messages: [...context, { role: "user", content: input.message }],
    tools: { search_knowledge: searchKnowledgeTool(input.tenantId) },
    stopWhen: isStepCount(MAX_TOOL_LOOP_STEPS),
  });

  let assistantText = "";
  let toolCallCount = 0;
  let retrievedChunkCount = 0;
  let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};

  for await (const event of adaptStream(result.stream)) {
    switch (event.type) {
      case "token":
        assistantText += event.text;
        yield { event: "token", data: { text: event.text } };
        break;
      case "sources":
        toolCallCount += 1;
        retrievedChunkCount += event.documents.length;
        yield { event: "sources", data: { documents: event.documents } };
        break;
      case "tool_call":
        toolCallCount += 1;
        yield {
          event: "tool_call",
          data: { toolName: event.toolName, arguments: event.arguments, result: event.result },
        };
        break;
      case "finish":
        usage = event.usage;
        break;
      case "error":
        // Exactly one assistant message per turn, written only on a clean
        // finish (see the design spec) — an errored turn persists the user's
        // message (already appended above, so a retry has something to
        // continue from) but never a partial assistant reply.
        yield {
          event: "error",
          data: {
            conversationId: conversation.id,
            error: { code: event.code, message: event.message },
          },
        };
        return;
    }
  }

  const assistantMessage = await appendMessage(conversation.id, input.tenantId, "assistant", assistantText);

  maybeRefreshIntentSummary(conversation.id, userTurnCount);

  void recordMetricsInBackground({
    conversationId: conversation.id,
    messageId: assistantMessage.id,
    tenantId: input.tenantId,
    latencyMs: Date.now() - startedAt,
    usage,
    toolCallCount,
    retrievedChunkCount,
    finalStep: result.finalStep,
  });

  yield { event: "done", data: { conversationId: conversation.id, messageId: assistantMessage.id } };
}

async function requireOwnedConversation(tenantId: string, externalUserId: string, conversationId: string) {
  const conversation = await getConversation(tenantId, externalUserId, conversationId);
  if (!conversation) throw new ConversationNotFoundError();
  return conversation;
}

/**
 * Cost is OpenRouter-specific and lives at
 * finalStep.providerMetadata.openrouter.usage.cost — confirmed against the
 * installed @openrouter/ai-sdk-provider's real OpenRouterUsageAccounting
 * type. Absent entirely on the anthropic path, so this defaults to null
 * rather than assuming the shape exists. Fire-and-forget: metrics must never
 * fail or delay the chat response, which has already been yielded by the
 * time this runs.
 */
async function recordMetricsInBackground(args: {
  conversationId: string;
  messageId: string;
  tenantId: string;
  latencyMs: number;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  toolCallCount: number;
  retrievedChunkCount: number;
  finalStep: Awaited<ReturnType<typeof streamText>>["finalStep"];
}): Promise<void> {
  try {
    const finalStep = await args.finalStep;
    const openrouterUsage = (
      finalStep.providerMetadata as { openrouter?: { usage?: { cost?: number } } } | undefined
    )?.openrouter?.usage;

    await recordChatMetrics({
      conversationId: args.conversationId,
      messageId: args.messageId,
      tenantId: args.tenantId,
      modelId: config.CHAT_MODEL_ID,
      latencyMs: args.latencyMs,
      promptTokens: args.usage.inputTokens ?? null,
      completionTokens: args.usage.outputTokens ?? null,
      totalTokens: args.usage.totalTokens ?? null,
      costCredits: openrouterUsage?.cost ?? null,
      toolCallCount: args.toolCallCount,
      retrievedChunkCount: args.retrievedChunkCount,
    });
  } catch {
    // never let metrics recording surface as a chat-facing failure
  }
}
