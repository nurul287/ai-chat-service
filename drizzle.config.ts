import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./supabase/migrations",
  dialect: "postgresql",
  // Matches Supabase's own timestamp-based migration filename convention, so
  // Supabase CLI's db:reset/db:push apply these files exactly like the
  // hand-written ones from Sprint 1 — no change to how migrations are applied,
  // only to how they're written.
  migrations: { prefix: "supabase" },
  dbCredentials: { url: process.env.DATABASE_URL! },
});
