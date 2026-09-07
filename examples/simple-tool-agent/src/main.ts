/**
 * Example: an inventory agent whose tool call times out, recorded with the
 * Shadow SDK. Demonstrates tool-result overrides: fork before the first
 * `inventory.lookup` call and replace the timeout with a real response.
 *
 *   pnpm --filter @shadow/example-simple-tool-agent start
 *
 * Then, with the CLI (replace the ids printed by this script):
 *
 *   shadow fork <traceId> --at <inventory.lookup eventId> \
 *     --tool-result 'inventory.lookup={"sku":"SKU-7781","available":120}' --replay
 */
import { Shadow } from "@shadow/sdk";
import { inventoryAgentDefinition, withDefinition, type InventoryRequest } from "@shadow/testkit";

const endpoint = process.env.SHADOW_ENDPOINT ?? "http://localhost:4000";
const webUrl = process.env.SHADOW_WEB_URL ?? "http://localhost:3000";

const request: InventoryRequest = {
  sku: "SKU-7781",
  quantity: 4,
  warehouse: "wh-east",
  orderId: "ord_9032",
};

async function main() {
  const shadow = new Shadow({
    project: "fulfilment",
    agent: inventoryAgentDefinition.slug,
    endpoint,
  });
  const trace = shadow.startTrace({
    name: "reserve-stock: SKU-7781 x 4 (sdk example)",
    metadata: { orderId: request.orderId, source: "examples/simple-tool-agent" },
    tags: ["inventory", "timeout", "example"],
  });
  const bound = withDefinition(trace, inventoryAgentDefinition, { simulateLatency: 0.1 });

  console.log(`recording trace ${trace.id} -> ${endpoint}`);
  try {
    const outcome = await trace.run((_host, input) => bound.run(input), request);
    console.log(`outcome: ${outcome?.label ?? "completed"}`);
  } finally {
    await shadow.shutdown();
  }
  console.log(`open ${webUrl}/traces/${trace.id}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
