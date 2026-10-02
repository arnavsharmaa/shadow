ALTER TABLE "alert_rules" ADD COLUMN "mode" text DEFAULT 'threshold' NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "baseline_windows" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "last_baseline" real;