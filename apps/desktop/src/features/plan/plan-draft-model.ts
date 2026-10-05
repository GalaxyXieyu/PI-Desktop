import {
  PLAN_FONT_FAMILY_PRESETS,
  planDesignEqual,
  planStepsEqual,
  planStepWouldCreateCycle,
  validatePlanDesign,
  validatePlanSteps,
  type GlobalPermissionMode,
  type PlanColorGroup,
  type PlanDesignSpec,
  type PlanProposal,
  type PlanResolveRequest,
  type PlanStep,
} from "@pi-desktop/shared";

export type PlanDraft = {
  key: string;
  baseSteps: PlanStep[];
  baseDesign?: PlanDesignSpec;
  steps: PlanStep[];
  design?: PlanDesignSpec;
  editingStepId?: string;
};

type FontLevel = "heading" | "subheading" | "body";
export type PlanDraftAction =
  | { type: "stepAdd"; id: string }
  | { type: "stepUpdate"; id: string; title?: string; detail?: string }
  | { type: "stepRemove"; id: string }
  | { type: "stepSetDependsOn"; id: string; dependsOn: string[] }
  | { type: "stepMove"; id: string; direction: "up" | "down" }
  | { type: "designAddKeyword"; value: string }
  | { type: "designRemoveKeyword"; index: number }
  | { type: "designSetFontFamily"; value: string }
  | { type: "designSetFontLevel"; level: FontLevel; size?: string; weight?: number }
  | { type: "designSetColor"; group: PlanColorGroup; index: number; value: string }
  | { type: "designAddColor"; group: PlanColorGroup }
  | { type: "designRemoveColor"; group: PlanColorGroup; index: number }
  | { type: "designSetFramework"; value: string | undefined }
  | { type: "designSetComponentLibrary"; value: string | undefined }
  | { type: "reset" };

export function planDraftKey(proposal: Pick<PlanProposal, "sessionId" | "id" | "version">): string {
  return `${proposal.sessionId}:${proposal.id}:${proposal.version}`;
}

export function createPlanDraft(proposal: PlanProposal): PlanDraft {
  return {
    key: planDraftKey(proposal),
    baseSteps: structuredClone(proposal.steps ?? []),
    baseDesign: structuredClone(proposal.design),
    steps: structuredClone(proposal.steps ?? []),
    design: structuredClone(proposal.design),
  };
}

export function planDraftReducer(draft: PlanDraft, action: PlanDraftAction): PlanDraft {
  switch (action.type) {
    case "reset":
      return { ...draft, steps: structuredClone(draft.baseSteps), design: structuredClone(draft.baseDesign), editingStepId: undefined };
    case "stepAdd":
      if (draft.steps.some((step) => step.id === action.id)) return draft;
      return { ...draft, steps: [...draft.steps, { id: action.id, title: "", dependsOn: [] }], editingStepId: action.id };
    case "stepUpdate":
      return { ...draft, steps: draft.steps.map((step) => step.id === action.id ? {
        ...step,
        ...(action.title !== undefined ? { title: action.title } : {}),
        ...(action.detail !== undefined ? { detail: action.detail } : {}),
      } : step) };
    case "stepRemove":
      return {
        ...draft,
        editingStepId: draft.editingStepId === action.id ? undefined : draft.editingStepId,
        steps: draft.steps.filter((step) => step.id !== action.id).map((step) => ({
          ...step, dependsOn: step.dependsOn.filter((id) => id !== action.id),
        })),
      };
    case "stepSetDependsOn": {
      const steps = draft.steps.map((step) => step.id === action.id ? { ...step, dependsOn: [] } : step);
      if (action.dependsOn.some((id) => planStepWouldCreateCycle(steps, action.id, id))) return draft;
      return { ...draft, steps: steps.map((step) => step.id === action.id ? { ...step, dependsOn: [...action.dependsOn] } : step) };
    }
    case "stepMove": {
      const index = draft.steps.findIndex((step) => step.id === action.id);
      const target = index + (action.direction === "up" ? -1 : 1);
      if (index < 0 || target < 0 || target >= draft.steps.length) return draft;
      const steps = [...draft.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...draft, steps };
    }
    default:
      return { ...draft, design: reduceDesign(draft.design ?? {}, action) };
  }
}

