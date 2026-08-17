import { createClient } from "@supabase/supabase-js";
import { config } from "../config";

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);

/**
 * Verifies a client-issued Supabase session token by asking Supabase's own
 * auth server, rather than validating a JWT signature locally — this is
 * the officially recommended pattern for a backend verifying a token it
 * did not issue, and it works identically for password and magic-link
 * sessions with no JWT-secret/JWKS management on our side.
 *
 * Never throws: any failure (invalid token, expired session, network
 * error) is treated as "not authenticated" rather than propagating an
 * exception into the caller's preHandler.
 */
export async function verifySupabaseToken(
  token: string,
): Promise<{ id: string; email: string | null } | null> {
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
  }
}
