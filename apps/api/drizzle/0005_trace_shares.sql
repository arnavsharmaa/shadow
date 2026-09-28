CREATE TABLE "trace_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "trace_shares" ADD CONSTRAINT "trace_shares_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trace_shares_token_idx" ON "trace_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "trace_shares_trace_idx" ON "trace_shares" USING btree ("trace_id");