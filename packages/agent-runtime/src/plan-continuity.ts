import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isRecord } from "./agent-messages.js";
import { APPROVED_PLAN_INSTRUCTION_MARKER } from "./approved-plan-instruction.js";

/**
 * Upper bound for the continuity note appended to a checkpoint summary. An
 * oversized note sheds checklist items (oldest first), then is truncated.
 */
export const PLAN_CONTINUITY_MAX_CHARS = 8_000;

const CONTINUITY_TAG = "approved-plan-continuity";
const HARD_TRUNCATION_MARKER = "[plan continuity truncated]";

type ChecklistItem = { content: string; status: string; stepId?: string };

function messageText(message: AgentMessage): string | undefined {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [],
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function latestApprovedPlanInstruction(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text?.startsWith(APPROVED_PLAN_INSTRUCTION_MARKER)) return text;
  }
  return undefined;
}

function extractTaggedBlock(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  const end = start === -1 ? -1 : text.indexOf(close, start + open.length);
  return end === -1 ? undefined : text.slice(start, end + close.length);
}

function extractLine(text: string, prefix: string): string | undefined {
  const offset = text.indexOf(`\n${prefix}`);
  const head = text.startsWith(prefix) ? 0 : offset === -1 ? -1 : offset + 1;
  if (head === -1) return undefined;
  const end = text.indexOf("\n", head);
  return text.slice(head, end === -1 ? text.length : end);
}

function latestChecklist(messages: AgentMessage[]): ChecklistItem[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex];
      if (!isRecord(block) || block.type !== "toolCall" || block.name !== "TodoWrite") {
        continue;
      }
      const args = block.arguments;
      if (!isRecord(args) || !Array.isArray(args.todos)) return undefined;
      return args.todos.flatMap((todo): ChecklistItem[] => {
        if (!isRecord(todo) || typeof todo.content !== "string" || todo.content === "") {
          return [];
        }
        return [
          {
            content: todo.content,
            status: typeof todo.status === "string" ? todo.status : "pending",
            ...(typeof todo.stepId === "string" && todo.stepId
              ? { stepId: todo.stepId }
              : {}),
          },
        ];
      });
    }
  }
  return undefined;
}

function assembleNote(
  header: string[],
  items: ChecklistItem[] | undefined,
  omitted: number,
  seeded: boolean,
): string {
  const lines = [`<${CONTINUITY_TAG}>`, ...header];
  if (items === undefined) {
    lines.push(
      seeded
        ? "Current checklist state: seeded from the approved steps; no updates yet"
        : "Current checklist state: no TodoWrite updates recorded yet",
    );
  } else {
    lines.push("Current checklist state:");
    if (omitted > 0) lines.push(`- (${omitted} earlier checklist items omitted)`);
    for (const item of items) {
      lines.push(`- [${item.status}]${item.stepId ? ` (${item.stepId})` : ""} ${item.content}`);
    }
  }
  lines.push(`</${CONTINUITY_TAG}>`);
  return lines.join("\n");
}

/**
 * Deterministic continuity block for checkpoint summaries of an approved-plan
 * execution. Returns undefined when no approved-plan instruction is in range,
 * leaving summaries byte-identical for every other conversation.
 */
export function planContinuityNote(
  messages: AgentMessage[],
  retained: AgentMessage[],
): string | undefined {
  const instruction = latestApprovedPlanInstruction(messages);
  if (!instruction) return undefined;
  const header = [
    "This session is executing an approved implementation plan. The original instruction may have been compacted away; its contract is repeated here.",
  ];
  for (const prefix of [
    "Approved plan title:",
    "Use the host-created plan artifact at the workspace-relative path:",
  ]) {
    const line = extractLine(instruction, prefix);
    if (line) header.push(line);
  }
  // When the retained tail already carries the instruction untruncated, the
  // blocks would only duplicate it; the checklist state is still worth keeping.
  const alreadyRetained = retained.some((message) => messageText(message) === instruction);
  const steps = alreadyRetained ? undefined : extractTaggedBlock(instruction, "approved-steps");
  const design = alreadyRetained ? undefined : extractTaggedBlock(instruction, "design-constraints");
  if (steps) header.push(steps);
  if (design) header.push(design);
  let items = latestChecklist(messages);
  let omitted = 0;
  let note = assembleNote(header, items, omitted, steps !== undefined);
  while (note.length > PLAN_CONTINUITY_MAX_CHARS && items !== undefined && items.length > 0) {
    omitted += 1;
    items = items.slice(1);
    note = assembleNote(header, items, omitted, steps !== undefined);
  }
  if (note.length > PLAN_CONTINUITY_MAX_CHARS) {
    const suffix = `\n${HARD_TRUNCATION_MARKER}\n</${CONTINUITY_TAG}>`;
    note = note.slice(0, PLAN_CONTINUITY_MAX_CHARS - suffix.length) + suffix;
  }
  return note;
}
