import { useId, useState, type ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PlanStep } from "@pi-desktop/shared";
import {
  PLAN_FLOW_NODE_WIDTH,
  PLAN_FLOW_NODE_HEIGHT,
  planFlowchartLayout,
  planFlowTitleBudget,
  truncatePlanFlowTitle,
  type PlanFlowDirection,
} from "../../features/plan/plan-flowchart-layout";
import type { PlanProgress, PlanStepProgressStatus } from "../../features/plan/plan-step-progress";
import { cx, SegmentedControl, TooltipButton } from "../ui";
import { IconMinus, IconPlus } from "../icons";

/** Tasks section view switch shared by the draft editor and the contract view. */
export function PlanTasksSection({
  steps,
  progress,
  summary,
  actions,
  children,
}: {
  /** Steps the graph mode renders — the live draft while pending. */
  steps: PlanStep[];
  progress?: PlanProgress;
  /** Content shared by both modes, such as approved execution progress. */
  summary?: ReactNode;
  /** Header controls placed before the view toggle. */
  actions?: ReactNode;
  /** List-mode content. */
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<"list" | "graph">("list");
  return (
    <section className="plan-tab-section" aria-label={t("plan.tasks")}>
      <div className="plan-tab-section-head">
        <h2>{t("plan.tasks")}</h2>
        {actions}
        {!!steps.length && <div data-testid="plan-view-toggle">
          <SegmentedControl
            value={view}
            onChange={setView}
            label={t("plan.tasksViewLabel")}
            options={[
              { value: "list", label: t("plan.tasksView.list") },
              { value: "graph", label: t("plan.tasksView.graph") },
            ]}
          />
        </div>}
      </div>
      {summary}
      {view === "graph" && steps.length > 0 ? (
        <PlanFlowchart steps={steps} progress={progress} />
      ) : (
        children
      )}
    </section>
  );
}

/**
 * Read-only hand-written SVG DAG of the plan steps. Supports horizontal
 * and vertical layouts with auto-selection based on container width.
 */
export function PlanFlowchart({
  steps,
  progress,
}: {
  steps: PlanStep[];
  progress?: PlanProgress;
}) {
  const { t } = useTranslation();
  const markerId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [userDirection, setUserDirection] = useState<PlanFlowDirection | "auto">("auto");
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [zoom, setZoom] = useState<number>(1);

  // Compute natural horizontal layout to know required width
  const hLayout = planFlowchartLayout(steps, { direction: "horizontal" });
  const naturalHWidth = hLayout.width;

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const effectiveDirection: PlanFlowDirection =
    userDirection === "auto"
      ? containerWidth > 0 && containerWidth < naturalHWidth - 20
        ? "vertical"
        : "horizontal"
      : userDirection;

  // Node width in vertical mode follows the container: measured container width minus padding and an edge gutter, clamped to [160, 360]
  const verticalNodeWidth = Math.max(160, Math.min(360, (containerWidth || 240) - 32 - 40));
  const activeNodeWidth = effectiveDirection === "vertical" ? verticalNodeWidth : PLAN_FLOW_NODE_WIDTH;

  const layout = planFlowchartLayout(steps, {
    direction: effectiveDirection,
    nodeWidth: effectiveDirection === "vertical" ? verticalNodeWidth : undefined,
  });
  const statusByStepId = new Map(
    progress?.steps.map((step) => [step.stepId, step.status]) ?? [],
  );
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const budget = planFlowTitleBudget(activeNodeWidth);
  const statusText = (status: PlanStepProgressStatus | undefined) =>
    status && status !== "unknown"
      ? t(`plan.stepStatus.${status === "in_progress" ? "inProgress" : status}`)
      : undefined;

  const handleZoomIn = () => setZoom((z) => Math.min(2, Math.round((z + 0.15) * 100) / 100));
  const handleZoomOut = () => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100));
  const handleFit = () => setZoom(1);

  return (
    <div className="plan-flowchart-wrapper" ref={wrapperRef}>
      <div className="plan-flowchart-toolbar">
        <SegmentedControl
          value={userDirection === "auto" ? effectiveDirection : userDirection}
          onChange={(val) => setUserDirection(val as PlanFlowDirection)}
          label={t("plan.tasksViewLabel")}
          options={[
            { value: "horizontal", label: t("plan.graphDirectionHorizontal") },
            { value: "vertical", label: t("plan.graphDirectionVertical") },
          ]}
        />
        <div className="plan-flowchart-zoom-controls">
          <TooltipButton
            type="button"
            tooltip={t("plan.graphZoomOut")}
            ariaLabel={t("plan.graphZoomOut")}
            disabled={zoom <= 0.4}
            onClick={handleZoomOut}
          >
            <IconMinus size={12} aria-hidden />
          </TooltipButton>
          <button
            type="button"
            className="plan-flowchart-fit-btn"
            onClick={handleFit}
            title={t("plan.graphFit")}
          >
            {zoom === 1 ? t("plan.graphFit") : `${Math.round(zoom * 100)}%`}
          </button>
          <TooltipButton
            type="button"
            tooltip={t("plan.graphZoomIn")}
            ariaLabel={t("plan.graphZoomIn")}
            disabled={zoom >= 2}
            onClick={handleZoomIn}
          >
            <IconPlus size={12} aria-hidden />
          </TooltipButton>
        </div>
      </div>
      <div className="plan-flowchart-scroll">
        <div
          className={cx(
            "plan-flowchart-canvas",
            effectiveDirection === "vertical" && "plan-flowchart-canvas--vertical",
            effectiveDirection === "horizontal" && containerWidth > 0 && containerWidth / layout.width < 0.75 && "plan-flowchart-canvas--horizontal-scroll",
          )}
          style={{
            maxWidth: effectiveDirection === "vertical" ? undefined : `${layout.width}px`,
            width: effectiveDirection === "vertical"
              ? undefined
              : containerWidth > 0 && containerWidth / layout.width < 0.75
                ? `${layout.width}px`
                : undefined,
            transform: zoom !== 1 ? `scale(${zoom})` : undefined,
            transformOrigin: "top left",
          }}
        >
          <svg
            data-testid="plan-flowchart"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={t("plan.graphSummary", {
              count: steps.length,
              stages: layout.layers.length,
            })}
          >
            <defs>
              <marker
                id={markerId}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="plan-flow-arrow" />
              </marker>
            </defs>
            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}->${edge.to}`}
                data-testid="plan-flowchart-edge"
                d={edge.path}
                className={cx(
                  "plan-flow-edge",
                  active !== null &&
                    (edge.from === active || edge.to === active) &&
                    "is-active",
                )}
                markerEnd={`url(#${markerId})`}
              />
            ))}
            {layout.nodes.map((node) => {
              const step = stepById.get(node.stepId);
              const title = step?.title.trim() || t("plan.untitledStep");
              const status = statusByStepId.get(node.stepId);
              const shown = !status || status === "unknown" ? "pending" : status;
              const label = progress ? statusText(shown) : undefined;
              return (
                <g
                  key={node.stepId}
                  data-testid="plan-flowchart-node"
                  data-step-id={node.stepId}
                  data-status={shown}
                  transform={`translate(${node.x},${node.y})`}
                  className={cx("plan-flow-node", progress && `plan-flow-node--${shown}`)}
                  tabIndex={0}
                  aria-label={`${node.index + 1}. ${title}${label ? ` — ${label}` : ""}`}
                  onMouseEnter={() => setActive(node.stepId)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(node.stepId)}
                  onBlur={() => setActive(null)}
                >
                  <title>{title}</title>
                  <rect
                    className="plan-flow-node-rect"
                    width={node.width}
                    height={node.height}
                    rx={8}
                  />
                  <rect
                    className="plan-flow-node-bar"
                    width={4}
                    height={node.height - 16}
                    x={0}
                    y={8}
                    rx={2}
                  />
                  <text x={14} y={node.height / 2} dominantBaseline="central">
                    {truncatePlanFlowTitle(`${node.index + 1}. ${title}`, budget)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <ol className="plan-flowchart-fallback">
          {steps.map((step, index) => {
            const status = statusByStepId.get(step.id);
            const label = progress ? statusText(!status || status === "unknown" ? "pending" : status) : undefined;
            return (
              <li key={step.id}>
                {index + 1}. {step.title.trim() || t("plan.untitledStep")}
                {label ? ` — ${label}` : ""}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
