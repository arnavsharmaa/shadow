import { expect, test, type Page } from "@playwright/test";

const REFUND_TRACE_ID = "trc_demo_refund_violation";

async function openRefundTrace(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("trace-explorer")).toBeVisible();
  const row = page.locator('[data-testid="trace-row"][data-trace-id="trc_demo_refund_violation"]');
  await expect(row).toBeVisible();
  await row.getByTestId("trace-link").click();
  await expect(page.getByTestId("trace-detail")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/traces/${REFUND_TRACE_ID}`));
}

test.describe("Refund agent: rewind, fork, replay, compare", () => {
  test("the canonical counterfactual workflow works end to end", async ({ page }) => {
    // 1. Trace Explorer lists the seeded traces with their key columns.
    await page.goto("/");
    await expect(page.getByTestId("trace-table")).toBeVisible();
    await expect(page.locator('[data-testid="trace-row"]')).toHaveCount(7);
    const refundRow = page.locator(
      '[data-testid="trace-row"][data-trace-id="trc_demo_refund_violation"]',
    );
    await expect(refundRow).toContainText("Policy violation");
    await expect(refundRow).toContainText("failed");

    // 2. Open the refund trace.
    await refundRow.getByTestId("trace-link").click();
    await expect(page.getByTestId("trace-detail")).toBeVisible();
    await expect(page.getByTestId("trace-header")).toContainText(
      "Refund Agent".length > 0 ? "refund-agent" : "",
    );

    // 3. Select the refund step (the refund_order tool request) in the execution tree.
    const refundNode = page.locator(
      '[data-testid="event-node"][data-event-type="tool.request"][data-event-name="refund_order"]',
    );
    await expect(refundNode).toBeVisible();
    await refundNode.click();
    await expect(page.getByTestId("event-name")).toHaveText("refund_order");
    await expect(page.getByTestId("event-input")).toContainText("480");

    // The email the agent sent is stored as an artifact linked to the send_email response.
    await page
      .locator(
        '[data-testid="event-node"][data-event-type="tool.response"][data-event-name="send_email"]',
      )
      .click();
    await expect(page.getByTestId("event-artifacts")).toContainText(
      "email to jordan.blake@example.com",
    );
    await expect(page.getByTestId("event-artifacts")).toContainText("Your refund has been issued");
    await refundNode.click();

    // 4. Inspect the state: the agent believed the autonomous limit was 500.
    const inspector = page.getByTestId("state-inspector");
    await expect(inspector).toBeVisible();
    await expect(page.getByTestId("context-value-refundLimit")).toHaveText("500");
    await page.getByTestId("inspector-tab-state").click();
    await expect(page.getByTestId("state-json")).toContainText("selectedOrderId");
    await page.getByTestId("inspector-tab-context").click();

    // 5. Fork from here.
    await page.getByTestId("fork-from-here").click();
    const dialog = page.getByTestId("fork-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("refund_order");

    // 6. Change the refund limit from 500 to 100 via a context override.
    await dialog.getByTestId("context-chip-refundLimit").click();
    const row = dialog.getByTestId("override-row").first();
    await expect(row.getByTestId("override-field")).toHaveValue("refundLimit");
    await expect(row.getByTestId("override-value")).toHaveValue("500");
    await row.getByTestId("override-value").fill("100");
    await dialog.getByTestId("fork-name").fill("fork-limit-100");

    // 7. Start the deterministic replay; 8/9. Shadow navigates to the comparison.
    await dialog.getByTestId("run-counterfactual").click();
    await expect(page).toHaveURL(/\/compare\?comparison=cmp_/, { timeout: 60_000 });
    const comparison = page.getByTestId("comparison-view");
    await expect(comparison).toBeVisible();
    await expect(page.getByTestId("base-branch-name")).toHaveText("main");
    await expect(page.getByTestId("target-branch-name")).toHaveText("fork-limit-100");

    // 10. The policy outcome changed: violation -> approval requested.
    await expect(page.getByTestId("metric-outcome-base")).toHaveText("Policy violation");
    await expect(page.getByTestId("metric-outcome-target")).toHaveText("Approval requested");
    await expect(page.getByTestId("metric-policy")).toContainText("changed");
    await expect(page.getByTestId("metric-cost-delta")).toContainText("-");

    // 11. The first divergence is the refund policy evaluation.
    const divergence = page.getByTestId("first-divergence");
    await expect(divergence).toBeVisible();
    await expect(page.getByTestId("first-divergence-summary")).toContainText(
      "refund.autonomous_limit",
    );
    await expect(page.getByTestId("first-divergence-summary")).toContainText("approval_required");
    await expect(page.getByTestId("first-divergence-fields")).toContainText("output.decision");
    await expect(page.getByTestId("applied-overrides")).toContainText("refundLimit = 100");
    await expect(page.getByTestId("context-diff")).toContainText("refundLimit");

    // The new branch is visible in the trace detail and its lineage shows the override.
    await page.getByTestId("target-branch-name").click();
    await expect(page.getByTestId("trace-detail")).toBeVisible();
    await expect(page.getByTestId("branch-select")).toContainText("fork-limit-100");
    await expect(page.getByTestId("branch-outcome")).toHaveText("Approval requested");
    await expect(
      page.locator('[data-testid="event-node"][data-event-type="human.approval_requested"]'),
    ).toBeVisible();
  });

  test("branch graph supports renaming and deleting forks", async ({ page }) => {
    await openRefundTrace(page);
    await page.getByTestId("tab-branches").click();
    const graph = page.getByTestId("branch-graph");
    await expect(graph).toBeVisible();
    const nodes = graph.locator('[data-testid="branch-node"]');
    await expect(nodes.first()).toBeVisible();
    const initial = await nodes.count();
    expect(initial).toBeGreaterThanOrEqual(2);

    // Rename the seeded fork.
    await graph.getByRole("button", { name: "Rename fork-1" }).click();
    const rename = page.getByTestId("rename-dialog");
    await rename.getByLabel("New name").fill("limit-100-seeded");
    await rename.getByRole("button", { name: "Save" }).click();
    await expect(graph).toContainText("limit-100-seeded");

    // Create a temporary fork with a tool-result override, then delete it.
    await page.getByTestId("tab-events").click();
    await page
      .locator(
        '[data-testid="event-node"][data-event-type="tool.request"][data-event-name="send_email"]',
      )
      .click();
    await page.getByTestId("fork-from-here").click();
    const dialog = page.getByTestId("fork-dialog");
    await dialog.getByTestId("fork-name").fill("fork-temporary");
    await dialog.getByTestId("add-tool-result-override").click();
    await dialog.getByTestId("override-value").fill('{"status":"queued","messageId":"msg_test"}');
    await dialog.getByTestId("run-counterfactual").click();
    await expect(page).toHaveURL(/\/compare\?comparison=/, { timeout: 60_000 });
    await expect(page.getByTestId("first-divergence-summary")).toContainText("send_email");
    await expect(page.getByTestId("target-branch-name")).toHaveText("fork-temporary");

    await page.goto(`/traces/${REFUND_TRACE_ID}`);
    await page.getByTestId("tab-branches").click();
    const after = page.getByTestId("branch-graph").locator('[data-testid="branch-node"]');
    await expect(after).toHaveCount(initial + 1);
    await page.getByRole("button", { name: "Delete fork-temporary" }).click();
    await page.getByTestId("confirm-delete").click();
    await expect(after).toHaveCount(initial);
  });

  test("the execution tree can be filtered by name or type", async ({ page }) => {
    await openRefundTrace(page);
    const nodes = page.locator('[data-testid="event-node"]');
    await expect(nodes.first()).toBeVisible();
    const total = await nodes.count();

    await page.getByTestId("event-filter").fill("refund_order");
    await expect(page.getByTestId("event-filter-count")).toContainText("match");
    const matching = await nodes.count();
    expect(matching).toBeGreaterThan(0);
    expect(matching).toBeLessThan(total);
    for (const name of await nodes.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-event-name")),
    )) {
      expect(name).toBe("refund_order");
    }
    await nodes.first().click();
    await expect(page.getByTestId("event-name")).toHaveText("refund_order");

    await page.getByTestId("event-filter").fill("policy.");
    for (const type of await nodes.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-event-type")),
    )) {
      expect(type?.startsWith("policy.")).toBe(true);
    }

    await page.getByTestId("event-filter").fill("");
    await expect(nodes).toHaveCount(total);
  });

  test("tags can be added and removed from the trace header", async ({ page }) => {
    await openRefundTrace(page);
    const editor = page.getByTestId("tag-editor");
    await expect(editor).toBeVisible();
    const before = await editor.locator('[data-testid="trace-tag"]').count();

    await editor.getByTestId("tag-input").fill("triaged, e2e-check");
    await editor.getByTestId("tag-input").press("Enter");
    await expect(editor.locator('[data-testid="trace-tag"][data-tag="triaged"]')).toBeVisible();
    await expect(editor.locator('[data-testid="trace-tag"][data-tag="e2e-check"]')).toBeVisible();

    // The change is persisted: it survives a reload and reaches the explorer's tag filter.
    await page.reload();
    await expect(
      page.getByTestId("tag-editor").locator('[data-testid="trace-tag"][data-tag="triaged"]'),
    ).toBeVisible();
    await page.goto("/?tag=e2e-check");
    await expect(page.locator('[data-testid="trace-row"]')).toHaveCount(1);
    await expect(
      page.locator('[data-testid="trace-row"][data-trace-id="trc_demo_refund_violation"]'),
    ).toBeVisible();

    await openRefundTrace(page);
    await page.getByRole("button", { name: "Remove tag triaged" }).click();
    await expect(
      page.getByTestId("tag-editor").locator('[data-testid="trace-tag"][data-tag="triaged"]'),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Remove tag e2e-check" }).click();
    await expect(page.getByTestId("tag-editor").locator('[data-testid="trace-tag"]')).toHaveCount(
      before,
    );
  });

  test("OTLP-imported traces fork without replay", async ({ page, request }) => {
    const apiUrl = `http://127.0.0.1:${process.env.SHADOW_E2E_API_PORT ?? 4100}`;
    const traceId = "e2e0000000000000000000000000abcd";
    const ns = (offsetMs: number) =>
      String(1_788_253_924_000_000_000n + BigInt(offsetMs) * 1_000_000n);
    const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const imported = await request.post(`${apiUrl}/api/v1/otlp/v1/traces`, {
      data: {
        resourceSpans: [
          {
            resource: {
              attributes: [str("service.name", "otel-bot"), str("service.namespace", "e2e")],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId: "e2e0000000000001",
                    name: "handle ticket",
                    kind: 2,
                    startTimeUnixNano: ns(0),
                    endTimeUnixNano: ns(500),
                  },
                  {
                    traceId,
                    spanId: "e2e0000000000002",
                    parentSpanId: "e2e0000000000001",
                    name: "execute_tool lookup",
                    kind: 1,
                    startTimeUnixNano: ns(100),
                    endTimeUnixNano: ns(200),
                    attributes: [
                      str("gen_ai.operation.name", "execute_tool"),
                      str("gen_ai.tool.name", "lookup"),
                      str("gen_ai.tool.call.result", '{"found":true}'),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(imported.ok()).toBeTruthy();

    await page.goto(`/traces/trc_otel_${traceId}`);
    await expect(page.getByTestId("trace-detail")).toBeVisible();
    await expect(page.getByTestId("replay-unavailable-badge")).toBeVisible();
    await page
      .locator(
        '[data-testid="event-node"][data-event-type="tool.request"][data-event-name="lookup"]',
      )
      .click();
    await page.getByTestId("fork-from-here").click();
    const dialog = page.getByTestId("fork-dialog");
    await expect(dialog.getByTestId("replay-unavailable")).toContainText("otel-bot");
    await expect(dialog.getByTestId("run-counterfactual")).toHaveText("Create branch");
    await dialog.getByTestId("fork-name").fill("inspect-only");
    await dialog.getByTestId("add-context-override").click();
    await dialog.getByTestId("override-field").fill("region");
    await dialog.getByTestId("override-value").fill("eu");
    await dialog.getByTestId("run-counterfactual").click();

    // The branch is created and selected; no comparison page is opened.
    await expect(page).toHaveURL(/branch=/);
    await expect(page).not.toHaveURL(/compare/);
    await expect(page.getByTestId("branch-select")).toContainText("inspect-only");
    const forkNode = page.locator('[data-testid="event-node"][data-event-type="fork.created"]');
    await expect(forkNode).toBeVisible();
    await forkNode.click();
    await expect(page.getByTestId("event-name")).toHaveText("inspect-only");
    const forks = await (
      await request.get(`${apiUrl}/api/v1/traces/trc_otel_${traceId}/forks`)
    ).json();
    expect(forks.items).toHaveLength(1);
    expect(forks.items[0].overrides).toHaveLength(1);
    expect(forks.items[0].overrides[0]).toMatchObject({
      kind: "context",
      op: "set",
      key: "region",
      value: "eu",
    });

    // The refund demo agent is replayable, so it keeps the normal wording.
    await openRefundTrace(page);
    await expect(page.getByTestId("replay-unavailable-badge")).toHaveCount(0);
  });

  test("saved comparisons are listed on the trace", async ({ page }) => {
    await openRefundTrace(page);
    await page.getByTestId("tab-comparisons").click();
    const rows = page.locator('[data-testid="comparison-row"]');
    await expect(rows.first()).toBeVisible();
    await expect(page.getByTestId("tab-comparisons")).toContainText(/\(\d+\)/);
    await expect(rows.first().getByTestId("comparison-divergence")).toContainText("diverges");
    await rows.first().getByTestId("comparison-link").click();
    await expect(page.getByTestId("comparison-view")).toBeVisible();
    await expect(page).toHaveURL(/compare\?comparison=cmp_/);
  });

  test("two traces can be compared from the explorer", async ({ page }) => {
    await page.goto("/");
    const rows = page.locator('[data-testid="trace-row"]');
    await expect(rows.first()).toBeVisible();
    await expect(page.getByTestId("compare-bar")).toHaveCount(0);
    await rows.nth(0).getByTestId("trace-select").check();
    await expect(page.getByTestId("compare-selected")).toBeDisabled();
    await rows.nth(1).getByTestId("trace-select").check();
    await expect(rows.nth(2).getByTestId("trace-select")).toBeDisabled();
    const baseId = await rows.nth(0).getAttribute("data-trace-id");
    const targetId = await rows.nth(1).getAttribute("data-trace-id");
    await page.getByTestId("compare-selected").click();
    await expect(page.getByTestId("comparison-view")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/traces/${baseId}/compare`));
    await expect(page.getByTestId("cross-trace-badge")).toContainText(targetId ?? "");
    await expect(page.getByTestId("target-branch-name")).toHaveAttribute(
      "href",
      new RegExp(`/traces/${targetId}\\?branch=`),
    );
    await expect(page.getByTestId("comparison-metrics")).toBeVisible();
  });

  test("a scenario matrix replays one step with several values", async ({ page }) => {
    await openRefundTrace(page);
    await page
      .locator(
        '[data-testid="event-node"][data-event-type="tool.request"][data-event-name="refund_order"]',
      )
      .click();
    await page.getByTestId("open-matrix").click();
    const dialog = page.getByTestId("matrix-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("run-matrix")).toBeDisabled();
    // a tool event defaults to varying its result; switch to a context value
    await expect(dialog.getByTestId("matrix-axis")).toHaveValue("tool_result");
    await expect(dialog.getByTestId("matrix-key")).toHaveValue("refund_order");
    await dialog.getByTestId("matrix-axis").selectOption("context");
    await dialog.getByTestId("matrix-key").fill("refundLimit");
    await expect(dialog).toContainText("Current value: 500");
    await dialog.getByTestId("matrix-values").fill("100, 500");
    await expect(dialog.getByTestId("run-matrix")).toHaveText(/Run 2 variants/);
    await dialog.getByTestId("run-matrix").click();
    const rows = dialog.locator('[data-testid="matrix-row"]');
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await expect(rows.nth(0)).toContainText("refundLimit=100");
    await expect(rows.nth(0)).toContainText("Approval");
    await expect(rows.nth(0)).toContainText("changed");
    await expect(rows.nth(1)).toContainText("identical");
    await rows.nth(0).getByRole("link", { name: "Compare" }).click();
    await expect(page.getByTestId("comparison-view")).toBeVisible();
    await expect(page.getByTestId("target-branch-name")).toHaveText("refundLimit=100");
  });

  test("a scenario matrix can vary a policy configuration", async ({ page }) => {
    await openRefundTrace(page);
    await page
      .locator(
        '[data-testid="event-node"][data-event-type="tool.request"][data-event-name="refund_order"]',
      )
      .click();
    await page.getByTestId("open-matrix").click();
    const dialog = page.getByTestId("matrix-dialog");
    await dialog.getByTestId("matrix-axis").selectOption("policy");
    await dialog.getByTestId("matrix-key").fill("refund.autonomous_limit");
    await dialog.getByTestId("matrix-values").fill("100");
    await expect(dialog.getByTestId("matrix-problem")).toHaveText(
      "policy configurations must be JSON objects",
    );
    await expect(dialog.getByTestId("run-matrix")).toBeDisabled();
    await dialog.getByTestId("matrix-values").fill('{"limit": 100}\n{"limit": 1000}');
    await expect(dialog.getByTestId("matrix-problem")).toHaveCount(0);
    await expect(dialog.getByTestId("run-matrix")).toHaveText(/Run 2 variants/);
    await dialog.getByTestId("run-matrix").click();
    const rows = dialog.locator('[data-testid="matrix-row"]');
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await expect(rows.nth(0)).toContainText('refund.autonomous_limit={"limit":100}');
    await expect(rows.nth(0)).toContainText("Approval");
    await expect(rows.nth(0)).toContainText("changed");
    await expect(rows.nth(1)).toContainText("same");
  });

  test("keyboard shortcuts are listed and the note box can be focused", async ({ page }) => {
    await openRefundTrace(page);
    await page.keyboard.press("?");
    const dialog = page.getByTestId("shortcuts-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Fork from the selected event");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await page.getByTestId("show-shortcuts").click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    await page
      .locator(
        '[data-testid="event-node"][data-event-type="tool.request"][data-event-name="refund_order"]',
      )
      .click();
    await page.keyboard.press("n");
    await expect(page.getByTestId("note-input")).toBeFocused();
    // Shortcuts stay inert while typing.
    await page.keyboard.type("j k ?");
    await expect(page.getByTestId("note-input")).toHaveValue("j k ?");
    await expect(page.getByTestId("shortcuts-dialog")).not.toBeVisible();
    await expect(page.getByTestId("event-name")).toHaveText("refund_order");
  });

  test("notes can be attached to an event", async ({ page }) => {
    await openRefundTrace(page);
    const node = page.locator(
      '[data-testid="event-node"][data-event-type="tool.request"][data-event-name="refund_order"]',
    );
    await node.click();
    await expect(page.getByTestId("event-name")).toHaveText("refund_order");
    await expect(page.getByTestId("note-submit")).toBeDisabled();
    await page.getByTestId("note-input").fill("Limit came from a stale policy document.");
    await page.getByTestId("note-submit").click();
    const notes = page.locator('[data-testid="event-note"]');
    await expect(notes.first()).toContainText("stale policy document");
    await expect(page.getByTestId("note-input")).toHaveValue("");
    const before = await notes.count();

    await page.getByTestId("note-input").fill("Second note via keyboard");
    await page.getByTestId("note-input").press("Control+Enter");
    await expect(notes).toHaveCount(before + 1);

    await page.reload();
    await node.click();
    await expect(page.locator('[data-testid="event-note"]')).toHaveCount(before + 1);
  });

  test("the agents page summarises traces per agent", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-agents").click();
    await expect(page).toHaveURL(/\/agents/);
    const rows = page.locator('[data-testid="agent-row"]');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(3);
    const refund = page.locator('[data-testid="agent-row"][data-agent-slug="refund-agent"]');
    await expect(refund).toBeVisible();
    await expect(refund.getByTestId("agent-policy-violations")).not.toHaveText("0");
    await page.getByTestId("agent-range").selectOption("24h");
    await expect(page).toHaveURL(/range=24h/);
    await expect(page.getByTestId("agent-stats")).toContainText("No traces in this range");
    await page.getByTestId("agent-range").selectOption("all");
    await expect(refund).toBeVisible();
    await refund.getByTestId("agent-link").click();
    await expect(page).toHaveURL(/agent=refund-agent/);
    await expect(page.locator('[data-testid="trace-row"]').first()).toBeVisible();
    for (const text of await page.locator('[data-testid="trace-row"]').allInnerTexts()) {
      expect(text).toContain("Refund Agent");
    }
  });

  test("a what-if runs across an agent's recorded traces", async ({ page }) => {
    await page.goto("/agents");
    const refund = page.locator('[data-testid="agent-row"][data-agent-slug="refund-agent"]');
    await expect(refund).toBeVisible();
    await refund.getByTestId("what-if").click();
    const dialog = page.getByTestId("batch-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("run-batch")).toBeDisabled();
    await dialog.getByTestId("batch-tool").fill("refund_order");
    await dialog.getByTestId("batch-key").fill("refundLimit");
    await dialog.getByTestId("batch-value").fill("100");
    await dialog.getByTestId("run-batch").click();
    await expect(dialog.getByTestId("batch-summary")).toContainText("changed", { timeout: 60_000 });
    const rows = dialog.locator('[data-testid="batch-row"]');
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
    await expect(dialog.getByTestId("batch-results")).toContainText("Approval");
    await rows
      .filter({ hasText: "changed" })
      .first()
      .getByRole("link", { name: "Compare" })
      .click();
    await expect(page.getByTestId("comparison-view")).toBeVisible();
  });

  test("explorer filters can be saved as named views", async ({ page }) => {
    await page.goto("/?status=failed&sort=totalEstimatedCost&order=desc");
    await expect(page.locator('[data-testid="trace-row"]').first()).toBeVisible();
    await expect(page.getByTestId("saved-view-select")).toHaveCount(0);
    await page.getByTestId("save-view").click();
    await page.getByTestId("view-name").fill("costly failures");
    await page.getByTestId("confirm-save-view").click();
    await expect(page.getByTestId("saved-view-select")).toHaveValue("costly failures");

    await page.goto("/");
    await expect(page.getByTestId("saved-view-select")).toHaveValue("");
    await page.getByTestId("saved-view-select").selectOption("costly failures");
    await expect(page).toHaveURL(/status=failed/);
    await expect(page).toHaveURL(/sort=totalEstimatedCost/);
    for (const text of await page.locator('[data-testid="trace-row"]').allInnerTexts()) {
      expect(text).toContain("failed");
    }

    await page.reload();
    await expect(page.getByTestId("saved-view-select")).toHaveValue("costly failures");
    await page.getByTestId("delete-view").click();
    await expect(page.getByTestId("saved-view-select")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("saved-view-select")).toHaveCount(0);
  });

  test("explorer filters and keyboard navigation", async ({ page }) => {
    await page.goto("/?status=failed");
    await expect(page.locator('[data-testid="trace-row"]')).toHaveCount(1);
    await page.goto("/?q=cus_1001");
    await expect(page.locator('[data-testid="trace-row"]')).toHaveCount(1);
    await page.goto("/?tool=inventory.lookup");
    await expect(page.locator('[data-testid="trace-row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="trace-row"]').first()).toContainText("reserve-stock");

    await openRefundTrace(page);
    // Default selection is the first error; "e" and "p" jump, j/k move.
    await page.keyboard.press("p");
    await expect(page.getByTestId("event-name")).toHaveText("compliance.refund_limit");
    await page.keyboard.press("j");
    await expect(page.getByTestId("event-name")).toHaveText("compliance.refund_limit");
    await expect(page.locator('[data-testid="event-node"][aria-selected="true"]')).toHaveAttribute(
      "data-event-type",
      "policy.denied",
    );
    await expect(page.getByTestId("timeline")).toBeVisible();
  });
});
