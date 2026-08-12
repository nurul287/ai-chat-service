import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Tenant } from "../db/schema";
import { errorResponse } from "../documents/documents.schema";
import { createTenant, getTenantByOwnerUserId, issueApiKey } from "../tenants/tenants.service";
import { signupBody, signupResponse, tenantResponse } from "./dashboard.schema";

function toPublicTenant(tenant: Tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    createdAt: new Date(tenant.createdAt).toISOString(),
  };
}

const tenantRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/tenant",
    {
      schema: {
        operationId: "getDashboardTenant",
        tags: ["Dashboard"],
        summary: "The tenant owned by the authenticated dashboard user",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: tenantResponse }), 401: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const tenant = await getTenantByOwnerUserId(request.dashboardUserId!);
      if (!tenant) {
        return reply
          .code(404)
          .send({ error: { code: "not_found", message: "No tenant found for this account" } });
      }
      return reply.code(200).send({ data: toPublicTenant(tenant) });
    },
  );

  app.post(
    "/signup",
    {
      schema: {
        operationId: "dashboardSignup",
        tags: ["Dashboard"],
        summary: "Create a tenant for the authenticated dashboard user and mint its first secret key",
        description:
          "Called once, right after a Supabase Auth signup/login, for a user who has no tenant " +
          "yet. Mints a secret key named \"default\" — the same one-time-plaintext contract as " +
          "the create-tenant CLI script.",
        security: [{ bearerAuth: [] }],
        body: signupBody,
        response: { 200: z.object({ data: signupResponse }), 401: errorResponse, 409: errorResponse },
      },
    },
    async (request, reply) => {
      const existing = await getTenantByOwnerUserId(request.dashboardUserId!);
      if (existing) {
        return reply
          .code(409)
          .send({ error: { code: "conflict", message: "This account already has a tenant" } });
      }

      let tenant: Tenant;
      try {
        tenant = await createTenant({
          name: request.body.tenantName,
          slug: request.body.tenantSlug,
          ownerUserId: request.dashboardUserId!,
        });
      } catch {
        // Either the slug is already taken, or a concurrent signup for this
        // same user won the owner_user_id unique constraint — both surface
        // here as an insert failure, and 409 is the right status for
        // either root cause without needing to parse the DB error.
        return reply.code(409).send({
          error: {
            code: "conflict",
            message: "Could not create this tenant — the slug may be taken, or this account may already have one",
          },
        });
      }

      const { plaintext, prefix } = await issueApiKey(tenant.id, "default");
      return reply.code(200).send({
        data: { tenant: toPublicTenant(tenant), apiKey: { plaintext, prefix } },
      });
    },
  );
};

export default tenantRoutes;
