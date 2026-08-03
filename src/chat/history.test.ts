import { describe, expect, it, vi } from "vitest";

vi.mock("./conversations.service", () => ({
  getRecentMessages: vi.fn(),
  getIntentSummary: vi.fn(),
}));

describe("buildContext", () => {
  it("returns just the recent messages when there is no summary yet", async () => {
    const { getRecentMessages, getIntentSummary } = await import("./conversations.service");
    vi.mocked(getRecentMessages).mockResolvedValue([
      { role: "user", content: "hi" } as never,
    ]);
    vi.mocked(getIntentSummary).mockResolvedValue(null);

    const { buildContext } = await import("./history");
    const context = await buildContext("conv-1");

    expect(context).toEqual([{ role: "user", content: "hi" }]);
  });

  it("prepends a system message with the summary when one exists", async () => {
    const { getRecentMessages, getIntentSummary } = await import("./conversations.service");
    vi.mocked(getRecentMessages).mockResolvedValue([{ role: "user", content: "hi" } as never]);
    vi.mocked(getIntentSummary).mockResolvedValue("Customer previously asked about headaches.");

    const { buildContext } = await import("./history");
    const context = await buildContext("conv-1");

    expect(context[0]).toEqual({
      role: "system",
      content: "Earlier context: Customer previously asked about headaches.",
    });
    expect(context[1]).toEqual({ role: "user", content: "hi" });
  });

  it("fetches at most the last 6 messages", async () => {
    const { getRecentMessages, getIntentSummary } = await import("./conversations.service");
    vi.mocked(getRecentMessages).mockResolvedValue([]);
    vi.mocked(getIntentSummary).mockResolvedValue(null);

    const { buildContext } = await import("./history");
    await buildContext("conv-1");

    expect(getRecentMessages).toHaveBeenCalledWith("conv-1", 6);
  });
});
