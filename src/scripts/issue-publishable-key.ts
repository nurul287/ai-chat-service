import { client } from "../db";
import { getTenantBySlug, issueApiKey } from "../tenants/tenants.service";
import { describeTarget } from "./describe-target";

async function main(): Promise<void> {
  const [slug] = process.argv.slice(2);
  if (!slug) {
    console.error("Usage: pnpm issue-publishable-key <tenant-slug>");
    process.exit(1);
  }

  console.log(`\nTarget database: ${describeTarget()}`);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`No tenant with slug "${slug}"`);
    process.exit(1);
  }

  const { plaintext } = await issueApiKey(tenant.id, "widget", "publishable");

  console.log(`\nPublishable key issued for: ${tenant.name} (${tenant.slug})`);
  console.log(`Key: ${plaintext}`);
  console.log(
    "\nThis key is safe to embed in a browser — it only works from origins on this",
  );
  console.log("tenant's allowed_origins list. Set that list with:");
  console.log(`  pnpm set-allowed-origins ${tenant.slug} <origin1> [origin2 ...]\n`);

  await client.end();
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
