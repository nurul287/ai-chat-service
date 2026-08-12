import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { verifyPublishableApiKey } from "../tenants/tenants.service";

/**
 * Mirrors src/plugins/auth.ts's structure exactly, but resolves a
 * publishable key and additionally requires the request's Origin to be on
 * the resolved tenant's allowed_origins list. This is the actual security
 * boundary for the widget — CORS (src/widget/widget.routes.ts's
 * registration) only controls whether a browser is allowed to *read* the
 * response; a request from a disallowed origin still reaches this
 * preHandler and is rejected here regardless of what CORS headers get
 * sent (verified in widget.routes.test.ts).
 *
 * `request.tenant`'s type is already declared globally by auth.ts's
 * `declare module "fastify"` block — no need to redeclare it here.
 *
 * Wrapped in `fp` for the same reason as auth.ts: so the preHandler
 * attaches to the enclosing scope (the `/widget` prefix block in app.ts)
 * rather than this plugin's own empty child context. Verified empirically
 * that two independently `fp`-wrapped auth plugins — this one and
 * auth.ts's — can each decorate `request.tenant` on their own sibling
 * scope (`/widget` vs `/v1`) without colliding.
 */
const publishableAuthPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("tenant", null);

  fastify.addHook("preHandler", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Missing Bearer API key" } });
    }

    const tenant = await verifyPublishableApiKey(header.slice("Bearer ".length).trim());
    if (!tenant) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Invalid or revoked API key" } });
    }

    const origin = request.headers.origin;
    if (!origin || !tenant.allowedOrigins.includes(origin)) {
      return reply
        .code(401)
        .send({ error: { code: "unauthorized", message: "Origin not allowed for this tenant" } });
    }

    request.tenant = tenant;
  });
};

export default fp(publishableAuthPlugin, { name: "publishable-auth" });
