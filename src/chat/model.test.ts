import { describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    CHAT_MODEL_PROVIDER: "openrouter",
    CHAT_MODEL_ID: "deepseek/deepseek-r1:free",
    OPENROUTER_API_KEY: "or-test-key",
    ANTHROPIC_API_KEY: undefined,
  },
}));

describe("chat model selection", () => {
  it("builds an OpenRouter model when CHAT_MODEL_PROVIDER is openrouter", async () => {
    const { chatModel } = await import("./model");
    const model = chatModel as { modelId: string; provider: string };
    expect(model.modelId).toBe("deepseek/deepseek-r1:free");
    expect(model.provider).toContain("openrouter");
  });
});
