import { useTranslation } from "react-i18next";
import {
  PLAN_COLOR_GROUPS,
  effectivePlanDesign,
  effectivePlanSteps,
  isPlanDesignEmpty,
  type PlanDesignSpec,
  type PlanExecutionState,
  type PlanProposal,
  type PlanStep,
} from "@pi-desktop/shared";
import { Badge, Panel, cx } from "../ui";
import { Markdown } from "../Markdown";
import { useAppStore } from "../../stores/app-store";
import type { PlanDraft, PlanDraftAction } from "../../features/plan/plan-draft-model";
import { planStepProgress, type PlanProgress } from "../../features/plan/plan-step-progress";
import { PlanDesignEditor } from "./PlanDesignEditor";
import { PlanStepsEditor } from "./PlanStepsEditor";
import { PlanTasksSection } from "./PlanFlowchart";
import { PlanStepDeps } from "./PlanStepDeps";

export function PlanDesignView({ design }: { design: PlanDesignSpec }) {
  const { t } = useTranslation();
  const font = design.fontSystem;
  return (
    <section className="plan-tab-section" aria-label={t("plan.designSpec")}>
      <h2>{t("plan.designSpec")}</h2>
      <Panel className="plan-design-grid">
        <div className="plan-design-column">
          {!!design.styleKeywords?.length && <div>
            <h3>{t("plan.styleKeywords")}</h3>
            <div className="plan-tab-chips">{design.styleKeywords.map((keyword) => <Badge key={keyword}>{keyword}</Badge>)}</div>
          </div>}
          {font && <div>
            <h3>{t("plan.typography")}</h3>
            <div className="plan-typography-rows">
              <div className="plan-font-family-row">
                <span className="plan-tab-muted">{t("plan.fontFamilyLabel")}</span>
                <span className="plan-font-family-name">{font.fontFamily}</span>
              </div>
              {(["heading", "subheading", "body"] as const).map((level) => font[level] && (
                <div key={level} className="plan-font-level-row">
                  <span className="plan-font-level-label plan-tab-muted">{t(`plan.${level}`)}</span>
                  <span className="plan-font-level-spec">{font[level].size} · {font[level].weight}</span>
                </div>
              ))}
            </div>
            <div className="plan-font-preview-card" style={{ fontFamily: font.fontFamily }}>
              {(["heading", "subheading", "body"] as const).map((level) => {
                const spec = font[level];
                if (!spec) return null;
                return (
                  <div key={level} className={`plan-preview-line plan-preview-line--${level}`} style={{ fontFamily: font.fontFamily, fontSize: spec.size, fontWeight: spec.weight }}>
                    <span className="plan-preview-text">{t("plan.fontPreview")}</span>
                    <span className="plan-preview-annotation">{spec.size} · {spec.weight}</span>
                  </div>
                );
              })}
            </div>
          </div>}
        </div>
        <div className="plan-design-column">
          {PLAN_COLOR_GROUPS.some((group) => design.colorSystem?.[group]?.length) && <div>
            <h3>{t("plan.colors")}</h3>
            {PLAN_COLOR_GROUPS.map((group) => {
              const colors = design.colorSystem?.[group];
              return colors?.length ? (
                <div key={group} className="plan-color-group">
                  <div className="plan-color-group-label">{t(`plan.colorGroups.${group}`)}</div>
                  <div className="plan-color-swatches-row">
                    {colors.map((color, index) => (
                      <div className="plan-color" key={`${index}:${color}`}>
                        <span className="plan-color-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
                        <code>{color}</code>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null;
            })}
          </div>}
          {(design.framework || design.componentLibrary) && <div>
            <div className="plan-slug-row">
              {design.framework && (
                <div className="plan-slug-item">
                  <span className="plan-tab-muted">{t("plan.framework")}</span>
                  <p>{design.framework}</p>
                </div>
              )}
              {design.componentLibrary && (
                <div className="plan-slug-item">
                  <span className="plan-tab-muted">{t("plan.componentLibrary")}</span>
                  <p>{design.componentLibrary}</p>
                </div>
              )}
            </div>
          </div>}
        </div>
      </Panel>
    </section>
  );
}

const STEP_STATUS_GLYPHS = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  cancelled: "⊘",
} as const;

const EXECUTION_BADGE_TONES = {
  queued: "neutral",
  running: "warning",
  completed: "success",
  interrupted: "error",
} as const;

/**
 * Read-only steps contract. After approval (`progress` present) every row
 * gets a status circle from the session checklist; users cannot tick items
 * here by design — execution updates flow through TodoWrite only.
 */
export function PlanStepsView({
  steps,
  progress,
  executionState,
}: {
  steps: PlanStep[];
  progress?: PlanProgress;
  executionState?: PlanExecutionState;
}) {
  const { t } = useTranslation();
  const statusByStepId = new Map(progress?.steps.map((step) => [step.stepId, step.status]) ?? []);
  return <PlanTasksSection steps={steps} progress={progress} summary={
    progress && <p className="plan-progress" data-testid="plan-progress">
      {t("plan.progress", { done: progress.done, total: progress.total })}
      {executionState && <Badge tone={EXECUTION_BADGE_TONES[executionState]}>
        {t(`plan.execution.${executionState}`)}
      </Badge>}
    </p>
  }>
    <ol className="plan-task-list">{steps.map((step, index) => {
      const status = statusByStepId.get(step.id);
      const shown = !status || status === "unknown" ? "pending" : status;
      return <li key={step.id}
        className={cx("plan-step-row", progress && `plan-step-row--${shown}`)}
        data-testid={progress ? "plan-progress-step" : undefined}
        data-step-id={step.id}
        data-status={progress ? shown : undefined}
      >
        <div className="plan-step-line">
          {progress ? <span
            className={cx("plan-step-status", `plan-step-status--${shown}`)}
            role="img"
            aria-label={t(`plan.stepStatus.${shown === "in_progress" ? "inProgress" : shown}`)}
          >{STEP_STATUS_GLYPHS[shown]}</span> : <span className="plan-step-status" aria-hidden />}
          <span className="plan-step-index">{index + 1}</span>
          <span className="plan-step-title">{step.title}</span>
          <PlanStepDeps step={step} steps={steps} />
        </div>
        {step.detail && <p className="plan-task-detail">{step.detail}</p>}
      </li>;
    })}</ol>
  </PlanTasksSection>;
}

/** Markdown is immutable; only pending structured data may come from a draft. */
export function PlanDocument({
  proposal,
  draft,
  editable = false,
  dispatch,
}: {
  proposal: PlanProposal;
  draft?: PlanDraft;
  /** Pending local Plan: swap the read-only views for the editors. */
  editable?: boolean;
  dispatch?: (action: PlanDraftAction) => void;
}) {
  const { t } = useTranslation();
  const pending = proposal.status === "pending";
  const steps = pending ? draft?.steps ?? proposal.steps ?? [] : effectivePlanSteps(proposal);
  const design = pending ? draft ? draft.design : proposal.design : effectivePlanDesign(proposal);
  const editing = editable && !!draft && !!dispatch;
  const approved = proposal.status === "approved";
  const todos = useAppStore((state) =>
    approved ? state.sessionTodos[proposal.sessionId] : undefined);
  const progress = approved ? planStepProgress(steps, todos?.todos ?? []) : undefined;
  // A design section is editable only when the submitted proposal carried one;
  // plans without a design never grow one here.
  const submittedDesign = proposal.design && !isPlanDesignEmpty(proposal.design);
  return <article className="plan-document">
    <h1>{proposal.title}</h1>
    <p className="plan-overview">{proposal.question}</p>
    <section className="plan-tab-section" aria-label={t("plan.document")}>
      <h2>{t("plan.document")}</h2>
      <div className="plan-markdown prose-chat"><Markdown source={proposal.markdown} /></div>
    </section>
    {editing && submittedDesign && draft.design
      ? <PlanDesignEditor design={draft.design} dispatch={dispatch} />
      : design && !isPlanDesignEmpty(design) && <PlanDesignView design={design} />}
    {editing
      ? <PlanStepsEditor draft={draft} dispatch={dispatch} />
      : !!steps.length && <PlanStepsView
        steps={steps}
        progress={progress}
        executionState={approved ? proposal.executionState : undefined}
      />}
  </article>;
}
