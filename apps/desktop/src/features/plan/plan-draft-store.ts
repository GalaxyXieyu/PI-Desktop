import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import type { PlanProposal } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { createPlanDraft, planDraftKey, planDraftReducer, type PlanDraft, type PlanDraftAction } from "./plan-draft-model";

type DraftState = {
  drafts: Record<string, PlanDraft>;
  dispatch: (proposal: PlanProposal, action: PlanDraftAction) => void;
};

export const usePlanDraftStore = create<DraftState>((set) => ({
  drafts: {},
  dispatch: (proposal, action) => {
    if (proposal.status !== "pending") return;
    const key = planDraftKey(proposal);
    set((state) => ({ drafts: {
      ...state.drafts,
      [key]: planDraftReducer(state.drafts[key] ?? createPlanDraft(proposal), action),
    } }));
  },
}));

export function discardPlanDraft(key: string): void {
  usePlanDraftStore.setState((state) => {
    if (!state.drafts[key]) return state;
    const drafts = { ...state.drafts };
    delete drafts[key];
    return { drafts };
  });
}

// The store owns this renderer-lifetime observer, not either approval surface.
// Closing the tab must retain edits, but resolving a hidden proposal must not.
const unsubscribe = useAppStore.subscribe((state, previous) => {
  for (const proposal of Object.values(previous.pendingPlans)) {
    if (!proposal) continue;
    const current = state.pendingPlans[proposal.sessionId];
    if (!current || current.status !== "pending" || planDraftKey(current) !== planDraftKey(proposal)) {
      discardPlanDraft(planDraftKey(proposal));
    }
  }
  for (const proposal of Object.values(state.planCheckpoints)) {
    if (proposal && proposal.status !== "pending") discardPlanDraft(planDraftKey(proposal));
  }
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

export function usePlanDraft(proposal: PlanProposal): [PlanDraft, (action: PlanDraftAction) => void] {
  const key = planDraftKey(proposal);
  const saved = usePlanDraftStore((state) => state.drafts[key]);
  const base = useMemo(() => createPlanDraft(proposal), [proposal]);
  useEffect(() => {
    if (proposal.status !== "pending") discardPlanDraft(key);
  }, [key, proposal.status]);
  const dispatch = useCallback((action: PlanDraftAction) => {
    usePlanDraftStore.getState().dispatch(proposal, action);
  }, [proposal]);
  return [proposal.status === "pending" ? saved ?? base : base, dispatch];
}
