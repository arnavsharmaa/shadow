import type { JsonValue, ShadowEvent, Trace } from "@shadow/schemas";
import { ilike, type SQL } from "drizzle-orm";
import { traces } from "../db/schema.js";

/**
 * Pluggable trace search. The initial implementation keeps a lower-cased
 * bag of words per trace in `traces.search_text` and matches with ILIKE.
 * A dedicated search backend can implement the same interface later.
 */
export interface SearchProvider {
  /** Build the searchable text for a trace from its fields and events. */
  buildSearchText(input: {
    trace: Pick<Trace, "id" | "name" | "tags" | "metadata">;
    agent: { slug: string; name: string };
    project: { slug: string; name: string };
    events: readonly Pick<ShadowEvent, "eventType" | "name" | "id">[];
    previous?: string;
  }): string;
  /** SQL predicate for a free-text query. */
  filter(query: string): SQL;
}

const MAX_SEARCH_TEXT = 64 * 1024;

function metadataTokens(value: JsonValue, depth = 0): string[] {
  if (depth > 3 || value === null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((v) => metadataTokens(v, depth + 1));
  return Object.entries(value).flatMap(([k, v]) => [k, ...metadataTokens(v, depth + 1)]);
}

export const likeSearchProvider: SearchProvider = {
  buildSearchText({ trace, agent, project, events, previous }) {
    const tokens = new Set<string>((previous ?? "").split(" ").filter(Boolean));
    const add = (value: string) => {
      const normalised = value.toLowerCase().trim();
      if (normalised) tokens.add(normalised.replace(/\s+/g, "_"));
    };
    add(trace.id);
    add(trace.name);
    trace.tags.forEach(add);
    metadataTokens(trace.metadata).forEach(add);
    add(agent.slug);
    add(agent.name);
    add(project.slug);
    add(project.name);
    for (const event of events) {
      add(event.id);
      add(event.name);
      if (event.eventType === "tool.request") add(`tool:${event.name}`);
    }
    let text = [...tokens].join(" ");
    if (text.length > MAX_SEARCH_TEXT) text = text.slice(0, MAX_SEARCH_TEXT);
    return text;
  },
  filter(query) {
    const escaped = query
      .toLowerCase()
      .trim()
      .replace(/[%_\\]/g, (c) => `\\${c}`);
    return ilike(traces.searchText, `%${escaped}%`);
  },
};
