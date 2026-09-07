import type { AgentDefinition } from "@shadow/core";
import type { JsonObject, JsonValue, Override } from "@shadow/schemas";
import {
  accessAgentDefinition,
  enrichmentAgentDefinition,
  faqAgentDefinition,
} from "./scenarios/other-agents.js";
import { inventoryAgentDefinition } from "./scenarios/inventory-agent.js";
import { refundAgentDefinition } from "./scenarios/refund-agent.js";

export const DEMO_PROJECT = {
  slug: "support-agent",
  name: "Support Agent",
  description: "Customer-support and fulfilment agents (demo data).",
};

/** All deterministic, replayable agents bundled with Shadow. */
export const scenarioDefinitions: AgentDefinition<never>[] = [
  refundAgentDefinition as unknown as AgentDefinition<never>,
  inventoryAgentDefinition as unknown as AgentDefinition<never>,
  faqAgentDefinition as unknown as AgentDefinition<never>,
  enrichmentAgentDefinition as unknown as AgentDefinition<never>,
  accessAgentDefinition as unknown as AgentDefinition<never>,
];

export function findScenario(slug: string): AgentDefinition | undefined {
  return (scenarioDefinitions as unknown as AgentDefinition[]).find((d) => d.slug === slug);
}

export interface DemoTraceSpec {
  traceId: string;
  /** Project the trace belongs to (defaults to DEMO_PROJECT). */
  project?: { slug: string; name: string; description: string };
  rootBranchId: string;
  agent: AgentDefinition;
  name: string;
  input: JsonValue;
  seed: string;
  startAt: string;
  tags: string[];
  metadata: JsonObject;
  /** Optional fork automatically created and replayed by the seed. */
  fork?: {
    name: string;
    selectEvent: { eventType: string; name: string; occurrence?: number };
    overrides: Override[];
  };
}

export const DEMO_TRACE_IDS = {
  refundViolation: "trc_demo_refund_violation",
  inventoryTimeout: "trc_demo_inventory_timeout",
  faqSuccess: "trc_demo_faq_success",
  enrichmentExpensive: "trc_demo_enrichment_expensive",
  accessApproval: "trc_demo_access_approval",
  refundEnterprise: "trc_demo_refund_enterprise",
  faqSecond: "trc_demo_faq_second",
} as const;

