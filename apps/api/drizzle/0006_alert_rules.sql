CREATE TABLE "alert_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"agent" text,
	"project" text,
	"metric" text NOT NULL,
	"threshold" real NOT NULL,
	"window_minutes" integer NOT NULL,
	"min_traces" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"last_value" real,
	"last_traces" integer,
	"last_evaluated_at" timestamp with time zone,
	"last_triggered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rules_name_idx" ON "alert_rules" USING btree ("name");