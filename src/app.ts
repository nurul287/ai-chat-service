import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
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
import documentsRoutes from "./documents/documents.routes";
import { defaultLogger } from "./lib/logger";
import authPlugin from "./plugins/auth";

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

  // CORS is registered but closed. Sprint 1 issues only SECRET keys, which must
  // never reach a browser — so granting cross-origin access would actively
  // encourage the one thing docs/authentication.md warns against. Sprint 4 adds
  // publishable keys with a per-tenant domain allowlist; this is the single
  // place that changes when it does.
  void app.register(fastifyCors, { origin: false });

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

  app.get("/health", async () => ({ status: "ok" }));

  // Hidden from the spec it serves — a self-referential entry is just noise.
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  // The /v1 wrapper is the encapsulation boundary. authPlugin is `fp`-wrapped,
  // so its preHandler attaches to THIS scope — covering every route registered
  // inside it, and nothing outside it.
  void app.register(
    async (v1) => {
      await v1.register(authPlugin);
      await v1.register(documentsRoutes);
    },
    { prefix: "/v1" },
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
