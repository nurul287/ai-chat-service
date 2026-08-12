const STORAGE_KEY = "ai-chat-widget:externalUserId";

/**
 * Mints a session once (server-side, via POST /widget/session) and
 * persists it in localStorage so a returning visitor keeps their
 * conversation history — the same continuity a client-generated UUID
 * would give, just server-minted per the Sprint 4 design.
 */
export async function getOrCreateSession(baseUrl: string, apiKey: string): Promise<string> {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const res = await fetch(`${baseUrl}/widget/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to start a chat session (HTTP ${res.status})`);
  }

  const body = (await res.json()) as { externalUserId: string };
  localStorage.setItem(STORAGE_KEY, body.externalUserId);
  return body.externalUserId;
}
