import {
  isPlanRecord,
  PLAN_CONTROL_PATTERN,
  planJsonLimitError,
  planUnknownKey,
  planValidationError,
  type PlanValidationResult,
} from "./plan-validation.js";

export type { PlanValidationResult } from "./plan-validation.js";

export type PlanStep = {
  id: string;
  title: string;
  detail?: string;
  dependsOn: string[];
};

export const PLAN_STEPS_MAX = 24;
export const PLAN_STEP_ID_MAX = 64;
export const PLAN_STEP_TITLE_MAX = 200;
export const PLAN_STEP_DETAIL_MAX = 2000;
export const PLAN_STEPS_JSON_MAX_BYTES = 64 * 1024;
export const PLAN_STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Tests a canonical ID; trimming belongs to the input validator. */
export function isPlanStepId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length <= PLAN_STEP_ID_MAX && PLAN_STEP_ID_PATTERN.test(value);
}

export function newPlanStepId(random: () => number = Math.random): string {
  return `step-${Array.from({ length: 8 }, () => Math.floor(random() * 36).toString(36)).join("")}`;
}

const invalid = (path: string, reason: string) => planValidationError("PLAN_STEPS_INVALID", path, reason);

export function validatePlanSteps(value: unknown): PlanValidationResult<PlanStep[]> {
  if (!Array.isArray(value)) return invalid("steps", "expected an array");
  if (value.length > PLAN_STEPS_MAX) return invalid("steps", `must contain at most ${PLAN_STEPS_MAX} steps`);

  const steps: PlanStep[] = [];
  const ids = new Set<string>();
  for (const [index, input] of value.entries()) {
    const path = `steps[${index}]`;
    if (!isPlanRecord(input)) return invalid(path, "expected an object");
    const unknownKey = planUnknownKey(input, ["id", "title", "detail", "dependsOn"]);
    if (unknownKey !== undefined) return invalid(`${path}.${unknownKey}`, "unknown key");
    const id = typeof input.id === "string" ? input.id.trim() : input.id;
    if (!isPlanStepId(id)) return invalid(`${path}.id`, `expected a 1..${PLAN_STEP_ID_MAX} character step ID matching ${PLAN_STEP_ID_PATTERN.source}`);
    if (ids.has(id)) return invalid(`${path}.id`, `duplicate step "${id}"`);
    ids.add(id);
    if (typeof input.title !== "string") return invalid(`${path}.title`, "expected a string");
    const title = input.title.trim();
    if (!title || [...title].length > PLAN_STEP_TITLE_MAX || PLAN_CONTROL_PATTERN.test(title)) {
      return invalid(`${path}.title`, `expected 1..${PLAN_STEP_TITLE_MAX} characters without control characters`);
    }
    let detail: string | undefined;
    if (input.detail !== undefined) {
      if (typeof input.detail !== "string") return invalid(`${path}.detail`, "expected a string");
      detail = input.detail.trim() || undefined;
      if (detail && ([...detail].length > PLAN_STEP_DETAIL_MAX || detail.includes("\0"))) {
        return invalid(`${path}.detail`, `must contain at most ${PLAN_STEP_DETAIL_MAX} characters and no NUL`);
      }
    }
    const dependencies: unknown = input.dependsOn === undefined ? [] : input.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.length > PLAN_STEPS_MAX) {
      return invalid(`${path}.dependsOn`, `expected an array of at most ${PLAN_STEPS_MAX} step IDs`);
    }
    const dependsOn: string[] = [];
    for (const [depIndex, dependency] of dependencies.entries()) {
      const depPath = `${path}.dependsOn[${depIndex}]`;
      const dep = typeof dependency === "string" ? dependency.trim() : dependency;
      if (!isPlanStepId(dep)) return invalid(depPath, "expected a valid step ID");
      if (dep === id) return invalid(depPath, `step "${id}" cannot depend on itself`);
      if (dependsOn.includes(dep)) return invalid(depPath, `duplicate dependency "${dep}" for step "${id}"`);
      dependsOn.push(dep);
    }
    steps.push({ id, title, ...(detail === undefined ? {} : { detail }), dependsOn });
  }

  for (const [index, step] of steps.entries()) {
    for (const [depIndex, dependency] of step.dependsOn.entries()) {
      if (!ids.has(dependency)) return invalid(`steps[${index}].dependsOn[${depIndex}]`, `unknown step "${dependency}" for step "${step.id}"`);
    }
  }
  const byId = new Map(steps.map((step, index) => [step.id, { step, index }]));
  const visited = new Set<string>();
  const stack: string[] = [];
  function visit(id: string): ReturnType<typeof invalid> | undefined {
    if (visited.has(id)) return undefined;
    const entry = byId.get(id);
    if (!entry) return undefined;
    stack.push(id);
    for (const [depIndex, dep] of entry.step.dependsOn.entries()) {
      const cycleStart = stack.indexOf(dep);
      if (cycleStart !== -1) {
        return invalid(`steps[${entry.index}].dependsOn[${depIndex}]`, `cycle: ${[...stack.slice(cycleStart), dep].join(" -> ")}`);
      }
      const error = visit(dep);
      if (error) return error;
    }
    stack.pop();
    visited.add(id);
    return undefined;
  }
  for (const step of steps) {
    const error = visit(step.id);
    if (error) return error;
  }
  // Byte cap on the normalized JSON only, mirroring the Rust authority
  // (crates/host-core/src/plans/metadata/steps.rs byte_cap); the raw input is
  // never capped.
  const normalizedByteError = planJsonLimitError(steps, PLAN_STEPS_JSON_MAX_BYTES, "PLAN_STEPS_INVALID", "steps");
  return normalizedByteError ?? { ok: true, value: steps };
}

/** Kahn layers; each frontier preserves the input order. Input must be validated. */
export function planStepTopoLayers(steps: readonly PlanStep[]): string[][] {
  const remaining = new Map(steps.map((step) => [step.id, step.dependsOn.length]));
  const layers: string[][] = [];
  while (remaining.size) {
    const layer = steps.filter((step) => remaining.get(step.id) === 0).map((step) => step.id);
    if (!layer.length) break;
    layers.push(layer);
    for (const id of layer) remaining.delete(id);
    const completed = new Set(layer);
    for (const step of steps) {
      const count = remaining.get(step.id);
      if (count !== undefined) remaining.set(step.id, count - step.dependsOn.filter((id) => completed.has(id)).length);
    }
  }
  return layers;
}

/** Whether adding stepId -> dependencyId would introduce a cycle. */
export function planStepWouldCreateCycle(steps: readonly PlanStep[], stepId: string, dependencyId: string): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const pending = [dependencyId];
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined) break;
    if (id === stepId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}

/** Deep, order-sensitive equality for normalized steps. */
export function planStepsEqual(a: readonly PlanStep[], b: readonly PlanStep[]): boolean {
  return a.length === b.length && a.every((step, index) => {
    const other = b[index];
    return other !== undefined && step.id === other.id && step.title === other.title && step.detail === other.detail
      && step.dependsOn.length === other.dependsOn.length && step.dependsOn.every((id, i) => id === other.dependsOn[i]);
  });
}
