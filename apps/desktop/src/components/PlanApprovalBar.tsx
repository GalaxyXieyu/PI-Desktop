import { useTranslation } from "react-i18next";
import type { PlanProposal, ProposalKind } from "@pi-desktop/shared";
import { isPlanDesignEmpty } from "@pi-desktop/shared";
import {
  planDraftRevision,
  planDraftValidation,
} from "../features/plan/plan-draft-model";
import { usePlanDraft } from "../features/plan/plan-draft-store";
import { useAppStore } from "../stores/app-store";
import { planWorkPanelTab } from "../lib/work-panel-tabs";
import { IconFileText } from "./icons";
import { Badge, Button } from "./ui";
import { PlanBuildControls } from "./plan/PlanBuildControls";

/** `plan.reject` or `goal.reject`, chosen by the approved contract kind. */
function copyKey(kind: ProposalKind, name: string): string {
  return `${kind}.${name}`;
}

/**
 * Plan and Goal share this one approval bar; only the copy differs, so every
 * label is looked up under the proposal kind's i18n namespace (D198).
 */
export function PlanApprovalBar({ proposal }: { proposal: PlanProposal }) {
  const { t } = useTranslation();
  const [draft] = usePlanDraft(proposal);
  const openWorkPanelTabForSession = useAppStore(
    (state) => state.openWorkPanelTabForSession,
  );
  const kind: ProposalKind = proposal.kind === "goal" ? "goal" : "plan";
  const copy = (name: string) => t(copyKey(kind, name));
  const artifactPath = proposal.artifact?.relativePath?.trim() || null;
  const isPending = proposal.status === "pending";
  const openPlan = () => openWorkPanelTabForSession(proposal.sessionId, planWorkPanelTab(proposal));

  return (
    <section
      className="plan-approval-bar"
      role="region"
      aria-label={copy("approvalRegion")}
      data-kind={kind}
      data-status={proposal.status}
      data-execution-state={proposal.executionState || ""}
      data-testid="plan-approval-bar"
    >
      <span className="sr-only" role="status" aria-live="polite">
        {copy("readyAnnouncement")}
      </span>
      <div className="plan-approval-copy">
        <h2 className="plan-approval-title">
          {proposal.title.trim() || copy("untitled")}
        </h2>
        <div className="plan-approval-details">
          <Button size="sm" data-testid="plan-view-plan" onClick={openPlan}>
            {copy(proposal.steps?.length || (proposal.design && !isPlanDesignEmpty(proposal.design)) ? "reviewEditPlan" : "viewPlan")}
          </Button>
          {!!draft.steps.length && <Badge>{t("plan.taskCount", { count: draft.steps.length })}</Badge>}
          {draft.design && !isPlanDesignEmpty(draft.design) && <Badge>{t("plan.designSpec")}</Badge>}
          {artifactPath ? (
            <button
              type="button"
              className="plan-approval-artifact"
              data-testid="plan-open-artifact"
              aria-label={t(copyKey(kind, "openArtifactLabel"), {
                path: artifactPath,
              })}
              title={artifactPath}
              onClick={openPlan}
            >
              <IconFileText size={14} aria-hidden />
              <span className="plan-approval-artifact-label">
                {copy("openArtifact")}
              </span>
              <span className="plan-approval-artifact-path">
                {artifactPath}
              </span>
            </button>
          ) : null}
        </div>
      </div>
      {isPending ? (
        <div className="plan-approval-actions">
          <PlanBuildControls
            proposal={proposal}
            revision={planDraftRevision(draft)}
            disabledReason={planDraftValidation(draft)?.message}
            variant="bar"
          />
        </div>
      ) : null}
    </section>
  );
}
