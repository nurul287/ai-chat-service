import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { tenants } from "../db/schema";
import { upsertDocument } from "../documents/documents.service";
import { retrieve } from "../retrieval/retrieve";
import { hitRate, reciprocalRank } from "../eval/scoring";
import { createTenant } from "../tenants/tenants.service";

type GoldenDomain = {
  documents: { externalId: string; title: string; content: string }[];
  queries: { query: string; expectedExternalId: string }[];
};

type Golden = { domains: Record<string, GoldenDomain> };

const EVAL_TENANT_SLUG = "eval-harness";

async function ensureEvalTenant() {
  const existing = await db.select().from(tenants).where(eq(tenants.slug, EVAL_TENANT_SLUG));
  if (existing[0]) return existing[0];
  return createTenant({ name: "Eval Harness", slug: EVAL_TENANT_SLUG });
}

async function main(): Promise<void> {
  const golden = JSON.parse(
    readFileSync(join(__dirname, "../../content/eval/retrieval-golden.json"), "utf8"),
  ) as Golden;

  const tenant = await ensureEvalTenant();

  console.log("Ingesting golden content (real Voyage embedding calls)...\n");
  for (const domain of Object.values(golden.domains)) {
    for (const doc of domain.documents) {
      await upsertDocument(tenant.id, doc);
    }
  }

  const modes = ["hybrid", "hybrid+rerank"] as const;
  const summary: Record<string, Record<(typeof modes)[number], { hitRate: number; mrr: number }>> = {};

  for (const [domainName, domain] of Object.entries(golden.domains)) {
    summary[domainName] = {} as Record<
      (typeof modes)[number],
      { hitRate: number; mrr: number }
    >;

    for (const mode of modes) {
      let hits = 0;
      let mrrSum = 0;

      for (const { query, expectedExternalId } of domain.queries) {
        const results = await retrieve(tenant.id, query, 5, { mode });
        if (hitRate(results, expectedExternalId)) hits += 1;
        mrrSum += reciprocalRank(results, expectedExternalId);
      }

      summary[domainName][mode] = {
        hitRate: hits / domain.queries.length,
        mrr: mrrSum / domain.queries.length,
      };
    }
  }

  console.log("Domain      Mode            Hit-rate   MRR");
  console.log("----------  --------------  ---------  -----");
  let allDomainsImproveOrHold = true;
  for (const [domainName, modeScores] of Object.entries(summary)) {
    for (const mode of modes) {
      const { hitRate: hr, mrr } = modeScores[mode];
      console.log(
        `${domainName.padEnd(12)}${mode.padEnd(16)}${hr.toFixed(2).padEnd(11)}${mrr.toFixed(3)}`,
      );
    }
    if (modeScores["hybrid+rerank"].mrr < modeScores.hybrid.mrr) allDomainsImproveOrHold = false;
  }

  console.log();
  console.log(
    allDomainsImproveOrHold
      ? "PASS — hybrid+rerank scores >= plain hybrid on every domain."
      : "FAIL — hybrid+rerank scored WORSE than plain hybrid on at least one domain. Do not ship reranking as the default until this is investigated.",
  );

  await db.$client.end();
}

void main();
