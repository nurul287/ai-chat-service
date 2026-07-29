import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Refuses to start if DATABASE_URL is not local. The suite truncates
    // tables, so a `.env` left pointing at production turns a routine test run
    // into production data loss.
    globalSetup: ["./src/test/local-db-guard.ts"],
    // Test files share one local Postgres, so parallel file execution causes
    // cross-test interference — one file truncating tables while another
    // inserts. Aurevo.BE hit exactly this as FK violations.
    fileParallelism: false,
    globals: false,
  },
});
