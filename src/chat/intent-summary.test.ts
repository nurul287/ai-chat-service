import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
vi.mock("./model", () => ({ chatModel: { modelId: "fake" } }));
vi.mock("./conversations.service", () => ({
  getRecentMessages: vi.fn(async () => [
    { role: "user", content: "Do you have anything for a headache?" },
    { role: "assistant", content: "Paracetamol should help." },
  ]),
  updateIntentSummary: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("maybeRefreshIntentSummary", () => {
  it("does nothing when the turn count is not a multiple of 3", async () => {
    const { generateText } = await import("ai");
    const { maybeRefreshIntentSummary } = await import("./intent-summary");

    maybeRefreshIntentSummary("conv-1", 2);
    await vi.waitFor(() => expect(generateText).not.toHaveBeenCalled());
  });

  it("fires a summarization call on every 3rd user turn", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValue({ text: "Customer asked about headache relief." } as never);
    const { updateIntentSummary } = await import("./conversations.service");
    const { maybeRefreshIntentSummary } = await import("./intent-summary");

    maybeRefreshIntentSummary("conv-1", 3);

    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(updateIntentSummary).toHaveBeenCalledWith("conv-1", "Customer asked about headache relief."),
    );
  });

  it("never throws even when the summarization call fails", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockRejectedValue(new Error("rate limited"));
    const { maybeRefreshIntentSummary } = await import("./intent-summary");

    expect(() => maybeRefreshIntentSummary("conv-1", 6)).not.toThrow();
  });
});
