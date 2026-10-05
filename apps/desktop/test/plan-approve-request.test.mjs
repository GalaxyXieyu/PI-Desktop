import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  buildApproveRequest,
  createPlanDraft,
  planDraftReducer,
  planDraftRevision,
  planStepEditKeyAction,
} = await import("../src/features/plan/plan-draft-model.ts");

const base = {
  id: "p", sessionId: "s", version: 3, kind: "plan", status: "pending",
  turnId: "turn", toolCallId: "tool",
  steps: [{ id: "a", title: "Prepare", dependsOn: [] }, { id: "b", title: "Implement", dependsOn: ["a"] }],
  design: { framework: "react" },
};
const goal = { ...base, kind: "goal", steps: undefined, design: undefined };

test("approve request carries revisedSteps only when the draft steps changed", () => {
  const draft = createPlanDraft(base);
  const unchanged = buildApproveRequest(base, "ask", planDraftRevision(draft));
  assert.equal(unchanged.action, "approve");
  assert.equal(unchanged.targetPermissionMode, "ask");
  assert.equal(unchanged.proposalId, "p");
  assert.equal(unchanged.sessionId, "s");
  assert.equal(unchanged.turnId, "turn");
  assert.equal(unchanged.toolCallId, "tool");
  assert.equal(unchanged.version, 3);
  assert.ok(!("revisedSteps" in unchanged));
  assert.ok(!("revisedDesign" in unchanged));
  const edited = planDraftReducer(draft, { type: "stepUpdate", id: "a", title: "Renamed" });
  const request = buildApproveRequest(base, "auto", planDraftRevision(edited));
  assert.deepEqual(request.revisedSteps.map((step) => step.title), ["Renamed", "Implement"]);
  assert.ok(!("revisedDesign" in request));
  const designed = planDraftReducer(draft, { type: "designSetFramework", value: "vue" });
  const designOnly = buildApproveRequest(base, "accept-edits", planDraftRevision(designed));
  assert.ok(!("revisedSteps" in designOnly));
  assert.deepEqual(designOnly.revisedDesign, { framework: "vue" });
});

test("approve request never carries a revision for goal proposals or remote sessions", () => {
  const revision = { revisedSteps: [{ id: "x", title: "X", dependsOn: [] }] };
  const goalRequest = buildApproveRequest(goal, "ask", revision);
  assert.ok(!("revisedSteps" in goalRequest));
  assert.ok(!("revisedDesign" in goalRequest));
  // Remote sessions pass no revision at all (structure editing is local-only).
  const remoteRequest = buildApproveRequest(base, "ask");
  assert.ok(!("revisedSteps" in remoteRequest));
  assert.ok(!("revisedDesign" in remoteRequest));
});

test("step title keyboard contract: Enter saves, Escape cancels, Backspace removes an empty row", () => {
  assert.equal(planStepEditKeyAction("Enter", "anything"), "save");
  assert.equal(planStepEditKeyAction("Enter", ""), "save");
  assert.equal(planStepEditKeyAction("Escape", "draft"), "cancel");
  assert.equal(planStepEditKeyAction("Backspace", ""), "remove");
  assert.equal(planStepEditKeyAction("Backspace", "   "), "remove");
  assert.equal(planStepEditKeyAction("Backspace", "x"), null);
  assert.equal(planStepEditKeyAction("Delete", ""), null);
  assert.equal(planStepEditKeyAction("a", ""), null);
});
