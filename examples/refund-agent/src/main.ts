/**
 * Example: record the refund agent with the Shadow SDK.
 *
 * Run the Shadow API first (`pnpm dev` from the repository root), then:
 *
 *   pnpm --filter @shadow/example-refund-agent start
 *
 * The agent's tools and model are deterministic simulations from
 * `@shadow/testkit`, so no API keys are needed. Because the agent slug
 * (`refund-agent`) has a registered program, the recorded trace can be forked
 * and replayed in the web UI or with `shadow fork ... --replay`.
 */
import { Shadow } from "@shadow/sdk";
import { refundAgentDefinition, withDefinition, type RefundRequest } from "@shadow/testkit";

const endpoint = process.env.SHADOW_ENDPOINT ?? "http://localhost:4000";
const webUrl = process.env.SHADOW_WEB_URL ?? "http://localhost:3000";

const request: RefundRequest = {
  customerId: "cus_1001",
  channel: "email",
  message:
    "Hi, the noise-cancelling headphones I ordered ($480, order ord_5001) stopped working after two days. I'd like a full refund please.",
};

async function main() {
  const shadow = new Shadow({
    project: "support-agent",
    agent: refundAgentDefinition.slug,
    endpoint,
  });
  const trace = shadow.startTrace({
    name: "refund-request: defective headphones (sdk example)",
    metadata: {
      customerId: request.customerId,
      ticketId: "TCK-EXAMPLE",
      channel: request.channel,
      source: "examples/refund-agent",
    },
    tags: ["refund", "example"],
  });

  // Bind the deterministic adapters to the SDK trace; `simulateLatency` sleeps
  // a fraction of each simulated latency so the timeline looks realistic.
  const bound = withDefinition(trace, refundAgentDefinition, { simulateLatency: 0.25 });

  console.log(`recording trace ${trace.id} -> ${endpoint}`);
  try {
    const outcome = await trace.run((_host, input) => bound.run(input), request);
    console.log(
      `outcome: ${outcome?.label ?? "completed"}${outcome?.summary ? ` (${outcome.summary})` : ""}`,
    );
  } catch (error) {
    console.error("agent failed:", error instanceof Error ? error.message : error);
  } finally {
    await shadow.shutdown();
  }
  console.log(`open ${webUrl}/traces/${trace.id}`);
  console.log(`or:   shadow traces inspect ${trace.id}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
