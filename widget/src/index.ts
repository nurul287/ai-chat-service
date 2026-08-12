import {
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

  const persistedConversationId = getPersistedConversationId();
  if (persistedConversationId) {
    conversationId = persistedConversationId;
    void loadHistory();
  }

  async function loadHistory(): Promise<void> {
    try {
      const externalUserId = await getOrCreateSession(baseUrl, apiKey!);
      const url = `${baseUrl}/widget/conversations/${persistedConversationId}/messages?externalUserId=${encodeURIComponent(externalUserId)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return; // conversation gone or not found — fine, the widget still works fresh

      const body = (await res.json()) as { data: { role: "user" | "assistant"; content: string }[] };
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

    try {
      const externalUserId = await getOrCreateSession(baseUrl, apiKey!);

      const res = await fetch(`${baseUrl}/widget/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ externalUserId, conversationId, message }),
      });

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
          persistConversationId(conversationId);
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
