import { useTranslation } from "react-i18next";
import type { PlanProposal } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";

/**
 * A settled proposal is never edited in place: revising switches its local,
 * idle session back to the proposal's contract mode and seeds the composer
 * with a request for a new submission that the user completes and sends.
 */
export function usePlanRevise(proposal: PlanProposal, remote: boolean) {
  const { t } = useTranslation();
  const { sessionId, kind, executionState } = proposal;
  const available = useAppStore((state) =>
    !remote
    && proposal.status !== "pending"
    && executionState !== "queued"
    && executionState !== "running"
    && state.activeSessionId === sessionId
    && !state.runningSessions[sessionId]
    && state.pendingPlans[sessionId]?.status !== "pending");

  const revise = async () => {
    const state = useAppStore.getState();
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    if (session.mode !== kind) {
      try {
        await state.configureActiveSession({
          mode: kind,
          providerId: session.providerId,
          modelId: session.modelId,
          thinkingLevel: session.thinkingLevel,
        });
      } catch (error) {
        state.showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
        return;
      }
    }
    if (useAppStore.getState().activeSessionId !== sessionId) return;
    useAppStore.setState({
      composerPrefill: {
        sessionId,
        text: t(`${kind}.revisePrompt`, {
          title: proposal.title,
          path: proposal.artifact?.relativePath ?? "",
          interpolation: { escapeValue: false },
        }),
        fileReferences: [],
      },
    });
  };

  return { available, revise };
}
