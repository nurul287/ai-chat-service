import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
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

  app.get("/health", async () => ({ status: "ok" }));

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
