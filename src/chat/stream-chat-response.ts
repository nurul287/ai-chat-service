import type { FastifyReply } from "fastify";
import { ConversationNotFoundError, runChat, type ChatWireEvent, type RunChatInput } from "./chat.service";

function toSSEFrame(event: ChatWireEvent) {
  return { event: event.event, data: event.data };
}

/**
 * Shared by /v1/chat and /widget/chat — the SSE-streaming control flow is
 * identical for both: peek the first event so a pre-stream failure
 * (ConversationNotFoundError) can still become a plain 404 rather than an
 * SSE `error` event, then stream everything else. See docs/errors.md for
 * why this split matters — once SSE headers are sent, the HTTP status can
 * never change.
 */
export async function streamChatResponse(reply: FastifyReply, input: RunChatInput): Promise<void> {
  const generator = runChat(input);

  let first: IteratorResult<ChatWireEvent>;
  try {
    first = await generator.next();
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      await reply.code(404).send({ error: { code: "not_found", message: "Conversation not found" } });
      return;
    }
    throw err;
  }

  async function* toSSE() {
    if (!first.done) yield toSSEFrame(first.value);
    for await (const event of generator) yield toSSEFrame(event);
  }

  await reply.sse.send(toSSE());
}
