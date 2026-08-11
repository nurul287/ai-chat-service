CREATE TABLE "tenant_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"endpoint_url" text NOT NULL,
	"hmac_secret_encrypted" text NOT NULL,
	"auth_header_name" text,
	"auth_header_value_encrypted" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_tools" ADD CONSTRAINT "tenant_tools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tenant_tools_tenant" ON "tenant_tools" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenant_tools_tenant_name_active" ON "tenant_tools" USING btree ("tenant_id","name") WHERE "tenant_tools"."revoked_at" is null;