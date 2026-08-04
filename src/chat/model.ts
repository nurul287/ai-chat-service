import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { config } from "../config";

/**
 * Selected once at import time from config, not per-request — matching how
 * src/db/index.ts builds its client once. CHAT_MODEL_ID stays a plain string
 * rather than a constant specifically because OpenRouter's free-tier models
 * are known to rotate and get delisted without warning; swapping it is meant
 * to be a one-line config change, never a code change. See
 * docs/self-hosting.md for the swap runbook.
 */
function buildChatModel(): LanguageModel {
  if (config.CHAT_MODEL_PROVIDER === "anthropic") {
    const anthropic = createAnthropic({ apiKey: config.ANTHROPIC_API_KEY });
    return anthropic(config.CHAT_MODEL_ID);
  }

  const openrouter = createOpenRouter({ apiKey: config.OPENROUTER_API_KEY });
  return openrouter(config.CHAT_MODEL_ID);
}

export const chatModel = buildChatModel();
