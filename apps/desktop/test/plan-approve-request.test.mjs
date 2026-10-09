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
  assert.ok(!("revisedMarkdown" in designOnly));
  const rewritten = planDraftReducer(draft, { type: "markdownSet", value: "# Rewritten\n" });
  assert.equal(buildApproveRequest(base, "ask", planDraftRevision(rewritten)).revisedMarkdown, "# Rewritten\n");
});

test("approve request never carries a revision for goal proposals or remote sessions", () => {
  const revision = { revisedSteps: [{ id: "x", title: "X", dependsOn: [] }], revisedMarkdown: "# X\n" };
  const goalRequest = buildApproveRequest(goal, "ask", revision);
  assert.ok(!("revisedSteps" in goalRequest));
  assert.ok(!("revisedMarkdown" in goalRequest));
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

const { planExecutionModelOptions, planTargetModel } = await import("../src/features/plan/plan-execution-model.ts");
const { readPlanExecutionModel, rememberPlanExecutionModel } = await import("../src/lib/plan-approval-preferences.ts");

test("approve request carries the chosen execution model for plans and goals", () => {
  const fast = { providerId: "fast", modelId: "flash" };
  assert.deepEqual(buildApproveRequest(base, "ask", undefined, fast).targetModel, fast);
  assert.deepEqual(buildApproveRequest(goal, "ask", undefined, fast).targetModel, fast);
  assert.ok(!("targetModel" in buildApproveRequest(base, "ask")));
});

test("execution model options follow composer availability and skip the session model", () => {
  const provider = (id, extra) => ({ id, name: id, enabled: true, hasSecret: true, authKind: "api-key",
    models: [{ id: `${id}-m` }], ...extra });
  const options = planExecutionModelOptions([
    provider("fast"), provider("off", { enabled: false }), provider("nokey", { hasSecret: false }),
  ]);
  assert.deepEqual(options.map(({ providerId, modelId }) => `${providerId}/${modelId}`), ["fast/fast-m"]);
  const fast = { providerId: "fast", modelId: "fast-m" };
  assert.deepEqual(planTargetModel(fast, options, { providerId: "slow", modelId: "big" }), fast);
  assert.equal(planTargetModel(fast, options, fast), undefined);
  assert.equal(planTargetModel({ providerId: "gone", modelId: "x" }, options, undefined), undefined);
  assert.equal(planTargetModel(null, options, undefined), undefined);
});

test("execution model preference round-trips and ignores malformed storage", () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  try {
    assert.equal(readPlanExecutionModel(), null);
    rememberPlanExecutionModel({ providerId: "fast", modelId: "flash" });
    assert.deepEqual(readPlanExecutionModel(), { providerId: "fast", modelId: "flash" });
    rememberPlanExecutionModel(null);
    assert.equal(readPlanExecutionModel(), null);
    values.set("pi.desktop.planExecutionModel", "{broken");
    assert.equal(readPlanExecutionModel(), null);
  } finally {
    delete globalThis.localStorage;
  }
});
