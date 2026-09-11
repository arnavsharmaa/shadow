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
