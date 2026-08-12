import { existsSync } from "node:fs";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

/** Captures raw pino output so we can assert on what actually gets logged. */
function captureLogs() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      level: "info",
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    },
  };
}

describe("request logging", () => {
  it("logs every request with a request id", async () => {
    const { lines, logger } = captureLogs();
    const app = buildApp({ logger });

    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.some((e) => typeof e.reqId === "string")).toBe(true);
  });

  it("logs an unhandled error with a request id, and does not swallow it", async () => {
    const { lines, logger } = captureLogs();
    const app = buildApp({ logger });
    app.get("/boom", async () => {
      throw new Error("kaboom");
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    await app.close();

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal_error");

    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const errorLine = entries.find((e) => e.level === 50);
    expect(errorLine).toBeDefined();
    expect(typeof errorLine!.reqId).toBe("string");
  });

  it("does not log a client validation error at error level", async () => {
    const { lines, logger } = captureLogs();
    const app = buildApp({ logger });

    const res = await app.inject({ method: "GET", url: "/nope-not-a-route" });
    await app.close();

    expect(res.statusCode).toBe(404);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.some((e) => e.level === 50)).toBe(false);
  });
});

describe("security headers", () => {
  it("sets helmet's headers", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does not grant cross-origin access to browsers", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example" },
    });
    await app.close();

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("overrides helmet's default same-origin CORP so GET /widget.js can be loaded cross-origin", async () => {
    // Not asserted by CI having previously run `pnpm build:widget` — this
    // route reads widget-dist/widget.js lazily (see getWidgetScript's
    // comment in app.ts), and CI's `pnpm test` step never builds it. Built
    // here so this test is self-contained regardless of what ran before it.
    if (!existsSync("widget-dist/widget.js")) {
      await build({
        entryPoints: ["widget/src/index.ts"],
        bundle: true,
        format: "iife",
        target: "es2020",
        outfile: "widget-dist/widget.js",
      });
    }

    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/widget.js" });
    await app.close();

    // helmet's global default is "same-origin", which a real browser
    // enforces even for a <script src> load — exactly the case this route
    // exists for (a tenant embeds this script from THEIR origin, never
    // this service's own). Without the per-route override this asserts,
    // the widget could never actually be embedded anywhere.
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});
