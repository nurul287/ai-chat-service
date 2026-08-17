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
    // Runs after every test in every file — see the file's own comment.
    // Closes a real deadlock: several code paths write to Postgres
    // fire-and-forget, and that write can still be in flight when the next
    // test's cleanup issues a cascading DELETE FROM tenants, letting the
    // two lock rows in conflicting order under CI's timing.
    setupFiles: ["./src/test/flush-background-writes.ts"],
    globals: false,
  },
});
