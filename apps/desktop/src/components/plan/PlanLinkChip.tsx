import { useTranslation } from "react-i18next";
import type { PlanProposal } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { planWorkPanelTab } from "../../lib/work-panel-tabs";
import { IconListChecks, IconTarget } from "../icons";
import { Badge, Button } from "../ui";
import "../../styles/plan-history.css";

const STATUS_TONES = {
  pending: "warning",
  approved: "success",
} as const;

/** A message link to a plan artifact, rendered as the plan it names. */
export function PlanLinkChip({ proposal }: { proposal: PlanProposal }) {
  const { t } = useTranslation();
  const openTab = useAppStore((state) => state.openWorkPanelTabForSession);
  const kind = proposal.kind === "goal" ? "goal" : "plan";
  const Icon = kind === "goal" ? IconTarget : IconListChecks;
  const tone = STATUS_TONES[proposal.status as keyof typeof STATUS_TONES] ?? "neutral";
  return (
    <Button
      variant="ghost"
      size="sm"
      className="plan-link-chip"
      title={t("plan.viewPlan")}
      data-testid="plan-link-chip"
      onClick={() => openTab(proposal.sessionId, planWorkPanelTab(proposal))}
    >
      <Icon size={13} aria-hidden />
      <span className="plan-link-chip-title">{proposal.title.trim() || t(`${kind}.untitled`)}</span>
      <Badge tone={tone}>{t(`plan.status.${proposal.status}`)}</Badge>
    </Button>
  );
}
