import { useEffect, useRef, useState } from "react";
import type { PlanProposal } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

type LoadedPlan = { key: string; proposal?: PlanProposal; failed?: boolean };

export function usePlanProposal(sessionId: string, proposalId: string) {
  const checkpoint = useAppStore((state) => state.planCheckpoints[sessionId]);
  const pending = useAppStore((state) => state.pendingPlans[sessionId]);
  const session = useAppStore((state) => state.sessions.find((item) => item.id === sessionId));
  const stored = checkpoint?.id === proposalId ? checkpoint : pending?.id === proposalId ? pending : undefined;
  const remote = session?.source === "remote";
  const key = `${sessionId}:${proposalId}`;
  const [loaded, setLoaded] = useState<LoadedPlan>();
  const request = useRef<{ key: string; promise: ReturnType<typeof api.getPlan> } | undefined>(undefined);
  const shouldLoad = !!session && !remote && !stored;

  useEffect(() => {
    if (!shouldLoad) return;
    let active = true;
    if (request.current?.key !== key) {
      request.current = { key, promise: api.getPlan({ sessionId, proposalId }) };
    }
    void request.current.promise.then(({ proposal }) => {
      if (!active) return;
      setLoaded(proposal.sessionId === sessionId && proposal.id === proposalId
        ? { key, proposal } : { key, failed: true });
    }, () => {
      if (active) setLoaded({ key, failed: true });
    });
    return () => { active = false; };
  }, [key, sessionId, proposalId, shouldLoad]);

  // Never display the previous session's data, including before effects run.
  const result = loaded?.key === key && !remote ? loaded : undefined;
  return {
    proposal: stored ?? result?.proposal,
    remote,
    loading: !stored && !remote && !result,
    failed: !stored && (remote || result?.failed),
  };
}
