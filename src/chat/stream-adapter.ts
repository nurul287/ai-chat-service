import type { TextStreamPart, ToolSet } from "ai";
import type { RetrievedChunk } from "../retrieval/retrieve";

export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "sources"; documents: RetrievedChunk[] }
  | {
      type: "finish";
      usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    }
  | { type: "error"; code: "internal_error"; message: string };

/**
 * Translates the AI SDK's rich TextStreamPart union into the small set of
 * events this service actually surfaces. Deliberately pure — no Fastify, no
 * database, no network — so it is testable with a fake source stream alone.
 *
 * Only `search_knowledge`'s tool-result becomes a `sources` event: this is
 * the ONLY tool this loop has in Sprint 2 (Sprint 3 adds tenant-registered
 * custom tools), and a result from any other tool name is silently ignored
 * rather than surfaced, since there is nothing else registered to produce one
 * yet.
 */
export async function* adaptStream(
  source: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncGenerator<ChatStreamEvent> {
  for await (const part of source) {
    switch (part.type) {
      case "text-delta":
        yield { type: "token", text: part.text };
        break;
      case "tool-result":
        if (part.toolName === "search_knowledge") {
          yield { type: "sources", documents: part.output as RetrievedChunk[] };
        }
        break;
      case "finish":
        yield {
          type: "finish",
          usage: {
            inputTokens: part.totalUsage.inputTokens ?? undefined,
            outputTokens: part.totalUsage.outputTokens ?? undefined,
            totalTokens: part.totalUsage.totalTokens ?? undefined,
          },
        };
        break;
      case "error":
        yield {
          type: "error",
          code: "internal_error",
          message: part.error instanceof Error ? part.error.message : String(part.error),
        };
        break;
      default:
        // start, start-step, finish-step, tool-call, reasoning-*, source,
        // file, tool-input-*, tool-error, raw, abort — none are surfaced to
        // the client in Sprint 2. tool-error specifically: search_knowledge's
        // execute() never throws (retrieve() already degrades internally on
        // its own failures), so a tool-error here would indicate a genuine
        // bug, not a normal degrade path — worth revisiting if Sprint 3's
        // tenant-registered tools can fail in ways that should reach the client.
        break;
    }
  }
}
