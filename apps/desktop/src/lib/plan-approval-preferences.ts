import type { GlobalPermissionMode, PlanTargetModel } from "@pi-desktop/shared";

export const PLAN_APPROVAL_MODE_STORAGE_KEY = "pi.desktop.planApprovalMode";
export const PLAN_EXECUTION_MODEL_STORAGE_KEY = "pi.desktop.planExecutionModel";
export const PLAN_APPROVAL_FALLBACK_MODE: GlobalPermissionMode = "ask";

function isApprovalMode(value: unknown): value is GlobalPermissionMode {
  return value === "ask" || value === "accept-edits" || value === "auto";
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

export function readPlanApprovalMode(): GlobalPermissionMode {
  const store = storage();
  if (!store) return PLAN_APPROVAL_FALLBACK_MODE;
  try {
    const value = store.getItem(PLAN_APPROVAL_MODE_STORAGE_KEY);
    return isApprovalMode(value) ? value : PLAN_APPROVAL_FALLBACK_MODE;
  } catch {
    return PLAN_APPROVAL_FALLBACK_MODE;
  }
}

export function rememberPlanApprovalMode(mode: GlobalPermissionMode): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PLAN_APPROVAL_MODE_STORAGE_KEY, mode);
  } catch {
    // A blocked or full localStorage must not prevent approval.
  }
}

/** The remembered execution model; `null` keeps the session's own model. */
export function readPlanExecutionModel(): PlanTargetModel | null {
  try {
    const value: unknown = JSON.parse(storage()?.getItem(PLAN_EXECUTION_MODEL_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { providerId, modelId } = value as Record<string, unknown>;
    return typeof providerId === "string" && typeof modelId === "string"
      ? { providerId, modelId }
      : null;
  } catch {
    return null;
  }
}

export function rememberPlanExecutionModel(model: PlanTargetModel | null): void {
  try {
    if (model) storage()?.setItem(PLAN_EXECUTION_MODEL_STORAGE_KEY, JSON.stringify(model));
    else storage()?.removeItem(PLAN_EXECUTION_MODEL_STORAGE_KEY);
  } catch {
    // A blocked or full localStorage must not prevent approval.
  }
}
