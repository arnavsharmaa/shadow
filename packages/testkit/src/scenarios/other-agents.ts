import type { AgentDefinition } from "@shadow/core";
import { PolicyBlockedError } from "@shadow/core";
import type { AgentHost, JsonObject, Outcome } from "@shadow/schemas";
import {
  MockToolAdapter,
  RuleBasedPolicyAdapter,
  ScriptedModelAdapter,
  approvingAfter,
  asObject,
} from "../adapters.js";

const SUPPORT_MODEL = { provider: "shadow-sim", model: "sim-support-1" } as const;
const MINI_MODEL = { provider: "shadow-sim", model: "sim-support-mini" } as const;

export interface FaqRequest extends JsonObject {
  customerId: string;
  question: string;
}

/** Successful, uneventful execution: answer a question from the knowledge base. */
export const faqAgentDefinition: AgentDefinition<FaqRequest> = {
  slug: "support-faq-agent",
  name: "Support FAQ Agent",
  description: "Answers customer questions from the knowledge base.",
  tags: ["support", "faq"],
  createAdapters: () => ({
    model: new ScriptedModelAdapter({
      query: (req) => ({
        text: "Search the knowledge base for the shipping timelines article.",
        data: { query: `shipping timelines ${String(asObject(req.parameters).region)}` },
        latencyMs: 410,
      }),
      answer: () => ({
        text: "Standard shipping takes 3-5 business days within the US. Express shipping (1-2 business days) is available at checkout. You'll receive tracking by email once the order ships.",
        latencyMs: 690,
      }),
    }),
    tools: new MockToolAdapter({
      read_customer: (args) => ({
        result: {
          id: asObject(args).customerId ?? null,
          name: "Ana Costa",
          email: "ana.costa@example.com",
          region: "US-East",
          tier: "standard",
        },
        latencyMs: 115,
      }),
      search_kb: (args) => ({
        result: {
          query: asObject(args).query ?? null,
          hits: [
            { id: "kb-118", title: "Shipping timelines and options", score: 0.93 },
            { id: "kb-042", title: "Tracking your order", score: 0.71 },
          ],
        },
        latencyMs: 210,
      }),
      read_article: (args) => ({
        result: {
          id: asObject(args).id ?? null,
          body: "Standard: 3-5 business days (US). Express: 1-2 business days. Tracking emails are sent at dispatch.",
        },
        latencyMs: 95,
      }),
      send_reply: (args) => ({
        result: { messageId: "msg_faq_1", status: "sent", to: asObject(args).to ?? null },
        latencyMs: 330,
      }),
    }),
    policies: new RuleBasedPolicyAdapter({}),
  }),
  async program(host: AgentHost, input: FaqRequest): Promise<Outcome> {
    host.context.set("customerId", input.customerId);
    host.state.set("/request", input);
    const customer = asObject(
      await host.tool({ name: "read_customer", arguments: { customerId: input.customerId } }),
    );
    host.context.set("region", customer.region ?? "unknown");
    const q = await host.model({
      ...MINI_MODEL,
      name: "formulate_query",
      messages: [{ role: "user", content: input.question }],
      parameters: { step: "query", region: customer.region ?? "" },
    });
    const query = String(asObject(asObject(q.message.content).data).query ?? input.question);
    const hits = asObject(await host.tool({ name: "search_kb", arguments: { query, limit: 3 } }));
    const top = (hits.hits as JsonObject[] | undefined)?.[0];
    host.state.set("/hits", hits.hits ?? []);
    const article = asObject(
      await host.tool({ name: "read_article", arguments: { id: top?.id ?? "kb-118" } }),
    );
    host.context.set("article", article.body ?? "");
    const answer = await host.model({
      ...SUPPORT_MODEL,
      name: "compose_answer",
      messages: [
        { role: "system", content: `Article: ${String(article.body)}` },
        { role: "user", content: input.question },
      ],
      parameters: { step: "answer" },
    });
    host.state.set("/answer", answer.message.content);
    await host.tool({
      name: "send_reply",
      arguments: { to: customer.email ?? null, body: answer.message.content },
    });
    host.snapshot();
    return {
      kind: "answered",
      label: "Question answered",
      summary: "Replied with shipping timelines from kb-118.",
    };
  },
};

export interface EnrichmentRequest extends JsonObject {
  companies: string[];
}

