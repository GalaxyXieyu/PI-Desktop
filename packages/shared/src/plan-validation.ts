export type PlanValidationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "PLAN_STEPS_INVALID" | "PLAN_DESIGN_INVALID";
      path: string;
      message: string;
    };

type ValidationError = Extract<PlanValidationResult<never>, { ok: false }>;

export function planValidationError(
  code: ValidationError["code"],
  path: string,
  reason: string,
): ValidationError {
  return { ok: false, code, path, message: `${code} ${path}: ${reason}` };
}

export function isPlanRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function planJsonLimitError(
  value: unknown,
  limit: number,
  code: ValidationError["code"],
  path: string,
): ValidationError | undefined {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return planValidationError(code, path, "expected JSON data");
    if (new TextEncoder().encode(json).byteLength > limit) {
      return planValidationError(code, path, `serialized JSON must not exceed ${limit} bytes`);
    }
  } catch {
    return planValidationError(code, path, "expected serializable JSON data");
  }
  return undefined;
}

export const PLAN_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

export function planUnknownKey(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !keys.includes(key));
}
