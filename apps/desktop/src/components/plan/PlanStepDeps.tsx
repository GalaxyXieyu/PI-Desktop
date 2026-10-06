import { useTranslation } from "react-i18next";
import type { PlanStep } from "@pi-desktop/shared";
import { Badge } from "../ui";
import { IconLink } from "../icons";

/** Compact dependency marker: step numbers, full titles on hover. */
export function PlanStepDeps({ step, steps }: { step: PlanStep; steps: PlanStep[] }) {
  const { t } = useTranslation();
  const indexes = step.dependsOn
    .map((id) => steps.findIndex((candidate) => candidate.id === id))
    .filter((index) => index >= 0);
  if (!indexes.length) return null;
  const titles = indexes.map((index) => `${index + 1}. ${steps[index].title || t("plan.untitledStep")}`);
  return (
    <span
      className="plan-step-deps-compact"
      role="group"
      aria-label={t("plan.dependsOn")}
      data-testid="plan-step-deps"
    >
      <IconLink size={11} aria-hidden />
      {indexes.map((index, position) => (
        <Badge key={steps[index].id} title={titles[position]}>{index + 1}</Badge>
      ))}
    </span>
  );
}
