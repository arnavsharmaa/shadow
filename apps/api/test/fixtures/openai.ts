import { readFileSync } from "node:fs";
import { importOpenAIBodySchema, type ImportOpenAIBody } from "@shadow/schemas";

const EXAMPLE = new URL(
  "../../../../examples/openai-chat/refund-conversation.json",
  import.meta.url,
);

/** The example conversation shipped in `examples/openai-chat`, as raw JSON. */
export function openAIRefundConversationJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
}

export function openAIRefundConversation(): ImportOpenAIBody {
  return importOpenAIBodySchema.parse(openAIRefundConversationJson());
}
