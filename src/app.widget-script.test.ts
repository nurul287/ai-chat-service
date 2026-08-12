/**
 * Isolated into its own file because it mocks `node:fs`, which must not
 * leak into app.observability.test.ts — that file deliberately runs a real
 * esbuild build against the real filesystem.
 *
 * Mocking is what makes this test independent of whether
 * `widget-dist/widget.js` happens to exist in whatever environment the
 * suite runs in. Renaming the real file instead would make the test order-
 * dependent and would race the sibling test file that builds it.
 */
// vi.mock is hoisted above the imports below by vitest's transform — the
// same ordering src/widget/widget.routes.test.ts uses. A `await
// import("./app")` after the mock would read more obviously, but this
// project compiles as commonjs, where top-level await is a type error.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      // Only the widget bundle read is faked — everything else in the
      // import graph (config, dotenv, …) still hits the real filesystem.
      if (typeof path === "string" && path.includes("widget-dist")) {
        const err = new Error(
          `ENOENT: no such file or directory, open '/srv/app/widget-dist/widget.js'`,
        ) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        err.path = "/srv/app/widget-dist/widget.js";
        throw err;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }),
  };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /widget.js when the bundle was never built", () => {
  it("returns a generic 503 instead of leaking the absolute filesystem path", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/widget.js" });
    await app.close();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: "internal_error", message: "Widget script unavailable" },
    });

    // The actual regression being guarded: the global error handler sends
    // err.message verbatim, and an ENOENT message embeds the server's
    // absolute path — on a route that requires no authentication at all.
    expect(res.body).not.toContain("ENOENT");
    expect(res.body).not.toContain("/srv/app");
    expect(res.body).not.toContain("widget-dist");
  });

  it("does not take down any other route", async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(res.statusCode).toBe(200);
  });
});
