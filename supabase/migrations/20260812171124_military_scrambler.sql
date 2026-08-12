ALTER TABLE "tenants" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_owner_user_id_unique" UNIQUE("owner_user_id");