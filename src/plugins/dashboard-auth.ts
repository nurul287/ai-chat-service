import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { verifySupabaseToken } from "../lib/supabase";
import { getTenantByOwnerUserId } from "../tenants/tenants.service";

declare module "fastify" {
  interface FastifyRequest {
    dashboardUserId: string | null;
  }
}

/**
 * Verifies a Supabase session token and pins the caller's Supabase user id
 * on the request. Deliberately does NOT resolve a tenant here — GET
 * /dashboard/tenant and POST /dashboard/signup are the only two routes
 * that must run before a tenant necessarily exists, so tenant resolution
 * is a separate, per-route preHandler (requireDashboardTenant, below)
 * rather than part of this scope-wide hook.
 *
 * Also decorates `tenant` (defaulting to null) even though this plugin's
 * own preHandler never sets it — decoration and assignment are separate
 * concerns in Fastify, and `requireDashboardTenant` (a plain function,
 * not its own `fp`-wrapped plugin) has nowhere else to declare it. `tenant`
 * is also decorated by authPlugin (/v1) and publishableAuthPlugin
 * (/widget) on their own sibling scopes — safe by the same mechanism
 * documented on those two decorateRequest calls.
 */
const dashboardAuthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("dashboardUserId", null);
  fastify.decorateRequest("tenant", null);

  fastify.addHook("preHandler", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Missing Bearer session token" } });
    }

    const user = await verifySupabaseToken(header.slice("Bearer ".length).trim());
    if (!user) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Invalid or expired session" } });
    }

    request.dashboardUserId = user.id;
  });
};

export default fp(dashboardAuthPlugin, { name: "dashboard-auth" });

/**
 * A per-route preHandler (passed via route options, not scope-wide) for
 * every /dashboard route except GET /tenant and POST /signup. Resolves
 * request.tenant from the already-verified dashboardUserId, or ends the
 * request with 404 if this account has no tenant yet.
 */
export async function requireDashboardTenant(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const tenant = await getTenantByOwnerUserId(request.dashboardUserId!);
  if (!tenant) {
    await reply
      .code(404)
      .send({ error: { code: "not_found", message: "No tenant found for this account" } });
    return;
  }
  request.tenant = tenant;
}
