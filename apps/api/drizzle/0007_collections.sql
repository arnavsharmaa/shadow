CREATE TABLE "collection_traces" (
	"collection_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_traces_collection_id_trace_id_pk" PRIMARY KEY("collection_id","trace_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_traces" ADD CONSTRAINT "collection_traces_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_traces" ADD CONSTRAINT "collection_traces_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_traces_trace_idx" ON "collection_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_name_idx" ON "collections" USING btree ("name");