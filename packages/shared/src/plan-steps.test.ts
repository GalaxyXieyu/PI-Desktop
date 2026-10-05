import { describe, expect, it } from "vitest";
import {
  isPlanStepId, newPlanStepId, PLAN_STEPS_JSON_MAX_BYTES, planStepsEqual,
  planStepTopoLayers, planStepWouldCreateCycle, validatePlanSteps, type PlanStep,
} from "./plan-steps.js";
import { effectivePlanSteps } from "./types/plans.js";

const step = (id = "a", dependsOn: string[] = []): PlanStep => ({ id, title: id, dependsOn });

function rejected(value: unknown, path: string, reason?: string) {
  const result = validatePlanSteps(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected validation failure");
  expect(result.code).toBe("PLAN_STEPS_INVALID");
  expect(result.path).toBe(path);
  expect(result.message).toMatch(`PLAN_STEPS_INVALID ${path}: `);
  if (reason) expect(result.message).toContain(reason);
}

describe("validatePlanSteps", () => {
  it("normalizes without mutating input and preserves Unicode characters", () => {
    const input = [{ id: " a ", title: ` ${"😀".repeat(200)} `, detail: "  \n " }, { id: "b", title: " B ", detail: " line one\nline two ", dependsOn: [" a "] }];
    const original = structuredClone(input);
    expect(validatePlanSteps(input)).toEqual({ ok: true, value: [
      { id: "a", title: "😀".repeat(200), dependsOn: [] },
      { id: "b", title: "B", detail: "line one\nline two", dependsOn: ["a"] },
    ] });
    expect(input).toEqual(original);
    expect(validatePlanSteps([])).toEqual({ ok: true, value: [] });
  });

  it.each([
    [null, "steps"], [{}, "steps"], [[null], "steps[0]"], [[[]], "steps[0]"],
    [[{ ...step(), extra: true }], "steps[0].extra"],
    ...[undefined, null, 1, "", " ", "-abc", "a b", "a/b", "a".repeat(65)].map((id) => [[{ ...step(), id }], "steps[0].id"]),
    [[step(), step(" a ")], "steps[1].id"],
    ...[undefined, 2, " ", "x".repeat(201), "x\ny", "x\ty", "x\0y", "x\u007Fy"].map((title) => [[{ ...step(), title }], "steps[0].title"]),
    ...[null, 2, "x".repeat(2001), "x\0y"].map((detail) => [[{ ...step(), detail }], "steps[0].detail"]),
    ...[null, "a", Array(25).fill("b")].map((dependsOn) => [[{ ...step(), dependsOn }], "steps[0].dependsOn"]),
    [[step("a", ["missing"])], "steps[0].dependsOn[0]"],
    [[step("a", ["a"])], "steps[0].dependsOn[0]"],
    [[step("a", ["b", " b "]), step("b")], "steps[0].dependsOn[1]"],
    [[{ ...step(), dependsOn: [1] }], "steps[0].dependsOn[0]"],
    [[step("a", ["bad id"])], "steps[0].dependsOn[0]"],
    [Array.from({ length: 25 }, (_, i) => step(`s${i}`)), "steps"],
  ] as [unknown, string][])("rejects invalid input %#", (value, path) => rejected(value, path));

  it("allows boundary lengths and case-sensitive IDs", () => {
    expect(validatePlanSteps([{ ...step("a".repeat(64)), title: "x".repeat(200), detail: "😀".repeat(2000) }]).ok).toBe(true);
    expect(validatePlanSteps([step("a"), step("A", ["a"])]).ok).toBe(true);
    expect(validatePlanSteps(Array.from({ length: 24 }, (_, i) => step(`s${i}`))).ok).toBe(true);
  });

  it("names the cycle path and offending dependency for two and three nodes", () => {
    rejected([step("a", ["b"]), step("b", ["a"])], "steps[1].dependsOn[0]", "a -> b -> a");
    rejected([step("a", ["b"]), step("b", ["c"]), step("c", ["a"])], "steps[2].dependsOn[0]", "a -> b -> c -> a");
  });

  it("enforces the UTF-8 byte cap on normalized steps, not the raw input", () => {
    const unicode = Array.from({ length: 24 }, (_, i) => ({ ...step(`s${i}`), detail: "😀".repeat(1000) }));
    expect(JSON.stringify(unicode).length).toBeLessThan(PLAN_STEPS_JSON_MAX_BYTES);
    rejected(unicode, "steps", "bytes");
    const padded = [{ id: "a", title: "a", detail: " ".repeat(PLAN_STEPS_JSON_MAX_BYTES) }];
    expect(new TextEncoder().encode(JSON.stringify(padded)).byteLength).toBeGreaterThan(PLAN_STEPS_JSON_MAX_BYTES);
    expect(validatePlanSteps(padded)).toEqual({ ok: true, value: [step("a")] });
    const base = Array.from({ length: 24 }, (_, i) => ({ id: `s${i}`, title: "a", detail: "é".repeat(1300) }));
    const padding = PLAN_STEPS_JSON_MAX_BYTES - new TextEncoder().encode(JSON.stringify(base)).byteLength;
    base[0].detail += " ".repeat(padding);
    expect(new TextEncoder().encode(JSON.stringify(base)).byteLength).toBe(PLAN_STEPS_JSON_MAX_BYTES);
    expect(validatePlanSteps(base).ok).toBe(true);
    base[0].detail += " ";
    expect(validatePlanSteps(base).ok).toBe(true);
    const expanded = Array.from({ length: 24 }, (_, i) => ({ id: `s${i}`, title: "a", detail: "é".repeat(1346) }));
    expect(new TextEncoder().encode(JSON.stringify(expanded)).byteLength).toBeLessThan(PLAN_STEPS_JSON_MAX_BYTES);
    rejected(expanded, "steps", "bytes");
  });
});

describe("plan step graph helpers", () => {
  it("layers a diamond and keeps input order within every layer", () => {
    expect(planStepTopoLayers([step("d", ["b", "c"]), step("c", ["a"]), step("a"), step("b", ["a"])])).toEqual([["a"], ["c", "b"], ["d"]]);
  });
  it("layers independent chains stably", () => {
    expect(planStepTopoLayers([step("b2", ["b1"]), step("a2", ["a1"]), step("a1"), step("b1"), step("c")])).toEqual([["a1", "b1", "c"], ["b2", "a2"]]);
    expect(planStepTopoLayers([])).toEqual([]);
  });
  it("detects direct, indirect and self cycles without rejecting safe edges", () => {
    const steps = [step("a"), step("b", ["a"]), step("c", ["b"]), step("d")];
    expect(planStepWouldCreateCycle(steps, "a", "b")).toBe(true);
    expect(planStepWouldCreateCycle(steps, "a", "c")).toBe(true);
    expect(planStepWouldCreateCycle(steps, "a", "a")).toBe(true);
    expect(planStepWouldCreateCycle(steps, "c", "a")).toBe(false);
    expect(planStepWouldCreateCycle(steps, "d", "c")).toBe(false);
    expect(planStepWouldCreateCycle(steps, "b", "a")).toBe(false);
  });
  it("generates fixed-width base36 IDs with injectable randomness", () => {
    expect(newPlanStepId(() => 0)).toBe("step-00000000");
    expect(newPlanStepId(() => 1 - Number.EPSILON)).toBe("step-zzzzzzzz");
    let n = 0;
    expect(newPlanStepId(() => n++ / 36)).toBe("step-01234567");
    expect(newPlanStepId()).toMatch(/^step-[a-z0-9]{8}$/);
    expect(isPlanStepId("A.b_1-2")).toBe(true);
    expect(isPlanStepId(" a ")).toBe(false);
    expect(isPlanStepId("a\n")).toBe(false);
  });
  it("compares normalized fields and order, not object key order", () => {
    const a = [step("a"), { ...step("b", ["a"]), detail: "detail" }];
    expect(planStepsEqual(a, structuredClone(a))).toBe(true);
    expect(planStepsEqual([step()], [{ dependsOn: [], title: "a", id: "a" }])).toBe(true);
    expect(planStepsEqual(a, a.slice(1))).toBe(false);
    for (const change of [{ id: "z" }, { title: "z" }, { detail: "z" }, { dependsOn: ["b"] }]) {
      expect(planStepsEqual(a, [{ ...a[0], ...change }, a[1]])).toBe(false);
    }
    expect(planStepsEqual([step("c", ["a", "b"])], [step("c", ["b", "a"])])).toBe(false);
  });
  it("selects revisions, including explicit clears, without changing legacy proposals", () => {
    expect(effectivePlanSteps({})).toEqual([]);
    expect(effectivePlanSteps({ steps: [] })).toEqual([]);
    expect(effectivePlanSteps({ steps: [step()] })).toEqual([step()]);
    expect(effectivePlanSteps({ steps: [step()], resolvedSteps: [] })).toEqual([]);
    expect(effectivePlanSteps({ steps: [step()], resolvedSteps: [step("b")] })).toEqual([step("b")]);
  });
});
