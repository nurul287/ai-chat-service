import { client } from "../db";
import { getTenantBySlug, setAllowedOrigins } from "../tenants/tenants.service";
import { describeTarget } from "./describe-target";

async function main(): Promise<void> {
  const [slug, ...origins] = process.argv.slice(2);
  if (!slug || origins.length === 0) {
    console.error("Usage: pnpm set-allowed-origins <tenant-slug> <origin1> [origin2 ...]");
    console.error("Example: pnpm set-allowed-origins acme-pharmacy https://acme.com https://www.acme.com");
    process.exit(1);
  }

  console.log(`\nTarget database: ${describeTarget()}`);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    console.error(`No tenant with slug "${slug}"`);
    process.exit(1);
  }

  await setAllowedOrigins(tenant.id, origins);

  console.log(`\nAllowed origins for ${tenant.name} (${tenant.slug}):`);
  for (const origin of origins) console.log(`  ${origin}`);
  console.log();

  await client.end();
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
