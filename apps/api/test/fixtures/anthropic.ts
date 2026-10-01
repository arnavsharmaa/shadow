import { readFileSync } from "node:fs";
import { importAnthropicBodySchema, type ImportAnthropicBody } from "@shadow/schemas";

const EXAMPLE = new URL(
  "../../../../examples/anthropic-messages/refund-conversation.json",
  import.meta.url,
);

/** The example conversation shipped in `examples/anthropic-messages`, as raw JSON. */
export function refundConversationJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
}

export function refundConversation(): ImportAnthropicBody {
  return importAnthropicBodySchema.parse(refundConversationJson());
}
