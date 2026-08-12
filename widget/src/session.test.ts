// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPersistedConversationId,
  getOrCreateSession,
  getPersistedConversationId,
  persistConversationId,
} from "./session";

const originalFetch = global.fetch;

const KEY = "pk_live_test";
// Every persisted slot is namespaced by the apiKey — asserted literally
// here rather than via storageKey(), so a change to the naming scheme has
// to be a deliberate edit to this file rather than a silently-passing one.
const SESSION_SLOT = `ai-chat-widget:${KEY}:externalUserId`;
const CONVERSATION_SLOT = `ai-chat-widget:${KEY}:conversationId`;

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

    const id = await getOrCreateSession("https://api.example.com", KEY);

    expect(id).toBe("session-abc");
    expect(localStorage.getItem(SESSION_SLOT)).toBe("session-abc");
  });

  it("returns the persisted id on a second call without calling fetch again", async () => {
    localStorage.setItem(SESSION_SLOT, "existing-session");
    global.fetch = vi.fn() as typeof fetch;

    const id = await getOrCreateSession("https://api.example.com", KEY);

    expect(id).toBe("existing-session");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws with a clear message when the session endpoint rejects the request", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;

    await expect(getOrCreateSession("https://api.example.com", KEY)).rejects.toThrow(/401/);
  });

  it("does not reuse another key's session — two widgets on one page get their own", async () => {
    localStorage.setItem(SESSION_SLOT, "first-widgets-session");
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ externalUserId: "second-widgets-session" }),
    })) as unknown as typeof fetch;

    const id = await getOrCreateSession("https://api.example.com", "pk_live_other");

    expect(id).toBe("second-widgets-session");
    // The first widget's session survived untouched.
    expect(localStorage.getItem(SESSION_SLOT)).toBe("first-widgets-session");
  });
});

describe("conversationId persistence", () => {
  it("returns null when nothing is persisted", () => {
    expect(getPersistedConversationId(KEY)).toBeNull();
  });

  it("round-trips a persisted conversationId", () => {
    persistConversationId(KEY, "conv-abc");
    expect(getPersistedConversationId(KEY)).toBe("conv-abc");
    expect(localStorage.getItem(CONVERSATION_SLOT)).toBe("conv-abc");
  });

  it("clears a stale conversationId so it stops being retried", () => {
    persistConversationId(KEY, "conv-stale");
    clearPersistedConversationId(KEY);

    expect(getPersistedConversationId(KEY)).toBeNull();
    expect(localStorage.getItem(CONVERSATION_SLOT)).toBeNull();
  });

  it("keeps each key's conversation separate", () => {
    persistConversationId(KEY, "conv-a");
    persistConversationId("pk_live_other", "conv-b");

    expect(getPersistedConversationId(KEY)).toBe("conv-a");
    expect(getPersistedConversationId("pk_live_other")).toBe("conv-b");

    // Clearing one leaves the other intact.
    clearPersistedConversationId(KEY);
    expect(getPersistedConversationId(KEY)).toBeNull();
    expect(getPersistedConversationId("pk_live_other")).toBe("conv-b");
  });
});
