import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlanProposal } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import type { AppState } from "../../stores/app-state";
import { planDraftDirty, planDraftRevision, type PlanDraft } from "./plan-draft-model";
import { discardPlanDraft } from "./plan-draft-store";

const STOP_TIMEOUT_MS = 10_000;

/** The Plan-mode message that asks the agent to resubmit the edited plan. */
export function planRevisionMessage(
  draft: PlanDraft,
  labels: { intro: string; tasks: string; design: string },
): string {
  const revision = planDraftRevision(draft);
  const parts = [labels.intro, draft.markdown.trim()];
  if (revision.revisedSteps) {
    parts.push(`## ${labels.tasks}\n\n${revision.revisedSteps.map((step, index) => {
      const deps = step.dependsOn.length ? ` (depends on: ${step.dependsOn.join(", ")})` : "";
      const detail = step.detail?.trim() ? `\n   ${step.detail.trim()}` : "";
      return `${index + 1}. [${step.id}] ${step.title}${deps}${detail}`;
    }).join("\n")}`);
  }
  if (revision.revisedDesign) {
    parts.push(`## ${labels.design}\n\n\`\`\`json\n${JSON.stringify(revision.revisedDesign, null, 2)}\n\`\`\``);
  }
  return parts.join("\n\n");
}

function executing(state: AppState, proposal: PlanProposal): boolean {
  const live = state.planCheckpoints[proposal.sessionId];
  return !!state.runningSessions[proposal.sessionId]
    || (live?.id === proposal.id && live.executionState === "running");
}

function waitUntil(predicate: (state: AppState) => boolean): Promise<void> {
  if (predicate(useAppStore.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, STOP_TIMEOUT_MS);
    const unsubscribe = useAppStore.subscribe((state) => {
      if (predicate(state)) done();
    });
  });
}

/**
 * A settled local Plan is edited in place; revising stops its execution if
 * needed, switches the session back to Plan mode, and sends the edited plan so
 * the agent submits a new version for approval. The settled one stays as is.
 */
export function usePlanRevise(proposal: PlanProposal, draft: PlanDraft, remote: boolean) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const { sessionId } = proposal;
  const available = useAppStore((state) =>
    !remote
    && proposal.kind === "plan"
    && proposal.status !== "pending"
    && proposal.executionState !== "queued"
    && state.activeSessionId === sessionId
    && state.pendingPlans[sessionId]?.status !== "pending")
    && planDraftDirty(draft);

  const revise = async () => {
    if (sending) return;
    const message = planRevisionMessage(draft, {
      intro: t("plan.reviseEditedPrompt", {
        title: proposal.title,
        path: proposal.artifact?.relativePath ?? "",
        interpolation: { escapeValue: false },
      }),
      tasks: t("plan.tasks"),
      design: t("plan.designSpec"),
    });
    setSending(true);
    try {
      const state = useAppStore.getState();
      if (executing(state, proposal)) {
        await state.abortSession(sessionId);
        await waitUntil((next) => !executing(next, proposal));
      }
      const session = useAppStore.getState().sessions.find((candidate) => candidate.id === sessionId);
      if (!session || useAppStore.getState().activeSessionId !== sessionId) return;
      if (session.mode !== "plan") {
        await useAppStore.getState().configureActiveSession({
          mode: "plan",
          providerId: session.providerId,
          modelId: session.modelId,
          thinkingLevel: session.thinkingLevel,
        });
      }
      if (await useAppStore.getState().sendPrompt(message, undefined, sessionId)) {
        discardPlanDraft(draft.key);
      }
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSending(false);
    }
  };

  return { available, sending, revise };
}
