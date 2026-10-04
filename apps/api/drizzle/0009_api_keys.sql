CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_name_idx" ON "api_keys" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_secret_idx" ON "api_keys" USING btree ("secret_hash");