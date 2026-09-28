CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"trace_id" text,
	"details" jsonb NOT NULL,
	"request_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_seq_idx" ON "audit_log" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_trace_idx" ON "audit_log" USING btree ("trace_id","seq");