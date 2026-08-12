import { readFileSync } from "node:fs";
import { join } from "node:path";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifySSE from "@fastify/sse";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { config } from "./config";
import chatRoutes from "./chat/chat.routes";
import documentsRoutes from "./documents/documents.routes";
import { defaultLogger } from "./lib/logger";
import authPlugin from "./plugins/auth";
import publishableAuthPlugin from "./plugins/publishable-auth";
import { verifyPublishableApiKey } from "./tenants/tenants.service";
import toolsRoutes from "./tools/tools.routes";
import widgetRoutes from "./widget/widget.routes";

/**
 * A factory rather than a module-level singleton: it keeps `inject()` clean in
 * tests, lets each test build an isolated instance, and keeps `listen()`
 * entirely inside server.ts.
 */
export function buildApp(opts: { logger?: FastifyServerOptions["logger"] } = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    logger: opts.logger ?? defaultLogger,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  void app.register(fastifyHelmet);

  // CORS is registered exactly once, for the whole app, with a single
  // path-routing delegator: /widget/* gets the per-tenant publishable-key
  // check below, everything else (/v1, /health, /docs) stays closed. This
  // MUST be a single registration — @fastify/cors decorates a
  // `corsPreflightEnabled` property onto the request, and Fastify refuses to
  // add the same decorator twice anywhere in an ancestor chain
  // (FST_ERR_DEC_ALREADY_PRESENT). Since every route in this app (including
  // /widget) descends from this root instance, a second, separately-scoped
  // `register(fastifyCors, ...)` — e.g. nested inside the `/widget` prefix
  // block below — throws at boot. Verified empirically against the
  // installed @fastify/cors@11.3.0 + fastify@5.10.0 + fastify-plugin@6.0.0.
  //
  // Sprint 1 issued only SECRET keys, which must never reach a browser (see
  // docs/authentication.md) — hence the `origin: false` fallback below.
  // Sprint 4 adds publishable keys with a per-tenant domain allowlist; the
  // `/widget` branch of this delegator is the part that implements it.
  //
  // The delegator MUST be passed as `{ delegator: fn }`, not as a bare `fn`
  // — @fastify/cors@11.3.0 silently falls back to wildcard `*` CORS if a
  // bare function is passed as the options argument instead, with no error
  // (see widget.routes.test.ts's "must NOT be * or the disallowed origin"
  // assertion, which is the one that would catch this regressing).
  void app.register(fastifyCors, {
    delegator: async (request: FastifyRequest) => {
      // A plain `startsWith("/widget")` would also match a future sibling
      // route like `/widget-preview` or `/widgets` — anything merely
      // starting with the same characters, not just this prefix. Requiring
      // an exact match or a `/` segment boundary keeps this branch scoped
      // to `/widget` itself and paths actually nested under it.
      if (request.url !== "/widget" && !request.url.startsWith("/widget/")) {
        return { origin: false };
      }

      const origin = request.headers.origin;

      // Preflight never carries the real request's Authorization header, so
      // there's no key yet to resolve a tenant from. This branch is inert:
      // the actual authorization decision happens in
      // publishableAuthPlugin's preHandler on the real request, which runs
      // regardless of what CORS decided here.
      if (request.method === "OPTIONS") {
        return { origin: origin ?? false };
      }

      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer ") || !origin) {
        return { origin: false };
      }

      const tenant = await verifyPublishableApiKey(header.slice("Bearer ".length).trim());
      const allowed = tenant?.allowedOrigins.includes(origin) ?? false;
      return { origin: allowed ? origin : false };
    },
  });

  // Registered BEFORE the routes so the spec builder sees them.
  void app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "AI Chat Service API",
        version: "0.1.0",
        description:
          "Multi-tenant document ingestion and hybrid retrieval. Push documents with PUT /v1/documents, then search them with POST /v1/search. All /v1 routes require a secret API key.",
        license: { name: "UNLICENSED" },
      },
      // A `servers` entry is required by the OpenAPI spec, and without one a
      // generated client has no base URL and Swagger UI's "Try it out" has
      // nothing to call. PUBLIC_URL comes first when set, so a client generated
      // against the deployed spec targets the deployment, not a developer's
      // laptop.
      servers: [
        ...(config.PUBLIC_URL ? [{ url: config.PUBLIC_URL, description: "Production" }] : []),
        { url: `http://localhost:${String(config.PORT)}`, description: "Local development" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "Your secret API key, e.g. `sk_live_…`. Server-side only.",
          },
        },
      },
    },
    // Converts the Zod route schemas into JSON Schema for the spec. This is why
    // the published reference cannot drift from request validation: they are
    // the same object.
    transform: jsonSchemaTransform,
  });

  void app.register(fastifySwaggerUI, { routePrefix: "/docs" });

  void app.register(fastifySSE);

  app.get("/health", async () => ({ status: "ok" }));

  // Hidden from the spec it serves — a self-referential entry is just noise.
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  let widgetScriptCache: string | null = null;
  function getWidgetScript(): string {
    // Lazy, not module-load-time: this file only exists after `pnpm
    // build:widget` has run, and route tests that never touch this
    // endpoint shouldn't fail to import app.ts just because that build
    // step hasn't happened yet in their environment.
    widgetScriptCache ??= readFileSync(join(__dirname, "../widget-dist/widget.js"), "utf8");
    return widgetScriptCache;
  }

  app.get("/widget.js", { schema: { hide: true } }, async (_request, reply) => {
    return reply
      .type("application/javascript")
      .header("Cache-Control", "public, max-age=3600")
      // Overrides @fastify/helmet's global default of `same-origin` — this
      // script's entire purpose is to be loaded via a <script src> from a
      // DIFFERENT origin (the tenant's own site), which `same-origin` CORP
      // blocks outright in a real browser (verified manually: without this,
      // Chrome refuses the request with net::ERR_BLOCKED_BY_RESPONSE).
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .send(getWidgetScript());
  });

  // The /v1 wrapper is the encapsulation boundary. authPlugin is `fp`-wrapped,
  // so its preHandler attaches to THIS scope — covering every route registered
  // inside it, and nothing outside it.
  void app.register(
    async (v1) => {
      await v1.register(authPlugin);
      await v1.register(documentsRoutes);
      await v1.register(chatRoutes);
      await v1.register(toolsRoutes);
    },
    { prefix: "/v1" },
  );

  // A sibling of /v1, not nested inside it — see this plan's Global
  // Constraints for why nesting here would incorrectly inherit /v1's
  // closed CORS and secret-key auth. Per-tenant CORS for this prefix is
  // implemented in the single app-wide delegator registered above, not
  // here — see that registration's comment for why it can't also be
  // registered a second time, scoped to this block.
  void app.register(
    async (widget) => {
      await widget.register(publishableAuthPlugin);
      await widget.register(widgetRoutes);
    },
    { prefix: "/widget" },
  );

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "Route not found" } }),
  );

  // `err` is annotated explicitly: without it Fastify's overload resolution
  // infers the error as `unknown` here, and every property access fails to
  // typecheck even though the runtime behaviour is correct.
  app.setErrorHandler(async (err: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: err.validation
            .map((i) => `${i.instancePath} ${i.message}`)
            .join("; ")
            .trim(),
        },
      });
    }

    if (isResponseSerializationError(err)) {
      request.log.error({ err }, "response failed its schema");
      return reply
        .code(500)
        .send({ error: { code: "internal_error", message: "Response did not match its schema" } });
    }

    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    // `request.log` rather than `app.log`: Fastify's child logger carries
    // reqId automatically, so this line joins up with the request lines around
    // it. Only genuinely unexpected failures are logged at error level — a 4xx
    // is the caller's problem and would just be noise at volume.
    if (status >= 500) request.log.error({ err }, "unhandled error");

    return reply.code(status).send({ error: { code: "internal_error", message: err.message } });
  });

  return app;
}
