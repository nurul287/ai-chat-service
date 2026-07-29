import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Test files share one local Postgres, so parallel file execution causes
    // cross-test interference — one file truncating tables while another
    // inserts. Aurevo.BE hit exactly this as FK violations.
    fileParallelism: false,
    globals: false,
  },
});
