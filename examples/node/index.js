/**
 * A complete integration in one file: ingest a few documents, search them,
 * print the results.
 *
 *   API_KEY=sk_live_... node examples/node/index.js
 *
 * No dependencies and no build step on purpose — the whole integration should
 * be readable at a glance, and an example that needs `pnpm install` is one more
 * thing that can break for reasons unrelated to the service.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4000";
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("API_KEY is not set. Create a tenant first:");
  console.error('  pnpm create-tenant "Acme Pharmacy" acme-pharmacy');
  process.exit(1);
}

/** Every call goes through here so error handling is written exactly once. */
async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await res.json();

  if (!res.ok) {
    // The error contract: branch on payload.error.code, never on the message.
    // See docs/errors.md.
    throw new Error(`${method} ${path} failed [${payload.error.code}]: ${payload.error.message}`);
  }
  return payload;
}

const CATALOG = [
  {
    externalId: "sku-1",
    title: "Paracetamol",
    content: "Paracetamol 500mg tablets. Relieves fever, headache and mild pain.",
    metadata: { category: "analgesics", price: 4.5 },
  },
  {
    externalId: "sku-2",
    title: "Loratadine",
    content: "Loratadine 10mg antihistamine tablets for hay fever and allergic rhinitis.",
    metadata: { category: "antihistamines", price: 6.0 },
  },
  {
    externalId: "sku-3",
    title: "Sterile bandage",
    content: "Sterile adhesive bandages for dressing minor cuts and grazes.",
    metadata: { category: "first-aid", price: 2.25 },
  },
];

async function main() {
  console.log(`→ ${BASE_URL}\n`);

  console.log("Ingesting…");
  for (const doc of CATALOG) {
    const { data } = await call("PUT", "/v1/documents", doc);
    console.log(`  ${data.externalId}  ${data.title}`);
  }

  const { meta } = await call("GET", "/v1/documents?page=1&limit=20");
  console.log(`\n${meta.total} document(s) in this tenant.\n`);

  // None of these queries share a word with the document they should match —
  // that is the whole point of the vector leg.
  const queries = ["reduce a high temperature", "my nose runs in spring", "I cut my finger"];

  for (const query of queries) {
    const { data } = await call("POST", "/v1/search", { query, topK: 2 });
    console.log(`"${query}"`);
    if (data.length === 0) {
      console.log("  (no results)");
    }
    for (const [i, hit] of data.entries()) {
      console.log(`  ${i + 1}. ${hit.title ?? "(untitled)"}  [${hit.externalId}]`);
    }
    console.log();
  }

  console.log("Cleaning up…");
  for (const doc of CATALOG) {
    await call("DELETE", `/v1/documents/${doc.externalId}`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
