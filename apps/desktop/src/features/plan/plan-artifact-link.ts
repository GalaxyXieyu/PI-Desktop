import type { PlanProposal, UiMessage } from "@pi-desktop/shared";

export type PlanArtifactLookup = {
  activeSessionId?: string | null;
  pendingPlans: Record<string, PlanProposal>;
  planCheckpoints: Record<string, PlanProposal>;
  messages: UiMessage[];
};

/**
 * The visible session's proposal whose immutable `.pi/<kind>/*.md` artifact
 * sits at `relativePath`. Live approval state wins over a transcript copy so
 * the returned status is current.
 */
export function findPlanByArtifactPath(
  state: PlanArtifactLookup,
  relativePath: string | null | undefined,
): PlanProposal | undefined {
  const sessionId = state.activeSessionId;
  const path = relativePath?.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!sessionId || !path) return undefined;
  return [
    state.pendingPlans[sessionId],
    state.planCheckpoints[sessionId],
    ...state.messages.map((message) => message.planHistory?.proposal),
  ].find((proposal) => proposal?.sessionId === sessionId && proposal.artifact?.relativePath === path);
}
