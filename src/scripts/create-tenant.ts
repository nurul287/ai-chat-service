import { client } from "../db";
import { createTenant, issueApiKey } from "../tenants/tenants.service";

/**
 * Uses `console` rather than the app logger on purpose: this output is a
 * human-readable receipt, not a log stream, and the API key must be legible in
 * a terminal.
 */
async function main(): Promise<void> {
  const [name, slug] = process.argv.slice(2);
  if (!name || !slug) {
    console.error('Usage: pnpm create-tenant "<name>" <slug>');
    process.exit(1);
  }

  const tenant = await createTenant({ name, slug });
  const { plaintext } = await issueApiKey(tenant.id, "default");

  console.log(`\nTenant created: ${tenant.name} (${tenant.slug})`);
  console.log(`Tenant ID:      ${tenant.id}`);
  console.log(`API key:        ${plaintext}`);
  console.log("\nStore this key now — it is hashed in the database and cannot be shown again.\n");

  await client.end();
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
