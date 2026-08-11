ALTER TABLE "api_keys" ADD COLUMN "kind" text DEFAULT 'secret' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_check" CHECK ("api_keys"."kind" in ('secret', 'publishable'));