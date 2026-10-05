import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  GlobalPermissionMode,
  PlanProposal,
  ProposalKind,
} from "@pi-desktop/shared";
import { buildApproveRequest, type PlanRevision } from "../../features/plan/plan-draft-model";
import { useAppStore } from "../../stores/app-store";
import { PLAN_APPROVAL_DEFAULT_MODE } from "../../lib/plan-mode-state";
import {
  readPlanApprovalMode,
  rememberPlanApprovalMode,
} from "../../lib/plan-approval-preferences";
import { IconCheck, IconChevronDown } from "../icons";
import { TooltipButton } from "../ui";
import { AnchoredMenu } from "../settings/AnchoredMenu";

const APPROVAL_MODES: readonly GlobalPermissionMode[] = [
  "ask",
  "accept-edits",
  "auto",
];

const APPROVAL_MODE_LABELS: Record<GlobalPermissionMode, string> = {
  ask: "ask",
  "accept-edits": "acceptEdits",
  auto: "auto",
};

const APPROVE_LABELS: Record<GlobalPermissionMode, string> = {
  ask: "approveAsk",
  "accept-edits": "approveAcceptEdits",
  auto: "approveAuto",
};

function isApprovalMode(value: string | undefined): value is GlobalPermissionMode {
  return value === "ask" || value === "accept-edits" || value === "auto";
}

/** `plan.reject` or `goal.reject`, chosen by the approved contract kind. */
function copyKey(kind: ProposalKind, name: string): string {
  return `${kind}.${name}`;
}

export type PlanBuildControlsProps = {
  proposal: PlanProposal;
  /** Draft revision for the approve request; omitted for Goal and remote. */
  revision?: PlanRevision;
  /** Draft validation error; Build is disabled while it is set. */
  disabledReason?: string;
  /** `bar` keeps the kind-specific approve labels; `tab` shows "Build". */
  variant: "bar" | "tab";
};

/**
 * The shared Reject + Build split-button used by the approval bar and the
 * plan tab header. The approval mode is remembered across proposals; the
 * approve request carries the draft revision inline, so there is no separate
 * save step to race the build.
 */
export function PlanBuildControls({
  proposal,
  revision,
  disabledReason,
  variant,
}: PlanBuildControlsProps) {
  const { t } = useTranslation();
  const resolvePlan = useAppStore((state) => state.resolvePlan);
  const showToast = useAppStore((state) => state.showToast);
  const [menuOpen, setMenuOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [approvalMode, setApprovalMode] = useState<GlobalPermissionMode>(
    readPlanApprovalMode(),
  );
  const kind: ProposalKind = proposal.kind === "goal" ? "goal" : "plan";
  const copy = (name: string) => t(copyKey(kind, name));
  const isPending = proposal.status === "pending";
  const busy = resolving;
  const buildBlocked = !!disabledReason;
  const errorId = `plan-build-error-${proposal.id}`;

  useEffect(() => {
    setApprovalMode(readPlanApprovalMode());
    setMenuOpen(false);
  }, [proposal.id]);

  useEffect(() => {
    setResolving(false);
  }, [proposal.id]);

  const focusComposer = () => {
    if (useAppStore.getState().activeSessionId !== proposal.sessionId) return;
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
    });
  };

  const resolve = async (
    action: "approve" | "reject",
    targetPermissionMode?: GlobalPermissionMode,
  ) => {
    if (busy || !isPending) return;
    if (action === "approve" && buildBlocked) return;
    setMenuOpen(false);
    if (action === "approve") {
      const selectedMode = targetPermissionMode ?? PLAN_APPROVAL_DEFAULT_MODE;
      setApprovalMode(selectedMode);
      rememberPlanApprovalMode(selectedMode);
    }
    setResolving(true);
    try {
      const identity = {
        proposalId: proposal.id,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        toolCallId: proposal.toolCallId,
        version: proposal.version,
      };
      await resolvePlan(
        action === "approve"
          ? buildApproveRequest(
              proposal,
              targetPermissionMode ?? PLAN_APPROVAL_DEFAULT_MODE,
              revision,
            )
          : { ...identity, action },
      );
      focusComposer();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
      setResolving(false);
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const target = event.target as HTMLElement;
      const mode = target.closest<HTMLButtonElement>(
        '[data-approval-mode]',
      )?.dataset.approvalMode;
      if (isApprovalMode(mode)) {
        event.preventDefault();
        setApprovalMode(mode);
        void resolve("approve", mode);
      }
      return;
    }
    if (!(["ArrowDown", "ArrowUp", "Home", "End"] as string[]).includes(event.key)) {
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ) ?? [],
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") {
      next = current < 0 ? 0 : (current + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    }
    items[next]?.focus();
  };

  if (!isPending) return null;

  const mainLabel = variant === "tab"
    ? t("plan.build")
    : copy(APPROVE_LABELS[approvalMode]);

  return (
    <>
      <button
        type="button"
        className="plan-approval-reject"
        data-testid={variant === "tab" ? "plan-tab-reject" : undefined}
        disabled={busy}
        onClick={() => void resolve("reject")}
      >
        {copy("reject")}
      </button>
      <AnchoredMenu
        className="plan-approval-split"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        menuClassName="plan-approval-menu"
        label={copy("chooseApprovalMode")}
        role="menu"
        align="end"
        onMenuKeyDown={onMenuKeyDown}
        trigger={(ref) => (
          <>
            <button
              type="button"
              className="plan-approval-approve-main"
              data-testid={variant === "tab" ? "plan-tab-build" : undefined}
              disabled={busy || buildBlocked}
              aria-label={mainLabel}
              aria-describedby={buildBlocked ? errorId : undefined}
              onClick={() => void resolve("approve", approvalMode)}
            >
              {resolving ? copy("approving") : mainLabel}
            </button>
            <TooltipButton
              ref={ref}
              type="button"
              className="plan-approval-approve-menu"
              disabled={busy || buildBlocked}
              ariaLabel={copy("chooseApprovalMode")}
              tooltip={copy("chooseApprovalMode")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <IconChevronDown size={13} aria-hidden />
            </TooltipButton>
          </>
        )}
      >
        {APPROVAL_MODES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="plan-approval-menu-item"
            role="menuitemradio"
            aria-checked={approvalMode === candidate}
            data-approval-mode={candidate}
            disabled={busy}
            onClick={() => {
              setApprovalMode(candidate);
              void resolve("approve", candidate);
            }}
          >
            <span>{copy(APPROVAL_MODE_LABELS[candidate])}</span>
            {approvalMode === candidate ? (
              <IconCheck size={13} aria-hidden />
            ) : null}
          </button>
        ))}
      </AnchoredMenu>
      {buildBlocked ? (
        <p className="plan-build-error" id={errorId} role="alert">
          {disabledReason}
        </p>
      ) : null}
    </>
  );
}