function reduceDesign(design: PlanDesignSpec, action: Exclude<PlanDraftAction, { type: `step${string}` | "reset" }>): PlanDesignSpec {
  switch (action.type) {
    case "designAddKeyword":
      return { ...design, styleKeywords: [...(design.styleKeywords ?? []), action.value] };
    case "designRemoveKeyword":
      return { ...design, styleKeywords: design.styleKeywords?.filter((_, index) => index !== action.index) };
    case "designSetFramework":
      return { ...design, framework: action.value };
    case "designSetComponentLibrary":
      return { ...design, componentLibrary: action.value };
    case "designSetFontFamily":
      return { ...design, fontSystem: { ...design.fontSystem, fontFamily: action.value } };
    case "designSetFontLevel": {
      const font = design.fontSystem ?? { fontFamily: PLAN_FONT_FAMILY_PRESETS[0].value };
      const previous = font[action.level] ?? { size: "16px", weight: 400 };
      return { ...design, fontSystem: { ...font, [action.level]: {
        size: action.size ?? previous.size, weight: action.weight ?? previous.weight,
      } } };
    }
    case "designSetColor":
    case "designAddColor":
    case "designRemoveColor": {
      const colors = design.colorSystem?.[action.group] ?? [];
      const next = action.type === "designAddColor" ? [...colors, "#000000"]
        : action.type === "designRemoveColor" ? colors.filter((_, index) => index !== action.index)
          : colors.map((color, index) => index === action.index ? action.value : color);
      return { ...design, colorSystem: { ...design.colorSystem, [action.group]: next } };
    }
  }
}

function normalizedDesign(design: PlanDesignSpec | undefined): PlanDesignSpec {
  const result = validatePlanDesign(design ?? {});
  return result.ok ? result.value : design ?? {};
}

function normalizedSteps(steps: PlanStep[]): PlanStep[] {
  const result = validatePlanSteps(steps);
  return result.ok ? result.value : steps;
}

export function planDraftValidation(draft: PlanDraft) {
  const steps = validatePlanSteps(draft.steps);
  if (!steps.ok) return steps;
  const design = validatePlanDesign(draft.design ?? {});
  return design.ok ? null : design;
}

export function planDraftRevision(draft: PlanDraft): { revisedSteps?: PlanStep[]; revisedDesign?: PlanDesignSpec } {
  const steps = normalizedSteps(draft.steps);
  const design = normalizedDesign(draft.design);
  return {
    ...(!planStepsEqual(steps, normalizedSteps(draft.baseSteps)) ? { revisedSteps: steps } : {}),
    ...(!planDesignEqual(design, normalizedDesign(draft.baseDesign)) ? { revisedDesign: design } : {}),
  };
}

export function planDraftDirty(draft: PlanDraft): boolean {
  return Object.keys(planDraftRevision(draft)).length > 0;
}

/** The changed parts of a draft, as carried by `plans.resolve` approve. */
export type PlanRevision = { revisedSteps?: PlanStep[]; revisedDesign?: PlanDesignSpec };

/**
 * Builds the approve half of a `plans.resolve` request. `revision` is the
 * output of `planDraftRevision` from the shared draft store; it is dropped
 * for Goal proposals and absent for remote sessions (structural edits are
 * local-only), so those requests stay byte-identical to a legacy approve.
 */
export function buildApproveRequest(
  proposal: PlanProposal,
  mode: GlobalPermissionMode,
  revision?: PlanRevision,
): PlanResolveRequest {
  return {
    proposalId: proposal.id,
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    toolCallId: proposal.toolCallId,
    version: proposal.version,
    action: "approve",
    targetPermissionMode: mode,
    ...(proposal.kind === "plan" ? revision : undefined),
  };
}

/** What a key press in a step title input should do; the row wires the DOM. */
export type PlanStepEditKeyAction = "save" | "cancel" | "remove" | null;

/**
 * Keyboard contract for the step title input: Enter commits, Escape discards,
 * and Backspace on an already-empty title removes the row.
 */
export function planStepEditKeyAction(key: string, title: string): PlanStepEditKeyAction {
  if (key === "Enter") return "save";
  if (key === "Escape") return "cancel";
  if (key === "Backspace" && !title.trim()) return "remove";
  return null;
}
