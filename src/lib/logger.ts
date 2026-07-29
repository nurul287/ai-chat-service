import type { FastifyServerOptions } from "fastify";
import { config } from "../config";

/**
 * JSON in production (machine-parseable for Railway's log drain), pretty in
 * development (human-readable), and off entirely in tests — a test suite that
 * prints a log line per request buries the actual failure output.
 */
export const loggerOptions: Record<string, FastifyServerOptions["logger"]> = {
  production: { level: config.LOG_LEVEL },
  development: {
    level: config.LOG_LEVEL,
    transport: {
      target: "pino-pretty",
      options: { translateTime: "HH:MM:ss Z", ignore: "pid,hostname" },
    },
  },
  test: false,
};

export const defaultLogger = loggerOptions[config.NODE_ENV] ?? false;
