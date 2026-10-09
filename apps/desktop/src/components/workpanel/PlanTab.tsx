import { useTranslation } from "react-i18next";
import type { PlanProposal } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { preferredFileWorkPanelTab } from "../../lib/work-panel-tabs";
import {
  planDraftDirty,
  planDraftRevision,
  planDraftValidation,
} from "../../features/plan/plan-draft-model";
import { usePlanDraft } from "../../features/plan/plan-draft-store";
import { usePlanProposal } from "../../features/plan/use-plan-proposal";
import { usePlanRevise } from "../../features/plan/use-plan-revise";
import { Badge, Button } from "../ui";
import { IconPencil } from "../icons";
import { PlanDocument } from "../plan/PlanDocument";
import { PlanBuildControls } from "../plan/PlanBuildControls";

export function PlanTab({ sessionId, proposalId }: { sessionId: string; proposalId: string }) {
  const { t } = useTranslation();
  const { proposal, remote, loading } = usePlanProposal(sessionId, proposalId);
  if (!proposal) return <div className="plan-tab-message" role={loading ? "status" : "alert"}>
    {t(loading ? "plan.loading" : remote ? "plan.remoteUnavailable" : "plan.loadError")}
  </div>;
  return <PlanTabContent proposal={proposal} remote={remote} />;
}

function PlanTabContent({ proposal, remote }: { proposal: PlanProposal; remote: boolean }) {
  const { t } = useTranslation();
  const [draft, dispatch] = usePlanDraft(proposal);
  const pluginViews = useAppStore((state) => state.pluginViews);
  const openTab = useAppStore((state) => state.openWorkPanelTabForSession);
  const revise = usePlanRevise(proposal, remote);
  const path = proposal.artifact?.relativePath?.trim();
  const pending = proposal.status === "pending";
  const isPlan = proposal.kind === "plan";
  // Structure editing is local-only: remote sessions never send a revision.
  const editable = pending && isPlan && !remote;
  const dirty = editable && planDraftDirty(draft);
  const status = proposal.status === "approved"
    ? proposal.executionState === "running" ? "executing"
      : proposal.executionState === "completed" ? "completed"
        : proposal.executionState === "interrupted" ? "interrupted" : "approved"
    : proposal.status;
  return <div className="plan-tab" data-testid="plan-tab">
    <header className="plan-tab-header">
      <Badge>{t(proposal.kind === "goal" ? "plan.goalKind" : "plan.document")}</Badge>
      <Badge tone={pending ? "warning" : "neutral"}>{t(`plan.status.${status}`)}</Badge>
      {dirty && <Badge tone="warning">{t("plan.modified")}</Badge>}
      <strong className="plan-tab-title">{proposal.title}</strong>
      {dirty && <Button size="sm" onClick={() => dispatch({ type: "reset" })}>{t("plan.resetChanges")}</Button>}
      {path && <Button size="sm" title={path} aria-label={t(`${proposal.kind}.openArtifactLabel`, { path })}
        onClick={() => openTab(proposal.sessionId, preferredFileWorkPanelTab(path, pluginViews))}>
        {path}
      </Button>}
      {pending && isPlan && <div className="plan-tab-actions">
        <PlanBuildControls
          proposal={proposal}
          revision={remote ? undefined : planDraftRevision(draft)}
          disabledReason={remote ? undefined : planDraftValidation(draft)?.message}
          variant="tab"
        />
      </div>}
      {pending && !isPlan && !remote && <div className="plan-tab-actions" />}
      {revise.available && <div className="plan-tab-actions">
        <Button size="sm" variant="primary" data-testid="plan-revise" onClick={() => void revise.revise()}>
          <IconPencil size={13} aria-hidden /> {t(`${proposal.kind}.revise`)}
        </Button>
      </div>}
    </header>
    {remote && <p className="plan-tab-message">{t("plan.remoteReadOnly")}</p>}
    {remote && pending && isPlan && <p className="plan-tab-message">{t("plan.remoteNoEditing")}</p>}
    <PlanDocument
      proposal={proposal}
      draft={remote ? undefined : draft}
      editable={editable}
      dispatch={editable ? dispatch : undefined}
    />
  </div>;
}
