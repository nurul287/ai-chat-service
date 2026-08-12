import { config } from "../config";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Names the database being written to, before writing to it.
 *
 * This is the one place a developer deliberately points at production, and
 * `.env` gives no feedback about which database is live — dotenv silently
 * takes the LAST definition of a duplicated key, so an appended production
 * URL wins over the local one that appears to still be there. Printing the
 * host turns "which database am I about to touch?" into something you can
 * see rather than something you have to reconstruct.
 *
 * Shared by every CLI script in this directory that writes to the database
 * — consolidated here after the second copy so the safety check can't
 * silently drift between scripts.
 */
export function describeTarget(): string {
  const host = new URL(config.DATABASE_URL).hostname;
  return LOCAL_HOSTS.has(host) ? `${host} (local)` : `${host}  ***NOT LOCAL***`;
}
