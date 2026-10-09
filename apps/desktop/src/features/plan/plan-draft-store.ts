import { useCallback, useMemo } from "react";
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
// Closing the tab must retain edits, but resolving a hidden proposal must drop
// its review draft. Settled drafts live until their revision is sent or reset.
const unsubscribe = useAppStore.subscribe((state, previous) => {
  for (const source of ["pendingPlans", "planCheckpoints"] as const) {
    for (const proposal of Object.values(previous[source])) {
      if (proposal?.status !== "pending") continue;
      const current = state[source][proposal.sessionId];
      if (current?.status !== "pending" || planDraftKey(current) !== planDraftKey(proposal)) {
        discardPlanDraft(planDraftKey(proposal));
      }
    }
  }
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

export function usePlanDraft(proposal: PlanProposal): [PlanDraft, (action: PlanDraftAction) => void] {
  const key = planDraftKey(proposal);
  const saved = usePlanDraftStore((state) => state.drafts[key]);
  const base = useMemo(() => createPlanDraft(proposal), [proposal]);
  const dispatch = useCallback((action: PlanDraftAction) => {
    usePlanDraftStore.getState().dispatch(proposal, action);
  }, [proposal]);
  return [saved ?? base, dispatch];
}
