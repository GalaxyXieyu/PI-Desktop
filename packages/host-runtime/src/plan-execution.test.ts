import { describe, expect, it } from "vitest";
import { executionFromResponse, executionListFromResponse, planExecutionFromUnknown } from "./plan-execution.js";

const legacy = {
  id: "e", proposalId: "p", sessionId: "s", kind: "plan", title: "Plan",
  plan: "# Plan", question: "Build?",
  artifact: { relativePath: ".pi/plan/p.md", sha256: "hash", sizeBytes: 6 },
  targetPermissionMode: "ask", state: "queued",
};

describe("approved plan execution decoding", () => {
  it("round-trips structured metadata through all response shapes", () => {
    const record = { ...legacy, steps: [{ id: "one", title: "One", dependsOn: [] }],
      design: { framework: "react", colorSystem: { primary: ["#AABBCC"] } } };
    expect(planExecutionFromUnknown(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(executionFromResponse({ execution: record })).toEqual(record);
    expect(executionListFromResponse({ executions: [record] })).toEqual([record]);
  });

  it("preserves legacy records without adding keys", () => {
    expect(planExecutionFromUnknown(legacy)).toEqual(legacy);
    for (const metadata of [{ steps: null, design: null }, { steps: [], design: {} },
      { steps: undefined, design: undefined }, { design: { framework: " " } }]) {
      expect(planExecutionFromUnknown({ ...legacy, ...metadata })).toEqual(legacy);
    }
  });

  it("normalizes valid fields", () => {
    expect(planExecutionFromUnknown({ ...legacy, steps: [{ id: " one ", title: " One ", detail: " " }],
      design: { framework: " REACT " } })).toEqual({ ...legacy,
      steps: [{ id: "one", title: "One", dependsOn: [] }], design: { framework: "react" } });
  });

  it.each([
    { steps: "invalid" }, { steps: [{ id: "one", title: "One", dependsOn: ["missing"] }] },
    { steps: [{ id: "one", title: "One", extra: true }] },
    { design: [] }, { design: { colorSystem: { text: ["red"] } } },
  ])("fails closed for malformed present metadata: %j", (metadata) => {
    const record = { ...legacy, ...metadata };
    expect(planExecutionFromUnknown(record)).toBeNull();
    expect(executionFromResponse({ execution: record })).toBeNull();
    expect(executionListFromResponse([record])).toEqual([]);
  });
});
