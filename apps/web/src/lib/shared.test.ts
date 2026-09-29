import type { Branch, ShadowEvent } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import { branchEvents } from "./shared";

const branch = (id: string, parent: string | null, forkSequence: number | null) =>
  ({ id, parentBranchId: parent, forkSequence }) as Branch;
const event = (branchId: string, sequence: number) =>
  ({ id: `${branchId}_${sequence}`, branchId, sequence }) as ShadowEvent;

describe("branchEvents", () => {
  const bundle = {
    branches: [branch("main", null, null), branch("fork", "main", 2), branch("deep", "fork", 3)],
    events: [
      ...[0, 1, 2, 3, 4].map((s) => event("main", s)),
      ...[3, 4, 5].map((s) => event("fork", s)),
      ...[4].map((s) => event("deep", s)),
    ],
  };

  it("returns the root branch's own events", () => {
    expect(branchEvents(bundle, "main").map((e) => e.id)).toEqual([
      "main_0",
      "main_1",
      "main_2",
      "main_3",
      "main_4",
    ]);
  });

  it("inherits ancestors' events up to each fork point", () => {
    expect(branchEvents(bundle, "fork").map((e) => e.id)).toEqual([
      "main_0",
      "main_1",
      "main_2",
      "fork_3",
      "fork_4",
      "fork_5",
    ]);
    expect(branchEvents(bundle, "deep").map((e) => e.id)).toEqual([
      "main_0",
      "main_1",
      "main_2",
      "fork_3",
      "deep_4",
    ]);
  });

  it("returns nothing for an unknown branch", () => {
    expect(branchEvents(bundle, "nope")).toEqual([]);
  });
});
