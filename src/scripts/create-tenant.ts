import { config } from "../config";
import { client } from "../db";
import { createTenant, issueApiKey } from "../tenants/tenants.service";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Names the database being written to, before writing to it.
 *
 * This command is the one place a developer deliberately points at production,
 * and `.env` gives no feedback about which database is live — dotenv silently
 * takes the LAST definition of a duplicated key, so an appended production URL
 * wins over the local one that appears to still be there. Printing the host
 * turns "which database am I about to touch?" into something you can see rather
 * than something you have to reconstruct.
 */
function describeTarget(): string {
  const host = new URL(config.DATABASE_URL).hostname;
  return LOCAL_HOSTS.has(host) ? `${host} (local)` : `${host}  ***NOT LOCAL***`;
}

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

  console.log(`\nTarget database: ${describeTarget()}`);

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
