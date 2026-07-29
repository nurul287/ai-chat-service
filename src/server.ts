import { sql } from "drizzle-orm";
import { buildApp } from "./app";
import { config } from "./config";
import { client, db } from "./db";
import { defaultLogger } from "./lib/logger";

async function main(): Promise<void> {
  const app = buildApp({ logger: defaultLogger });

  // Fail fast: a service that cannot reach its database should never report
  // itself healthy, and finding out at boot beats finding out on first request.
  try {
    await db.execute(sql`select 1`);
    app.log.info("database connection ok");
  } catch (err) {
    app.log.error({ err }, "database unreachable at boot");
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      await app.close(); // drains in-flight requests
      await client.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    // host 0.0.0.0, not the default 127.0.0.1 — a container-bound service that
    // only listens on loopback is unreachable from Railway's proxy.
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}

void main();