/** Expensive execution: redundant tool calls and verbose model calls. */
export const enrichmentAgentDefinition: AgentDefinition<EnrichmentRequest> = {
  slug: "enrichment-agent",
  name: "Lead Enrichment Agent",
  description: "Enriches company records; the naive loop re-fetches the same data repeatedly.",
  tags: ["sales", "enrichment"],
  createAdapters: () => ({
    model: new ScriptedModelAdapter({
      summarise: (req) => {
        const company = String(asObject(req.parameters).company);
        return {
          text:
            `${company} is a mid-market software company with roughly 400 employees and offices in three countries. Recent hiring suggests expansion in Europe. ` +
            "The account is a strong fit for the enterprise plan based on team size and technology stack. Recommended next step: outreach to the VP of Engineering with a security-focused pitch.".repeat(
              2,
            ),
          latencyMs: 1150,
        };
      },
      rank: () => ({
        text: "Ranked accounts by fit score.",
        data: { order: ["Northwind", "Contoso", "Fabrikam"] },
        latencyMs: 520,
      }),
    }),
    tools: new MockToolAdapter({
      enrich_company: (args) => {
        const name = String(asObject(args).name);
        return {
          result: {
            name,
            employees: 400 + name.length * 7,
            country: "DE",
            techStack: ["typescript", "postgres", "kubernetes"],
            fitScore: 0.6 + (name.length % 4) / 10,
          },
          latencyMs: 640,
          estimatedCost: 0.05,
        };
      },
      save_record: (args) => ({
        result: { saved: true, id: `rec_${String(asObject(args).name).toLowerCase()}` },
        latencyMs: 80,
      }),
    }),
    policies: new RuleBasedPolicyAdapter({}),
  }),
  async program(host: AgentHost, input: EnrichmentRequest): Promise<Outcome> {
    host.state.set("/companies", input.companies);
    const enriched: JsonObject[] = [];
    for (const company of input.companies) {
      // The bug: each company is enriched twice (once for the summary, once for saving).
      const first = asObject(
        await host.tool({ name: "enrich_company", arguments: { name: company } }),
      );
      await host.model({
        ...SUPPORT_MODEL,
        name: "summarise_company",
        messages: [{ role: "user", content: `Summarise ${company}: ${JSON.stringify(first)}` }],
        parameters: { step: "summarise", company },
      });
      const second = asObject(
        await host.tool({ name: "enrich_company", arguments: { name: company } }),
      );
      await host.tool({ name: "save_record", arguments: { name: company, record: second } });
      enriched.push(second);
      host.state.set(`/enriched/${company}`, second);
    }
    await host.model({
      ...MINI_MODEL,
      name: "rank_accounts",
      messages: [{ role: "user", content: JSON.stringify(enriched) }],
      parameters: { step: "rank" },
    });
    host.snapshot();
    return {
      kind: "completed",
      label: "Accounts enriched",
      summary: `Enriched ${input.companies.length} accounts with ${input.companies.length * 2} enrichment calls.`,
    };
  },
};

export interface AccessRequest extends JsonObject {
  requester: string;
  system: string;
  role: string;
  justification: string;
}

/** Human-in-the-loop execution: privileged access needs an approval that arrives. */
export const accessAgentDefinition: AgentDefinition<AccessRequest> = {
  slug: "access-request-agent",
  name: "Access Request Agent",
  description: "Grants system access; privileged roles require human approval.",
  tags: ["it", "approvals"],
  policyConfig: { "access.privileged_roles": { roles: ["admin", "owner"] } },
  createAdapters: () => ({
    model: new ScriptedModelAdapter({
      assess: (req) => ({
        text: `The request for ${String(asObject(req.parameters).role)} access is well justified but privileged; route through approval if required.`,
        latencyMs: 450,
      }),
    }),
    tools: new MockToolAdapter({
      lookup_user: (args) => ({
        result: {
          id: asObject(args).requester ?? null,
          department: "platform",
          manager: "m.ito@example.com",
          employmentStatus: "active",
        },
        latencyMs: 130,
      }),
      grant_access: (args) => ({
        result: {
          grantId: `grant_${String(asObject(args).role)}`,
          status: "granted",
          expiresAt: "2026-12-31T00:00:00.000Z",
        },
        latencyMs: 410,
      }),
      notify_requester: () => ({ result: { status: "sent" }, latencyMs: 150 }),
    }),
    policies: new RuleBasedPolicyAdapter({
      "access.privileged_roles": (subject, ctx) => {
        const roles = (ctx.config.roles as string[] | undefined) ?? [];
        const role = String(asObject(subject).role);
        return roles.includes(role)
          ? {
              decision: "approval_required",
              reason: `role '${role}' is privileged`,
              details: { roles },
            }
          : { decision: "allow", reason: `role '${role}' is not privileged` };
      },
    }),
    approvals: approvingAfter(45_000),
  }),
  async program(host: AgentHost, input: AccessRequest): Promise<Outcome> {
    host.state.set("/request", input);
    const user = asObject(
      await host.tool({ name: "lookup_user", arguments: { requester: input.requester } }),
    );
    host.context.set("requesterDepartment", user.department ?? "unknown");
    host.context.set("manager", user.manager ?? "unknown");
    await host.model({
      ...MINI_MODEL,
      name: "assess_request",
      messages: [{ role: "user", content: input.justification }],
      parameters: { step: "assess", role: input.role },
    });
    let granted: JsonObject | null = null;
    try {
      granted = asObject(
        await host.tool({
          name: "grant_access",
          arguments: { requester: input.requester, system: input.system, role: input.role },
          guard: {
            policy: "access.privileged_roles",
            subject: { role: input.role, system: input.system },
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof PolicyBlockedError)) throw error;
      const approval = await host.requestApproval({
        reason: error.info.evaluation.reason ?? "privileged role",
        request: { requester: input.requester, role: input.role },
      });
      host.state.set("/approval", { id: approval.approvalId, status: approval.decision });
      if (approval.decision === "approved") {
        granted = asObject(
          await host.tool({
            name: "grant_access",
            arguments: {
              requester: input.requester,
              system: input.system,
              role: input.role,
              approvalId: approval.approvalId,
            },
          }),
        );
      }
    }
    host.state.set("/grant", granted);
    await host.tool({
      name: "notify_requester",
      arguments: { requester: input.requester, status: granted ? "granted" : "denied" },
    });
    host.snapshot();
    return granted
      ? {
          kind: "granted",
          label: "Access granted after approval",
          summary: `Granted ${input.role} on ${input.system} to ${input.requester}.`,
        }
      : { kind: "denied", label: "Access denied", summary: "Approval was not granted." };
  },
};
