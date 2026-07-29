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
import authPlugin from "./plugins/auth";

/**
 * A factory rather than a module-level singleton: it keeps `inject()` clean in
 * tests, lets each test build an isolated instance, and keeps `listen()`
 * entirely inside server.ts.
 */
export function buildApp(opts: { logger?: FastifyServerOptions["logger"] } = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    logger: opts.logger ?? false,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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
  app.setErrorHandler(async (err: FastifyError, _request, reply) => {
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
      return reply
        .code(500)
        .send({ error: { code: "internal_error", message: "Response did not match its schema" } });
    }

    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send({ error: { code: "internal_error", message: err.message } });
  });

  return app;
}
