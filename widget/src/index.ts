import {
  clearPersistedConversationId,
  getOrCreateSession,
  getPersistedConversationId,
  persistConversationId,
} from "./session";
import { appendMessage, mountWidget } from "./ui";

type ChatSSEEvent = { event: string; data: unknown };

/**
 * Minimal SSE frame parser for a fetch ReadableStream — browsers have no
 * built-in way to POST with a body and custom headers while consuming an
 * SSE response (EventSource only supports GET, no custom headers), so this
 * parses the same "event: x\ndata: y\n\n" wire format server.ts/chat
 * already produces, by hand.
 */
async function* parseSSE(response: Response): AsyncGenerator<ChatSSEEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (data) yield { event, data: JSON.parse(data) as unknown };
    }
  }
}

async function init(): Promise<void> {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  const apiKey = script.dataset.key;
  if (!apiKey) {
    console.error("[ai-chat-widget] missing data-key attribute on the embed script tag");
    return;
  }

  const baseUrl = new URL(script.src).origin;
  const color = script.dataset.color ?? "#4f46e5";
  const position = script.dataset.position === "bottom-left" ? "bottom-left" : "bottom-right";

  const { messageList, input, form } = mountWidget({ color, position });

  let conversationId: string | null = null;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    void sendMessage(message);
  });

  const persistedConversationId = getPersistedConversationId(apiKey);
  if (persistedConversationId) {
    conversationId = persistedConversationId;
    void loadHistory();
  }

  /**
   * Restores the tail of the conversation, not its head. The history route
   * orders ascending (correct for a chat log), so page 1 is the OLDEST
   * messages — for any conversation past one page, a returning visitor
   * would otherwise see ancient history and none of the recent exchange.
   * Page 1 is fetched first only to learn `meta.total`; the last page is
   * what actually gets rendered.
   */
  async function loadHistory(): Promise<void> {
    try {
      const externalUserId = await getOrCreateSession(baseUrl, apiKey!);
      const limit = 50;
      const baseHistoryUrl = `${baseUrl}/widget/conversations/${persistedConversationId}/messages?externalUserId=${encodeURIComponent(externalUserId)}&limit=${limit}`;

      let res = await fetch(baseHistoryUrl, { headers: { Authorization: `Bearer ${apiKey}` } });

      if (res.status === 404) {
        // Stale conversation discovered at page load — clear it, or every
        // future reload retries the same dead id forever.
        conversationId = null;
        clearPersistedConversationId(apiKey!);
        return;
      }
      if (!res.ok) return; // any other failure — fine, the widget still works fresh

      type HistoryPage = {
        data: { role: "user" | "assistant"; content: string }[];
        meta: { page: number; limit: number; total: number };
      };
      let body = (await res.json()) as HistoryPage;

      const lastPage = Math.max(1, Math.ceil(body.meta.total / limit));
      if (lastPage > 1) {
        res = await fetch(`${baseHistoryUrl}&page=${lastPage}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) return;
        body = (await res.json()) as HistoryPage;
      }

      for (const msg of body.data) {
        appendMessage(messageList, msg.role, msg.content);
      }
    } catch {
      // history restoration failing is not fatal — a fresh conversation still works
    }
  }

  async function sendMessage(message: string): Promise<void> {
    appendMessage(messageList, "user", message);
    const assistantBubble = appendMessage(messageList, "assistant", "");
    await streamReply(message, assistantBubble, true);
  }

  /**
   * Split out of sendMessage so a retry can reuse the SAME assistant
   * bubble: a stale conversationId 404s, and the retry has to look like
   * the original turn finally answering, not like the visitor's message
   * being duplicated.
   */
  async function streamReply(
    message: string,
    assistantBubble: HTMLDivElement,
    allowRetryOnStaleConversation: boolean,
  ): Promise<void> {
    try {
      const externalUserId = await getOrCreateSession(baseUrl, apiKey!);

      const res = await fetch(`${baseUrl}/widget/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ externalUserId, conversationId, message }),
      });

      // A persisted conversation can go away underneath us (deleted, or
      // the tenant swapped their publishable key). Without this, every
      // future message 404s forever and a reload doesn't help, because
      // init() just re-reads the same dead id. Retried exactly once, as a
      // brand-new conversation — note the retry sends no conversationId,
      // since `conversationId` is nulled first.
      if (res.status === 404 && conversationId !== null && allowRetryOnStaleConversation) {
        conversationId = null;
        clearPersistedConversationId(apiKey!);
        await streamReply(message, assistantBubble, false);
        return;
      }

      if (!res.ok || !res.body) {
        assistantBubble.textContent = "Sorry, something went wrong.";
        return;
      }

      for await (const frame of parseSSE(res)) {
        if (frame.event === "token") {
          assistantBubble.textContent += (frame.data as { text: string }).text;
          messageList.scrollTop = messageList.scrollHeight;
        } else if (frame.event === "done") {
          conversationId = (frame.data as { conversationId: string }).conversationId;
          persistConversationId(apiKey!, conversationId);
        } else if (frame.event === "error") {
          assistantBubble.textContent = "Sorry, something went wrong.";
        }
      }
    } catch {
      assistantBubble.textContent = "Sorry, something went wrong.";
    }
  }
}

void init();
