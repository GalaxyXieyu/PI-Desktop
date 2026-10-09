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
import { Badge, Button, TooltipButton } from "../ui";
import { IconPencil, IconUndo2 } from "../icons";
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
  const revise = usePlanRevise(proposal, draft, remote);
  const path = proposal.artifact?.relativePath?.trim();
  const pending = proposal.status === "pending";
  const isPlan = proposal.kind === "plan";
  // Structure editing is local-only: remote sessions never send a revision.
  const editable = isPlan && !remote;
  const dirty = editable && planDraftDirty(draft);
  const status = proposal.status === "approved"
    ? proposal.executionState === "running" ? "executing"
      : proposal.executionState === "completed" ? "completed"
        : proposal.executionState === "interrupted" ? "interrupted" : "approved"
    : proposal.status;
  return <div className="plan-tab" data-testid="plan-tab">
    <header className="plan-tab-header">
      <div className="plan-tab-heading">
        <Badge>{t(proposal.kind === "goal" ? "plan.goalKind" : "plan.document")}</Badge>
        <Badge tone={pending ? "warning" : "neutral"}>{t(`plan.status.${status}`)}</Badge>
        {dirty && <Badge tone="warning">{t("plan.modified")}</Badge>}
        <strong className="plan-tab-title" title={proposal.title}>{proposal.title}</strong>
        {path && <Button size="sm" className="plan-tab-path" title={path} aria-label={t(`${proposal.kind}.openArtifactLabel`, { path })}
          onClick={() => openTab(proposal.sessionId, preferredFileWorkPanelTab(path, pluginViews))}>
          <span>{path}</span>
        </Button>}
      </div>
      <div className="plan-tab-actions">
        {dirty && <TooltipButton type="button" className="icon-btn icon-btn-square" ariaLabel={t("plan.resetChanges")}
          tooltip={t("plan.resetChanges")} onClick={() => dispatch({ type: "reset" })}>
          <IconUndo2 size={14} aria-hidden />
        </TooltipButton>}
        {pending && isPlan && <PlanBuildControls
          proposal={proposal}
          revision={remote ? undefined : planDraftRevision(draft)}
          disabledReason={remote ? undefined : planDraftValidation(draft)?.message}
          variant="tab"
        />}
        {revise.available && <Button size="sm" variant="primary" data-testid="plan-revise"
          disabled={revise.sending} onClick={() => void revise.revise()}>
          <IconPencil size={13} aria-hidden /> {t("plan.revise")}
        </Button>}
      </div>
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
