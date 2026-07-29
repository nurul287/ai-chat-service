import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import type { Tenant } from "../db/schema";
import { verifyApiKey } from "../tenants/tenants.service";

declare module "fastify" {
  interface FastifyRequest {
    tenant: Tenant | null;
  }
}

/**
 * Resolves a Bearer API key to its tenant and pins it on the request. Every
 * downstream handler reads `request.tenant.id` for its tenant scope — no
 * handler may ever take a tenant id from a request body, query param, or path
 * segment, which would let one tenant address another's data.
 *
 * Wrapped in `fp` so the hook attaches to the ENCLOSING scope rather than to
 * this plugin's own (empty) child context. Without `fp` the preHandler would
 * apply only to routes registered inside this plugin — of which there are
 * none — so it would silently never run and every /v1 route would be wide
 * open. `app.ts` registers it inside the `/v1` wrapper, and that wrapper is
 * what keeps `/health` and `/docs` public.
 */
const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("tenant", null);

  fastify.addHook("preHandler", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Missing Bearer API key" } });
    }

    const tenant = await verifyApiKey(header.slice("Bearer ".length).trim());
    if (!tenant) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Invalid or revoked API key" } });
    }

    request.tenant = tenant;
  });
};

export default fp(authPlugin, { name: "auth" });
