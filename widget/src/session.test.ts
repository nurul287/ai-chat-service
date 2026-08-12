// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateSession, getPersistedConversationId, persistConversationId } from "./session";

const originalFetch = global.fetch;

afterEach(() => {
  localStorage.clear();
  global.fetch = originalFetch;
});

describe("getOrCreateSession", () => {
  it("calls /widget/session and persists the returned id", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ externalUserId: "session-abc" }),
    })) as unknown as typeof fetch;

    const id = await getOrCreateSession("https://api.example.com", "pk_live_test");

    expect(id).toBe("session-abc");
    expect(localStorage.getItem("ai-chat-widget:externalUserId")).toBe("session-abc");
  });

  it("returns the persisted id on a second call without calling fetch again", async () => {
    localStorage.setItem("ai-chat-widget:externalUserId", "existing-session");
    global.fetch = vi.fn() as typeof fetch;

    const id = await getOrCreateSession("https://api.example.com", "pk_live_test");

    expect(id).toBe("existing-session");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws with a clear message when the session endpoint rejects the request", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;

    await expect(getOrCreateSession("https://api.example.com", "pk_live_test")).rejects.toThrow(/401/);
  });
});

describe("conversationId persistence", () => {
  it("returns null when nothing is persisted", () => {
    expect(getPersistedConversationId()).toBeNull();
  });

  it("round-trips a persisted conversationId", () => {
    persistConversationId("conv-abc");
    expect(getPersistedConversationId()).toBe("conv-abc");
  });
});
