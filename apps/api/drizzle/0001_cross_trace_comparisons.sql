ALTER TABLE "comparisons" ADD COLUMN "target_trace_id" text;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_target_trace_id_traces_id_fk" FOREIGN KEY ("target_trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comparisons_target_trace_idx" ON "comparisons" USING btree ("target_trace_id");