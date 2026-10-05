import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PlanExecution } from "@pi-desktop/shared";
import { approvedPlanInstruction } from "./approved-plan-instruction.js";
import { PLAN_CONTINUITY_MAX_CHARS, planContinuityNote } from "./plan-continuity.js";

const execution: PlanExecution = {
  id: "execution-1",
  proposalId: "proposal-1",
  sessionId: "session-1",
  kind: "plan",
  title: "Ship interactive plans",
  question: "Proceed?",
  plan: "# Plan\n\nDo the thing.\n",
  artifact: { relativePath: ".pi/plan/proposal-1.md", sha256: "hash", sizeBytes: 36 },
  targetPermissionMode: "ask",
  state: "running",
  steps: [
    { id: "s1", title: "Wire the model", dependsOn: [] },
    { id: "s2", title: "Route the session", dependsOn: ["s1"] },
    { id: "s3", title: "Verify end to end", dependsOn: ["s1", "s2"] },
  ],
};

const instruction = approvedPlanInstruction(execution);

function userMessage(text: string, timestamp = 1): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as unknown as AgentMessage;
}

function todoWriteMessage(todos: unknown[], id = "todo-1", timestamp = 2): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "TodoWrite", arguments: { todos } }],
    timestamp,
  } as unknown as AgentMessage;
}

const todos = [
  { content: "Wire the model", status: "completed", stepId: "s1" },
  { content: "Route the session", status: "in_progress", stepId: "s2" },
  { content: "Verify end to end", status: "pending", stepId: "s3" },
];

describe("planContinuityNote", () => {
  it("returns undefined when no approved-plan instruction is in range", () => {
    expect(planContinuityNote([], [])).toBeUndefined();
    expect(planContinuityNote([userMessage("just a regular task")], [])).toBeUndefined();
    // A goal execution has no approved-plan marker: no note either.
    const goal = approvedPlanInstruction({ ...execution, kind: "goal", steps: undefined });
    expect(planContinuityNote([userMessage(goal)], [])).toBeUndefined();
  });

  it("repeats the plan contract and reports the seeded checklist before any update", () => {
    const note = planContinuityNote([userMessage(instruction)], []);
    expect(note).toContain("<approved-plan-continuity>");
    expect(note).toContain("Approved plan title: Ship interactive plans");
    expect(note).toContain(
      "Use the host-created plan artifact at the workspace-relative path: .pi/plan/proposal-1.md",
    );
    // The steps block is carried verbatim.
    expect(note).toContain("1. [s1] Wire the model\n   after: (none)");
    expect(note).toContain("3. [s3] Verify end to end\n   after: s1, s2");
    expect(note).toContain(
      "Current checklist state: seeded from the approved steps; no updates yet",
    );
    // Deterministic: the same range produces the same note.
    expect(planContinuityNote([userMessage(instruction)], [])).toBe(note);
  });

  it("carries the most recent TodoWrite checklist with step ids", () => {
    const stale = todoWriteMessage([{ content: "stale draft", status: "pending" }], "todo-0");
    const latest = todoWriteMessage(todos, "todo-1", 3);
    const note = planContinuityNote([userMessage(instruction), stale, latest], []);
    expect(note).toContain("Current checklist state:\n");
    expect(note).toContain("- [completed] (s1) Wire the model");
    expect(note).toContain("- [in_progress] (s2) Route the session");
    expect(note).toContain("- [pending] (s3) Verify end to end");
    expect(note).not.toContain("stale draft");
  });

  it("renders checklist items without a step id plainly", () => {
    const note = planContinuityNote(
      [userMessage(instruction), todoWriteMessage([{ content: "Ad-hoc follow-up", status: "pending" }])],
      [],
    );
    expect(note).toContain("- [pending] Ad-hoc follow-up");
  });

  it("omits the steps and design blocks when the retained tail carries the instruction untruncated", () => {
    const messages = [userMessage(instruction), todoWriteMessage(todos)];
    const note = planContinuityNote(messages, [userMessage(instruction)]);
    expect(note).toBeDefined();
    expect(note).not.toContain("<approved-steps>");
    // The checklist state is still included.
    expect(note).toContain("- [completed] (s1) Wire the model");
  });

  it("keeps the steps block when the retained instruction was truncated", () => {
    const truncated = userMessage(`${instruction.slice(0, 120)}\n[checkpoint truncated]`);
    const note = planContinuityNote([userMessage(instruction)], [truncated]);
    expect(note).toContain("<approved-steps>");
  });

  it("sheds checklist items first when the note exceeds the bound", () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      content: `Item ${index}: ${"detail ".repeat(30)}`,
      status: "pending",
      stepId: `s${index}`,
    }));
    const note = planContinuityNote(
      [userMessage(instruction), todoWriteMessage(many)],
      [],
    );
    expect(note).toBeDefined();
    expect(note!.length).toBeLessThanOrEqual(PLAN_CONTINUITY_MAX_CHARS);
    expect(note).toContain("earlier checklist items omitted");
    expect(note).toContain("</approved-plan-continuity>");
  });

  it("hard-truncates a note that cannot fit even without checklist items", () => {
    const huge: PlanExecution = {
      ...execution,
      steps: [{ id: "s1", title: "big", detail: "x".repeat(12_000), dependsOn: [] }],
    };
    const note = planContinuityNote(
      [userMessage(approvedPlanInstruction(huge))],
      [],
    );
    expect(note).toBeDefined();
    expect(note!.length).toBeLessThanOrEqual(PLAN_CONTINUITY_MAX_CHARS);
    expect(note).toContain("[plan continuity truncated]");
  });
});
