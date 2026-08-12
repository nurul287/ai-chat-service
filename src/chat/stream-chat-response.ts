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
 *
 * The two routes differ in exactly one respect: who the caller is.
 * /v1/chat's caller is the tenant's own trusted backend, so it gets the
 * full event set (no `allowedEvents` = no filtering at all). /widget/chat's
 * caller is any anonymous browser holding a publishable key, so it passes
 * an explicit allowlist — `sources` carries verbatim document content and
 * arbitrary tenant-supplied metadata, and `tool_call` carries a custom
 * tool's RAW response body; neither is meant for public display.
 */
export async function streamChatResponse(
  reply: FastifyReply,
  input: RunChatInput,
  options: { allowedEvents?: ReadonlySet<ChatWireEvent["event"]> } = {},
): Promise<void> {
  const generator = runChat(input);
  const { allowedEvents } = options;

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

  function isAllowed(event: ChatWireEvent): boolean {
    return !allowedEvents || allowedEvents.has(event.event);
  }

  async function* toSSE() {
    if (!first.done && isAllowed(first.value)) yield toSSEFrame(first.value);
    for await (const event of generator) {
      if (isAllowed(event)) yield toSSEFrame(event);
    }
  }

  await reply.sse.send(toSSE());
}
