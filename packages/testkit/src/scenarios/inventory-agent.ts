import type { AgentDefinition } from "@shadow/core";
import { ToolExecutionError } from "@shadow/core";
import type { AgentHost, JsonObject, Outcome } from "@shadow/schemas";
import {
  MockToolAdapter,
  RuleBasedPolicyAdapter,
  ScriptedModelAdapter,
  asObject,
} from "../adapters.js";

export interface InventoryRequest extends JsonObject {
  sku: string;
  quantity: number;
  warehouse: string;
  orderId: string;
}

const MODEL = { provider: "shadow-sim", model: "sim-support-mini" } as const;

const stock: Record<string, JsonObject> = {
  "SKU-7781": {
    sku: "SKU-7781",
    name: "Standing desk frame",
    available: 120,
    reserved: 8,
    warehouse: "wh-east",
  },
  "SKU-1200": {
    sku: "SKU-1200",
    name: "Monitor arm",
    available: 0,
    reserved: 0,
    warehouse: "wh-east",
  },
};

/** Tool-failure scenario: the inventory API times out three times in a row. */
export const inventoryAgentDefinition: AgentDefinition<InventoryRequest> = {
  slug: "inventory-agent",
  name: "Inventory Agent",
  description: "Fulfilment agent that checks stock before reserving or back-ordering an item.",
  tags: ["fulfilment", "inventory"],
  createAdapters: () => ({
    model: new ScriptedModelAdapter({
      plan: () => ({
        text: "Check live inventory for the SKU, then reserve stock if available, otherwise create a backorder.",
        latencyMs: 380,
      }),
      interpret: (req) => {
        const p = asObject(req.parameters);
        const lookup = asObject(p.lookup);
        const raw = lookup.available;
        const available = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
        const qty = Number(p.quantity ?? 0);
        const usable = Number.isFinite(available) ? available : 0;
        return {
          text: Number.isFinite(available)
            ? `${usable} units available; requested ${qty}. ${usable >= qty ? "Reserve stock." : "Create a backorder."}`
            : `Inventory response did not contain a numeric availability ("${String(raw)}"); treating as 0 and creating a backorder.`,
          data: {
            available: usable,
            action: usable >= qty ? "reserve" : "backorder",
            parsed: Number.isFinite(available),
          },
          latencyMs: 420,
        };
      },
    }),
    tools: new MockToolAdapter({
      "inventory.lookup": (args, ctx) => {
        if (ctx.occurrence <= 3) {
          throw Object.assign(
            new ToolExecutionError("inventory service timed out after 2000ms", {
              code: "ETIMEDOUT",
              retryable: true,
            }),
            { latencyMs: 2000 },
          );
        }
        const sku = String(asObject(args).sku);
        return { result: stock[sku] ?? { sku, available: 0 }, latencyMs: 210 };
      },
      "inventory.cached_lookup": (args) => {
        const sku = String(asObject(args).sku);
        // The cache serves a stale, malformed document.
        return {
          result: { sku, available: "n/a", cachedAt: "2026-08-30T02:00:00.000Z", stale: true },
          latencyMs: 35,
        };
      },
      "orders.reserve_stock": (args) => ({
        result: {
          reservationId: `res_${String(asObject(args).orderId)}`,
          status: "reserved",
          quantity: asObject(args).quantity ?? null,
        },
        latencyMs: 260,
      }),
      "orders.create_backorder": (args) => ({
        result: {
          backorderId: `bo_${String(asObject(args).orderId)}`,
          status: "backordered",
          eta: "2026-10-15",
        },
        latencyMs: 300,
      }),
    }),
    policies: new RuleBasedPolicyAdapter({}),
  }),

  async program(host: AgentHost, input: InventoryRequest): Promise<Outcome> {
    host.context.set("warehouse", input.warehouse);
    host.context.set("maxRetries", 2);
    host.state.set("/request", input);

    await host.model({
      ...MODEL,
      name: "plan",
      messages: [
        {
          role: "user",
          content: `Reserve ${input.quantity} x ${input.sku} for order ${input.orderId}.`,
        },
      ],
      parameters: { step: "plan" },
    });

    let lookup: JsonObject | null = null;
    const maxRetries = Number(host.context.get("maxRetries") ?? 0);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        lookup = asObject(
          await host.tool({
            name: "inventory.lookup",
            arguments: { sku: input.sku, warehouse: input.warehouse },
          }),
        );
        break;
      } catch (error) {
        host.state.set("/attempts", attempt + 1);
        host.note("retry", {
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!lookup) {
      host.state.set("/fallback", "cached_lookup");
      lookup = asObject(
        await host.tool({ name: "inventory.cached_lookup", arguments: { sku: input.sku } }),
      );
    }
    host.state.set("/lookup", lookup);

    const interpretation = await host.model({
      ...MODEL,
      name: "interpret_inventory",
      messages: [
        { role: "user", content: `Requested quantity: ${input.quantity}.` },
        { role: "tool", name: "inventory.lookup", content: lookup },
      ],
      parameters: { step: "interpret", lookup, quantity: input.quantity },
    });
    const data = asObject(asObject(interpretation.message.content).data);
    host.state.set("/decision", data);

    if (data.action === "reserve") {
      const reservation = asObject(
        await host.tool({
          name: "orders.reserve_stock",
          arguments: { orderId: input.orderId, sku: input.sku, quantity: input.quantity },
        }),
      );
      host.state.set("/result", reservation);
      return {
        kind: "reserved",
        label: "Stock reserved",
        summary: `Reserved ${input.quantity} x ${input.sku} (${String(reservation.reservationId)}).`,
      };
    }
    const backorder = asObject(
      await host.tool({
        name: "orders.create_backorder",
        arguments: { orderId: input.orderId, sku: input.sku, quantity: input.quantity },
      }),
    );
    host.state.set("/result", backorder);
    const wrong = data.parsed !== true;
    return {
      kind: wrong ? "incorrect_action" : "backordered",
      label: wrong
        ? "Incorrect action: backorder created from malformed data"
        : "Backorder created",
      summary: wrong
        ? `The agent could not parse availability from the cached fallback and back-ordered ${input.sku} although stock may be available.`
        : `Back-ordered ${input.quantity} x ${input.sku}.`,
    };
  },
};
