CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"replayable" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"event_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_branch_id" text,
	"fork_id" text,
	"fork_event_id" text,
	"fork_sequence" integer,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'recording' NOT NULL,
	"outcome" jsonb,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comparisons" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"base_branch_id" text NOT NULL,
	"target_branch_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_version" text NOT NULL,
	"trace_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"parent_event_id" text,
	"span_id" text,
	"parent_span_id" text,
	"sequence" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"duration_ms" real,
	"event_type" text NOT NULL,
	"source" text DEFAULT 'sdk' NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"name" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_usage" jsonb,
	"estimated_cost" jsonb,
	"state_version" integer,
	"correlation_id" text,
	"extra" jsonb
);
--> statement-breakpoint
CREATE TABLE "forks" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"parent_branch_id" text NOT NULL,
	"child_branch_id" text NOT NULL,
	"fork_event_id" text NOT NULL,
	"fork_sequence" integer NOT NULL,
	"overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "replays" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"fork_id" text,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"event_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "state_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"event_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"state_version" integer,
	"state" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"root_branch_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"schema_version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" real,
	"outcome" jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"branch_count" integer DEFAULT 1 NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forks" ADD CONSTRAINT "forks_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replays" ADD CONSTRAINT "replays_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replays" ADD CONSTRAINT "replays_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_snapshots" ADD CONSTRAINT "state_snapshots_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_snapshots" ADD CONSTRAINT "state_snapshots_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_project_slug_idx" ON "agents" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "artifacts_trace_idx" ON "artifacts" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "branches_trace_idx" ON "branches" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "branches_parent_idx" ON "branches" USING btree ("parent_branch_id");--> statement-breakpoint
CREATE INDEX "comparisons_trace_idx" ON "comparisons" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "comparisons_branches_idx" ON "comparisons" USING btree ("base_branch_id","target_branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_branch_sequence_idx" ON "events" USING btree ("branch_id","sequence");--> statement-breakpoint
CREATE INDEX "events_trace_sequence_idx" ON "events" USING btree ("trace_id","sequence");--> statement-breakpoint
CREATE INDEX "events_timestamp_idx" ON "events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "events_name_idx" ON "events" USING btree ("name");--> statement-breakpoint
CREATE INDEX "events_parent_idx" ON "events" USING btree ("parent_event_id");--> statement-breakpoint
CREATE INDEX "forks_trace_idx" ON "forks" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "forks_child_idx" ON "forks" USING btree ("child_branch_id");--> statement-breakpoint
CREATE INDEX "replays_branch_idx" ON "replays" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "state_snapshots_branch_sequence_idx" ON "state_snapshots" USING btree ("branch_id","sequence");--> statement-breakpoint
CREATE INDEX "traces_project_idx" ON "traces" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "traces_agent_idx" ON "traces" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "traces_status_idx" ON "traces" USING btree ("status");--> statement-breakpoint
CREATE INDEX "traces_started_at_idx" ON "traces" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "traces_tags_idx" ON "traces" USING gin ("tags");