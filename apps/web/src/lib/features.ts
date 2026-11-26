import type { HealthFeatures } from "./api";

/**
 * The webhook line of the Settings page: which finished traces notify, in what shape, and
 * what narrows them (projects, tags, outcome kinds, a cost floor), as `/health` reports it.
 */
export function describeWebhook(webhook: HealthFeatures["webhook"]): string {
  if (!webhook?.enabled) return "off";
  const parts = [`${webhook.events ?? "failures"} as ${webhook.format ?? "json"}`];
  if (webhook.projects) parts.push(`for ${webhook.projects.join(", ")}`);
  if (webhook.tags) parts.push(`tagged ${webhook.tags.join(" or ")}`);
  if (webhook.outcomes) parts.push(`ending in ${webhook.outcomes.join(" or ")}`);
  if (webhook.minCost !== undefined) parts.push(`costing at least $${webhook.minCost}`);
  return parts.join(" ");
}
