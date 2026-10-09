/** Shared public types grouped by the owning application domain. */
import { isPlanDesignEmpty, type PlanDesignSpec } from "../plan-design.js";
import type { PlanStep } from "../plan-steps.js";
import type { Mode } from "./common.js";
import type { GlobalPermissionMode } from "./permissions.js";

/** Approval-proposal discriminator (D198). Plan and Goal share one host
 * approval pipeline; `kind` selects prompts, artifact directory and copy. */
export type ProposalKind = "plan" | "goal";

export const PROPOSAL_KINDS = ["plan", "goal"] as const;

export function normalizeProposalKind(
  value: unknown,
  fallback: ProposalKind = "plan",
): ProposalKind {
  return value === "goal" || value === "plan" ? value : fallback;
}

/** The proposal kind a mode submits, or `null` for freely executing modes. */
export function proposalKindForMode(mode: Mode): ProposalKind | null {
  return mode === "plan" || mode === "goal" ? mode : null;
}

/** The operating mode that owns a proposal kind. */
export function modeForProposalKind(kind: ProposalKind): Mode {
  return kind;
}

export type PlanningState = "inactive" | "planning" | "awaiting_approval";
export type PlanApprovalAction = "approve" | "reject";
export type PlanApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "interrupted";

/** Compatibility name for the proposal-shaped approval wire record. */
export type PlanProposalStatus = PlanApprovalStatus;

export type PlanArtifact = {
  /** Workspace-relative path of the host-created plan artifact. */
  relativePath: string;
  sha256: string;
  sizeBytes: number;
};

export type PlanExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "interrupted";

export type PlanExecutionFinishStatus = Extract<
  PlanExecutionState,
  "completed" | "interrupted"
>;

export type PlanProposal = {
  /** Durable approval/proposal identity. */
  id: string;
  sessionId: string;
  /** Durable host turn ID owning the SubmitPlan/SubmitGoal call. */
  turnId: string;
  /** Exact SubmitPlan/SubmitGoal tool-call ID used to create this approval. */
  toolCallId: string;
  /** Which contract this approval carries; legacy rows read back as `plan`. */
  kind: ProposalKind;
  title: string;
  /** Exact Markdown snapshot submitted for approval. */
  markdown: string;
  question: string;
  artifact?: PlanArtifact;
  /** Submitted steps; omitted means none. */
  steps?: PlanStep[];
  /** Submitted design; omitted means none. */
  design?: PlanDesignSpec;
  /** User revision at approval; omitted means no revision, [] explicitly clears. */
  resolvedSteps?: PlanStep[];
  /** User revision at approval; omitted means no revision, {} explicitly clears. */
  resolvedDesign?: PlanDesignSpec;
  /** Host schema/version for this proposal snapshot. */
  version: number;
  status: PlanProposalStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  errorCode?: string;
  executionId?: string;
  executionState?: PlanExecutionState;
  /** Persisted snapshot alias retained by the host for compatibility. */
  plan: string;
};

/** Descriptor persisted by the host after approval and consumed by Main. */
export type PlanExecution = {
  id: string;
  proposalId: string;
  sessionId: string;
  /** Which contract was approved; drives the execution instruction. */
  kind: ProposalKind;
  /** Exact approved Markdown snapshot. */
  plan: string;
  title: string;
  question: string;
  artifact: PlanArtifact;
  /** Effective approved steps; omitted means none. */
  steps?: PlanStep[];
  /** Effective approved design; omitted means none. */
  design?: PlanDesignSpec;
  targetPermissionMode: GlobalPermissionMode;
  state: PlanExecutionState;
};

export type PlanExecutionDescriptor = PlanExecution;
export type ApprovedPlanExecution = PlanExecution;

export type PlanningStateEvent = {
  sessionId: string;
  state: PlanningState;
  /** Absent only for `inactive` transitions that carry no proposal. */
  kind?: ProposalKind;
  proposalId?: string;
  title?: string;
  markdown?: string;
  question?: string;
  artifact?: PlanArtifact;
  version?: number;
  plan?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  executionId?: string;
  executionState?: PlanExecutionState;
  proposal?: PlanProposal;
};

export type PlansGetRequest = { sessionId: string; proposalId: string };
export type PlansGetResult = { proposal: PlanProposal };

export function effectivePlanSteps(p: Pick<PlanProposal, "steps" | "resolvedSteps">): PlanStep[] {
  return p.resolvedSteps ?? p.steps ?? [];
}

export function effectivePlanDesign(p: Pick<PlanProposal, "design" | "resolvedDesign">): PlanDesignSpec | undefined {
  const design = p.resolvedDesign ?? p.design;
  return design && !isPlanDesignEmpty(design) ? design : undefined;
}

export type PlansPendingResult = {
  plans: PlanProposal[];
  state?: PlanningState;
  /** Contract kind the session is currently negotiating, when any (D198). */
  kind?: ProposalKind;
};

export type PlansQueuedExecutionsResult = {
  executions: PlanExecution[];
};

type PlanResolveIdentity = {
  proposalId: string;
  /** Identity fields must match the live host approval row exactly. */
  sessionId: string;
  turnId: string;
  toolCallId: string;
  version?: number;
};

export type PlanResolveRequest =
  | (PlanResolveIdentity & {
      action: "approve";
      targetPermissionMode: GlobalPermissionMode;
      revisedSteps?: PlanStep[];
      revisedDesign?: PlanDesignSpec;
      /** Edited Markdown body; the host publishes it as a new artifact. */
      revisedMarkdown?: string;
      /** Session model the approved execution runs on; omitted keeps the current one. */
      targetModel?: PlanTargetModel;
    })
  | (PlanResolveIdentity & {
      action: "reject";
      targetPermissionMode?: never;
      revisedSteps?: never;
      revisedDesign?: never;
      revisedMarkdown?: never;
      targetModel?: never;
    });

export type PlanTargetModel = { providerId: string; modelId: string };

export type PlanResolutionResult = {
  ok: boolean;
  proposal: PlanProposal;
  state: PlanningState;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  execution?: PlanExecution;
};

/** Current host state for one immutable plan/goal submission in a history page. */
export type PlanHistoryEntry = { proposal: PlanProposal; superseded: boolean };
