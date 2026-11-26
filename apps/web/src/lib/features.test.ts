import { describe, expect, it } from "vitest";
import { describeWebhook } from "./features";

describe("describeWebhook", () => {
  it("says off when there is no webhook", () => {
    expect(describeWebhook(undefined)).toBe("off");
    expect(describeWebhook({ enabled: false })).toBe("off");
  });

  it("names what is sent and in what shape, with the API's defaults", () => {
    expect(describeWebhook({ enabled: true })).toBe("failures as json");
    expect(describeWebhook({ enabled: true, events: "all", format: "slack" })).toBe("all as slack");
  });

  it("lists every restriction in the order the API applies them", () => {
    expect(
      describeWebhook({
        enabled: true,
        events: "all",
        format: "json",
        projects: ["support", "prod"],
        tags: ["canary", "eu"],
        outcomes: ["policy_violation", "escalated"],
        minCost: 0.5,
      }),
    ).toBe(
      "all as json for support, prod tagged canary or eu ending in policy_violation or escalated costing at least $0.5",
    );
    // Each one on its own, so none depends on another being set.
    expect(describeWebhook({ enabled: true, outcomes: ["none"] })).toBe(
      "failures as json ending in none",
    );
    expect(describeWebhook({ enabled: true, tags: ["prod"] })).toBe("failures as json tagged prod");
    expect(describeWebhook({ enabled: true, minCost: 0 })).toBe(
      "failures as json costing at least $0",
    );
  });
});
