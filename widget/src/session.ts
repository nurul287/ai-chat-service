/**
 * Every persisted key is namespaced by the widget's own publishable key,
 * so two widgets on one page — or a tenant rotating their key — don't
 * silently collide on a shared `ai-chat-widget:*` slot. Truncated to 24
 * chars: enough to distinguish keys in practice, and a publishable key is
 * public anyway (it sits in the page source), so this leaks nothing that
 * wasn't already visible.
 */
function storageKey(apiKey: string, suffix: string): string {
  return `ai-chat-widget:${apiKey.slice(0, 24)}:${suffix}`;
}

/**
 * Mints a session once (server-side, via POST /widget/session) and
 * persists it in localStorage so a returning visitor keeps their
 * conversation history — the same continuity a client-generated UUID
 * would give, just server-minted per the Sprint 4 design. Namespaced by
 * apiKey so two widgets on one page, or a tenant rotating their key,
 * don't collide.
 */
export async function getOrCreateSession(baseUrl: string, apiKey: string): Promise<string> {
  const key = storageKey(apiKey, "externalUserId");
  const existing = localStorage.getItem(key);
  if (existing) return existing;

  const res = await fetch(`${baseUrl}/widget/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to start a chat session (HTTP ${res.status})`);
  }

  const body = (await res.json()) as { externalUserId: string };
  localStorage.setItem(key, body.externalUserId);
  return body.externalUserId;
}

export function getPersistedConversationId(apiKey: string): string | null {
  return localStorage.getItem(storageKey(apiKey, "conversationId"));
}

export function persistConversationId(apiKey: string, conversationId: string): void {
  localStorage.setItem(storageKey(apiKey, "conversationId"), conversationId);
}

/**
 * Called when the server tells us a persisted id is no longer usable (a
 * 404 from /widget/chat or the history route). Without this, a stale id
 * is retried on every message and every page load, forever.
 */
export function clearPersistedConversationId(apiKey: string): void {
  localStorage.removeItem(storageKey(apiKey, "conversationId"));
}
