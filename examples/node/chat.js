/**
 * Consumes POST /v1/chat's Server-Sent Events stream with plain fetch — no
 * dependencies, matching index.js's own "no client SDK yet" stance (see
 * docs/superpowers/specs/2026-07-30-chat-engine-design.md).
 *
 *   API_KEY=sk_live_... node examples/node/chat.js
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4000";
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("API_KEY is not set. Create a tenant first:");
  console.error('  pnpm create-tenant "Acme Pharmacy" acme-pharmacy');
  process.exit(1);
}

/** Parses one SSE frame ("event: x\ndata: {...}\n\n") into {event, data}. */
function parseFrame(frame) {
  const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
  const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
  return {
    event: eventLine?.slice("event: ".length),
    data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : undefined,
  };
}

async function chat(externalUserId, conversationId, message) {
  const res = await fetch(`${BASE_URL}/v1/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ externalUserId, conversationId, message }),
  });

  if (!res.ok) {
    const body = await res.json();
    throw new Error(`chat failed [${body.error.code}]: ${body.error.message}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let newConversationId = conversationId;

  process.stdout.write("Assistant: ");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const { event, data } = parseFrame(frame);

      if (event === "token") process.stdout.write(data.text);
      if (event === "sources") {
        console.log(`\n  (cited: ${data.documents.map((d) => d.externalId).join(", ")})`);
      }
      if (event === "done") newConversationId = data.conversationId;
      if (event === "error") throw new Error(`stream error [${data.error.code}]: ${data.error.message}`);
    }
  }
  console.log();

  return newConversationId;
}

async function main() {
  const conversationId = await chat("example-user", null, "Do you have anything for a headache?");
  await chat("example-user", conversationId, "How many should I take?");
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
