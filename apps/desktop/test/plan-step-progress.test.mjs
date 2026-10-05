import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { planStepProgress } = await import("../src/features/plan/plan-step-progress.ts");

const step = (id, title = id) => ({ id, title, dependsOn: [] });
const todo = (content, status, stepId) => ({
  content, status, priority: "medium", ...(stepId ? { stepId } : {}),
});

test("stepId matches win over titles and drive the per-step status", () => {
  const steps = [step("a", "Prepare"), step("b", "Build"), step("c", "Ship")];
  const todos = [
    todo("Unrelated", "completed"),
    todo("Build", "completed", "b"),
    todo("Ship", "in_progress", "c"),
  ];
  const progress = planStepProgress(steps, todos);
  assert.deepEqual(progress.steps, [
    { stepId: "a", status: "unknown" },
    { stepId: "b", status: "completed" },
    { stepId: "c", status: "in_progress" },
  ]);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
});

test("todos without stepId fall back to exact trimmed title matches", () => {
  const steps = [step("a", "Prepare"), step("b", "Build")];
  const todos = [todo("  Prepare  ", "completed"), todo("build", "pending")];
  const progress = planStepProgress(steps, todos);
  assert.deepEqual(progress.steps, [
    { stepId: "a", status: "completed" },
    { stepId: "b", status: "unknown" },
  ]);
});

test("every todo is used at most once, even for duplicated titles", () => {
  const steps = [step("a", "Same"), step("b", "Same")];
  const progress = planStepProgress(steps, [todo("Same", "completed")]);
  assert.deepEqual(progress.steps, [
    { stepId: "a", status: "completed" },
    { stepId: "b", status: "unknown" },
  ]);
  // A stepId-carrying todo never falls back to a title match.
  const claimed = planStepProgress([step("a", "Same"), step("b", "Other")], [
    todo("Other", "cancelled", "a"),
  ]);
  assert.deepEqual(claimed.steps, [
    { stepId: "a", status: "cancelled" },
    { stepId: "b", status: "unknown" },
  ]);
});

test("no todos yet means every step is unknown and nothing is done", () => {
  const progress = planStepProgress([step("a"), step("b")], []);
  assert.deepEqual(progress, {
    steps: [{ stepId: "a", status: "unknown" }, { stepId: "b", status: "unknown" }],
    done: 0,
    total: 2,
  });
  assert.equal(planStepProgress([], [todo("x", "completed")]).total, 0);
});
