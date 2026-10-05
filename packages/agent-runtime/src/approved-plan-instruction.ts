import { isPlanDesignEmpty, type PlanExecution, type PlanStep } from "@pi-desktop/shared";

/**
 * First line of every plan-kind execution instruction. `plan-continuity.ts`
 * recognizes a stored instruction by this exact line instead of parsing
 * prose, so it must stay byte-identical with the line pushed below.
 */
export const APPROVED_PLAN_INSTRUCTION_MARKER =
  "Execute the approved implementation plan now.";

function escapedJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * Escape user-authored text the same way the structured JSON is escaped, so a
 * title or detail can never break out of its enclosing tag.
 */
function escapedText(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * The approved steps as a readable ordered list. `after:` names the step ids a
 * step comes after; it is guidance for the model, not an enforced ordering.
 * Details keep their newlines, indented to align under the step.
 */
function approvedStepsLines(steps: PlanStep[]): string[] {
  const lines: string[] = [];
  steps.forEach((step, index) => {
    lines.push(`${index + 1}. [${step.id}] ${escapedText(step.title)}`);
    lines.push(
      `   after: ${step.dependsOn.length > 0 ? step.dependsOn.join(", ") : "(none)"}`,
    );
    if (step.detail) {
      lines.push(
        `   detail: ${escapedText(step.detail).replaceAll("\n", "\n   ")}`,
      );
    }
  });
  return lines;
}

export function approvedPlanInstruction(execution: PlanExecution): string {
  if (execution.kind === "goal") {
    return [
      "The user approved the goal contract below. Reach that goal now, autonomously.",
      `Use the host-created goal artifact at the workspace-relative path: ${execution.artifact.relativePath}`,
      `Approved goal title: ${execution.title}`,
      `Approval question: ${execution.question}`,
      "Treat the following Markdown as the exact approved contract. Do not renegotiate it, replace it with a new contract, or ask for approval again.",
      "<approved-goal-markdown>",
      execution.plan,
      "</approved-goal-markdown>",
      "Choose your own approach with the normal Agent tools. Then verify every acceptance criterion yourself, running the checks the contract names rather than assuming they pass.",
      "Keep working while a criterion is still unmet and you have an untried approach. Stop early only if a boundary in the contract blocks you or a criterion cannot be verified; say which one and why.",
      "Finish with a report that walks the acceptance criteria one by one, each marked met or unmet with the evidence you observed.",
    ].join("\n");
  }
  const lines = [
    APPROVED_PLAN_INSTRUCTION_MARKER,
    `Use the host-created plan artifact at the workspace-relative path: ${execution.artifact.relativePath}`,
    `Approved plan title: ${execution.title}`,
    `Approval question: ${execution.question}`,
    "Treat the following Markdown as the exact approved snapshot. Do not replace it with a new plan or ask for approval again.",
    "<approved-plan-markdown>",
    execution.plan,
    "</approved-plan-markdown>",
  ];
  const steps = execution.steps?.length ? execution.steps : undefined;
  const design = execution.design && !isPlanDesignEmpty(execution.design) ? execution.design : undefined;
  if (steps || design) {
    lines.push("The user reviewed the plan and approved the structured revision below. It takes precedence over any Steps or Design section mirrored in the Markdown above.");
  }
  if (steps) {
    lines.push(
      "<approved-steps>",
      ...approvedStepsLines(steps),
      "</approved-steps>",
      "Each step lists the step ids it comes after. Respect that order; it is guidance for you, the host does not enforce it. Keep every checklist item's stepId when you update it with TodoWrite, and mark items completed only after verifying them.",
    );
  }
  if (design) {
    lines.push(
      "<design-constraints>",
      escapedJson(design),
      "</design-constraints>",
      "Apply these design constraints to all user-interface work: style keywords, typography, colors, framework and component library.",
    );
  }
  lines.push("Implement the approved plan with the normal Agent tools, then report the result.");
  return lines.join("\n");
}
