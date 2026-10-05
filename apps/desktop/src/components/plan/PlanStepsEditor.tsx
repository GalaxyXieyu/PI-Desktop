import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { newPlanStepId, planStepWouldCreateCycle, type PlanStep } from "@pi-desktop/shared";
import {
  planStepEditKeyAction,
  type PlanDraft,
  type PlanDraftAction,
} from "../../features/plan/plan-draft-model";
import { Badge, Button, Checkbox, Input, Textarea, TooltipButton } from "../ui";
import { AnchoredMenu } from "../settings/AnchoredMenu";
import { PlanTasksSection } from "./PlanFlowchart";
import { IconArrowDown, IconArrowUp, IconPencil, IconPlus, IconTrash } from "../icons";

type Dispatch = (action: PlanDraftAction) => void;

function StepTitleInput({
  step,
  dispatch,
  onDone,
}: {
  step: PlanStep;
  dispatch: Dispatch;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = (title: string) => {
    dispatch({ type: "stepUpdate", id: step.id, title: title.trim() });
    onDone();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const action = planStepEditKeyAction(event.key, event.currentTarget.value);
    if (action === "save") {
      event.preventDefault();
      save(event.currentTarget.value);
    } else if (action === "cancel") {
      event.preventDefault();
      onDone();
    } else if (action === "remove") {
      event.preventDefault();
      dispatch({ type: "stepRemove", id: step.id });
      onDone();
    }
  };
  return (
    <Input
      autoFocus
      defaultValue={step.title}
      aria-label={t("plan.stepTitleLabel")}
      data-testid="plan-step-title-input"
      onKeyDown={onKeyDown}
      onBlur={(event) => save(event.currentTarget.value)}
    />
  );
}

function StepDependsOnPicker({
  step,
  steps,
  dispatch,
}: {
  step: PlanStep;
  steps: PlanStep[];
  dispatch: Dispatch;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const others = steps.filter((candidate) => candidate.id !== step.id);
  if (!others.length) return null;
  const toggle = (id: string) => {
    dispatch({
      type: "stepSetDependsOn",
      id: step.id,
      dependsOn: step.dependsOn.includes(id)
        ? step.dependsOn.filter((dependency) => dependency !== id)
        : [...step.dependsOn, id],
    });
  };
  return (
    <AnchoredMenu
      className="plan-step-deps"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="plan-step-deps-menu"
      label={t("plan.dependsOn")}
      role="dialog"
      trigger={(ref) => (
        <Button
          ref={ref}
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="plan-step-deps-trigger"
          onClick={() => setOpen((value) => !value)}
        >
          {t("plan.dependsOn")}
        </Button>
      )}
    >
      {others.map((candidate) => {
        const selected = step.dependsOn.includes(candidate.id);
        const cycle = !selected && planStepWouldCreateCycle(steps, step.id, candidate.id);
        const index = steps.findIndex((item) => item.id === candidate.id);
        return (
          <Checkbox
            key={candidate.id}
            label={`${index + 1}. ${candidate.title || t("plan.untitledStep")}`}
            checked={selected}
            disabled={cycle}
            title={cycle ? t("plan.wouldCreateCycle") : undefined}
            data-testid="plan-step-dep-option"
            data-step-id={candidate.id}
            onChange={() => toggle(candidate.id)}
          />
        );
      })}
    </AnchoredMenu>
  );
}

/**
 * Editable task list for a pending local Plan draft. Rows commit on Enter or
 * blur, Escape discards an edit, and Backspace on an empty title removes the
 * row. All mutations go through the draft reducer so the
 * shared approval bar sees the same edits.
 */
export function PlanStepsEditor({ draft, dispatch }: { draft: PlanDraft; dispatch: Dispatch }) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(new Set());

  // A freshly added step asks for its title first.
  useEffect(() => {
    if (draft.editingStepId) setEditingId(draft.editingStepId);
  }, [draft.editingStepId]);

  const addStep = () => dispatch({ type: "stepAdd", id: newPlanStepId() });
  const toggleDetail = (id: string) => {
    setOpenDetails((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <PlanTasksSection steps={draft.steps}>
      <ol className="plan-task-list plan-steps-editor">
        {draft.steps.map((step, index) => {
          const detailOpen = openDetails.has(step.id) || !!step.detail;
          return (
            <li key={step.id} className="plan-step-row" data-testid="plan-step-row" data-step-id={step.id}>
              <div className="plan-step-line">
                <span className="plan-step-index">{index + 1}.</span>
                <span
                  className="plan-step-status"
                  role="img"
                  aria-label={t("plan.status.pending")}
                />
                {editingId === step.id ? (
                  <StepTitleInput
                    step={step}
                    dispatch={dispatch}
                    onDone={() => setEditingId(null)}
                  />
                ) : (
                  <span
                    className="plan-step-title"
                    onDoubleClick={() => setEditingId(step.id)}
                  >
                    {step.title || <span className="plan-tab-muted">{t("plan.untitledStep")}</span>}
                  </span>
                )}
                <span className="plan-step-actions">
                  {editingId === step.id ? null : (
                    <TooltipButton
                      type="button"
                      tooltip={t("plan.editStep")}
                      ariaLabel={t("plan.editStep")}
                      onClick={() => setEditingId(step.id)}
                    >
                      <IconPencil size={13} aria-hidden />
                    </TooltipButton>
                  )}
                  <TooltipButton
                    type="button"
                    tooltip={t("plan.moveUp")}
                    ariaLabel={t("plan.moveUp")}
                    disabled={index === 0}
                    onClick={() => dispatch({ type: "stepMove", id: step.id, direction: "up" })}
                  >
                    <IconArrowUp size={13} aria-hidden />
                  </TooltipButton>
                  <TooltipButton
                    type="button"
                    tooltip={t("plan.moveDown")}
                    ariaLabel={t("plan.moveDown")}
                    disabled={index === draft.steps.length - 1}
                    onClick={() => dispatch({ type: "stepMove", id: step.id, direction: "down" })}
                  >
                    <IconArrowDown size={13} aria-hidden />
                  </TooltipButton>
                  <TooltipButton
                    type="button"
                    tooltip={t("plan.deleteStep")}
                    ariaLabel={t("plan.deleteStep")}
                    data-testid="plan-step-delete"
                    onClick={() => dispatch({ type: "stepRemove", id: step.id })}
                  >
                    <IconTrash size={13} aria-hidden />
                  </TooltipButton>
                </span>
              </div>
              {!!step.dependsOn.length && (
                <div className="plan-tab-chips" data-testid="plan-step-deps">
                  <span className="plan-tab-muted">{t("plan.dependsOn")}</span>
                  {step.dependsOn.map((id) => {
                    const dependencyIndex = draft.steps.findIndex((item) => item.id === id);
                    const dependency = draft.steps[dependencyIndex];
                    return dependency ? (
                      <Badge key={id}>{dependencyIndex + 1}. {dependency.title}</Badge>
                    ) : null;
                  })}
                </div>
              )}
              <div className="plan-step-controls">
                <StepDependsOnPicker step={step} steps={draft.steps} dispatch={dispatch} />
                <Button size="sm" onClick={() => toggleDetail(step.id)}>
                  {t(detailOpen ? "plan.hideDetail" : "plan.addDetail")}
                </Button>
              </div>
              {detailOpen && (
                <Textarea
                  className="plan-step-detail-input"
                  rows={3}
                  defaultValue={step.detail ?? ""}
                  aria-label={t("plan.stepDetailLabel")}
                  placeholder={t("plan.stepDetailPlaceholder")}
                  onBlur={(event) =>
                    dispatch({ type: "stepUpdate", id: step.id, detail: event.currentTarget.value.trim() || undefined })
                  }
                />
              )}
            </li>
          );
        })}
      </ol>
      <Button size="sm" onClick={addStep} data-testid="plan-step-add">
        <IconPlus size={13} aria-hidden /> {t("plan.addTask")}
      </Button>
    </PlanTasksSection>
  );
}