/** The deterministic demo data set seeded into the database. */
export const demoTraces: DemoTraceSpec[] = [
  {
    traceId: DEMO_TRACE_IDS.refundViolation,
    rootBranchId: "br_demo_refund_violation_main",
    agent: refundAgentDefinition as unknown as AgentDefinition,
    name: "refund-request: defective headphones",
    input: {
      customerId: "cus_1001",
      channel: "email",
      message:
        "Hi, the noise-cancelling headphones I ordered ($480, order ord_5001) stopped working after two days. I'd like a full refund please.",
    },
    seed: "demo-refund-violation",
    startAt: "2026-09-01T09:12:04.000Z",
    tags: ["refund", "policy", "demo"],
    metadata: { customerId: "cus_1001", ticketId: "TCK-20931", channel: "email" },
    fork: {
      name: "fork-1",
      selectEvent: { eventType: "tool.request", name: "refund_order" },
      overrides: [
        {
          id: "ovr_1",
          kind: "context",
          op: "set",
          key: "refundLimit",
          value: 100,
          label: "Use the real autonomous refund limit",
        },
      ],
    },
  },
  {
    traceId: DEMO_TRACE_IDS.inventoryTimeout,
    rootBranchId: "br_demo_inventory_timeout_main",
    agent: inventoryAgentDefinition as unknown as AgentDefinition,
    project: {
      slug: "fulfilment",
      name: "Fulfilment",
      description: "Order fulfilment and inventory agents (demo data).",
    },
    name: "reserve-stock: SKU-7781 x 4",
    input: { sku: "SKU-7781", quantity: 4, warehouse: "wh-east", orderId: "ord_9032" },
    seed: "demo-inventory-timeout",
    startAt: "2026-09-01T10:41:30.000Z",
    tags: ["fulfilment", "timeout", "demo"],
    metadata: { orderId: "ord_9032", customerId: "cus_3140" },
    fork: {
      name: "fork-1",
      selectEvent: { eventType: "tool.request", name: "inventory.lookup", occurrence: 1 },
      overrides: [
        {
          id: "ovr_1",
          kind: "tool_result",
          tool: "inventory.lookup",
          occurrence: 1,
          result: {
            sku: "SKU-7781",
            name: "Standing desk frame",
            available: 120,
            reserved: 8,
            warehouse: "wh-east",
          },
          label: "Inventory service responds",
        },
      ],
    },
  },
  {
    traceId: DEMO_TRACE_IDS.faqSuccess,
    rootBranchId: "br_demo_faq_success_main",
    agent: faqAgentDefinition as unknown as AgentDefinition,
    name: "faq: shipping timelines",
    input: {
      customerId: "cus_4410",
      question: "How long does standard shipping take, and can I upgrade to express?",
    },
    seed: "demo-faq-success",
    startAt: "2026-09-01T11:05:12.000Z",
    tags: ["faq", "demo"],
    metadata: { customerId: "cus_4410", ticketId: "TCK-20988" },
  },
  {
    traceId: DEMO_TRACE_IDS.enrichmentExpensive,
    rootBranchId: "br_demo_enrichment_expensive_main",
    agent: enrichmentAgentDefinition as unknown as AgentDefinition,
    project: {
      slug: "sales-ops",
      name: "Sales Ops",
      description: "Lead enrichment automation (demo data).",
    },
    name: "enrich-leads: weekly batch",
    input: { companies: ["Northwind", "Contoso", "Fabrikam"] },
    seed: "demo-enrichment-expensive",
    startAt: "2026-09-01T12:30:00.000Z",
    tags: ["enrichment", "cost", "demo"],
    metadata: { batchId: "batch-36" },
  },
  {
    traceId: DEMO_TRACE_IDS.accessApproval,
    rootBranchId: "br_demo_access_approval_main",
    agent: accessAgentDefinition as unknown as AgentDefinition,
    name: "access-request: admin on billing-db",
    input: {
      requester: "u_priya",
      system: "billing-db",
      role: "admin",
      justification: "Need to rotate credentials during the incident on 2026-09-01.",
    },
    seed: "demo-access-approval",
    startAt: "2026-09-01T14:18:45.000Z",
    tags: ["approvals", "demo"],
    metadata: { requester: "u_priya", incident: "INC-4471" },
  },
  {
    traceId: DEMO_TRACE_IDS.refundEnterprise,
    rootBranchId: "br_demo_refund_enterprise_main",
    agent: refundAgentDefinition as unknown as AgentDefinition,
    name: "refund-request: wrong keyboard shipped",
    input: {
      customerId: "cus_2002",
      channel: "chat",
      message: "You shipped the wrong keyboard for order ord_7710 ($85). Please refund it.",
    },
    seed: "demo-refund-enterprise",
    startAt: "2026-09-02T08:02:19.000Z",
    tags: ["refund", "demo"],
    metadata: { customerId: "cus_2002", ticketId: "TCK-21044", channel: "chat" },
  },
  {
    traceId: DEMO_TRACE_IDS.faqSecond,
    rootBranchId: "br_demo_faq_second_main",
    agent: faqAgentDefinition as unknown as AgentDefinition,
    name: "faq: tracking email",
    input: {
      customerId: "cus_4410",
      question: "I haven't received a tracking email yet, when should I expect it?",
    },
    seed: "demo-faq-second",
    startAt: "2026-09-02T09:47:03.000Z",
    tags: ["faq", "demo"],
    metadata: { customerId: "cus_4410", ticketId: "TCK-21050" },
  },
];
