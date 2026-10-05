import type { PlanStep, SessionTodo, TodoStatus } from "@pi-desktop/shared";

/**
 * Per-step execution status of an approved plan, derived from the session
 * checklist. `unknown` means no checklist item matched the step yet; the UI
 * renders it as pending.
 */
export type PlanStepProgressStatus = TodoStatus | "unknown";

export type PlanStepProgress = {
  stepId: string;
  status: PlanStepProgressStatus;
};

export type PlanProgress = {
  steps: PlanStepProgress[];
  done: number;
  total: number;
};

/**
 * Matches effective plan steps against session todos. Todos carrying a
 * `stepId` claim their step first; todos without one fall back to an exact
 * trimmed title === content match. Every todo is used at most once, so a
 * duplicated title cannot mark two steps with a single item.
 */
export function planStepProgress(
  steps: readonly PlanStep[],
  todos: readonly SessionTodo[],
): PlanProgress {
  const used = new Array<boolean>(todos.length).fill(false);
  const matched = new Array<number | undefined>(steps.length).fill(undefined);
  const byStepId = new Map<string, number>();
  todos.forEach((todo, index) => {
    if (todo.stepId && !byStepId.has(todo.stepId)) byStepId.set(todo.stepId, index);
  });
  steps.forEach((step, index) => {
    const todoIndex = byStepId.get(step.id);
    if (todoIndex !== undefined && !used[todoIndex]) {
      used[todoIndex] = true;
      matched[index] = todoIndex;
    }
  });
  steps.forEach((step, index) => {
    if (matched[index] !== undefined) return;
    const title = step.title.trim();
    const todoIndex = todos.findIndex(
      (todo, candidate) =>
        !used[candidate] && !todo.stepId && todo.content.trim() === title,
    );
    if (todoIndex >= 0) {
      used[todoIndex] = true;
      matched[index] = todoIndex;
    }
  });
  const result = steps.map((step, index): PlanStepProgress => {
    const todoIndex = matched[index];
    return {
      stepId: step.id,
      status: todoIndex === undefined ? "unknown" : todos[todoIndex].status,
    };
  });
  return {
    steps: result,
    done: result.filter((step) => step.status === "completed").length,
    total: steps.length,
  };
}
