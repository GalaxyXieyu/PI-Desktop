import { describe, expect, it } from "vitest";
import {
  isPlanDesignEmpty, PLAN_COLOR_GROUPS, PLAN_DESIGN_JSON_MAX_BYTES,
  PLAN_FONT_FAMILY_PRESETS, PLAN_FONT_SIZE_OPTIONS, PLAN_FONT_WEIGHT_OPTIONS,
  planDesignEqual, validatePlanDesign, type PlanDesignSpec,
} from "./plan-design.js";
import { effectivePlanDesign, effectivePlanSteps, type PlanResolveRequest } from "./types/plans.js";
import { validatePlanSteps } from "./plan-steps.js";

function rejected(value: unknown, path: string, reason?: string) {
  const result = validatePlanDesign(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected validation failure");
  expect(result.code).toBe("PLAN_DESIGN_INVALID");
  expect(result.path).toBe(path);
  expect(result.message).toMatch(`PLAN_DESIGN_INVALID ${path}: `);
  if (reason) expect(result.message).toContain(reason);
}
const font = (size: unknown = "16px", weight: unknown = 400) => ({ fontSystem: { fontFamily: "Inter", body: { size, weight } } });

describe("validatePlanDesign", () => {
  it("normalizes a complete design without changing input", () => {
    const input = { framework: " React ", componentLibrary: " MUI ", styleKeywords: [" Minimal ", " Calm "],
      fontSystem: { fontFamily: " Inter ", heading: { size: "32px", weight: 700 }, subheading: { size: "24px", weight: 500 }, body: { size: "16px", weight: 400 } },
      colorSystem: { primary: ["#abcdef"], background: ["#ffffff"], text: ["#000000"], functional: ["#aAbBcC"] } };
    const original = structuredClone(input);
    expect(validatePlanDesign(input)).toEqual({ ok: true, value: { ...input, framework: "react", componentLibrary: "mui", styleKeywords: ["Minimal", "Calm"],
      fontSystem: { ...input.fontSystem, fontFamily: "Inter" },
      colorSystem: { primary: ["#ABCDEF"], background: ["#FFFFFF"], text: ["#000000"], functional: ["#AABBCC"] } } });
    expect(input).toEqual(original);
  });
  it("normalizes absent slugs to an empty design and accepts free slugs", () => {
    expect(validatePlanDesign({ framework: "", componentLibrary: "  " })).toEqual({ ok: true, value: {} });
    expect(validatePlanDesign({})).toEqual({ ok: true, value: {} });
    expect(validatePlanDesign({ framework: " Custom/V1.0+App_Name ", componentLibrary: "x".repeat(40) })).toEqual({ ok: true, value: { framework: "custom/v1.0+app_name", componentLibrary: "x".repeat(40) } });
  });
  it("drops empty collections like the Rust authority", () => {
    expect(validatePlanDesign({ styleKeywords: [] })).toEqual({ ok: true, value: {} });
    expect(validatePlanDesign({ styleKeywords: [], colorSystem: {} })).toEqual({ ok: true, value: {} });
    expect(validatePlanDesign({ colorSystem: { primary: [], background: [] } })).toEqual({ ok: true, value: {} });
    expect(validatePlanDesign({ colorSystem: { primary: ["#aAbBcC"], background: [] } })).toEqual({ ok: true, value: { colorSystem: { primary: ["#AABBCC"] } } });
  });
  it.each(["rgba(0,0,0,1)", "#abc", "red", " #abcdef ", "#ABCDEG", "#12345678", "#123456\n", 123, null])("rejects non-hex color %s with actionable syntax", (color) => {
    rejected({ colorSystem: { primary: ["#000000", color] } }, "design.colorSystem.primary[1]", "use #RRGGBB");
  });
  it.each([
    [null, "design"], [[], "design"], ["", "design"], [{ extra: true }, "design.extra"],
    ...["framework", "componentLibrary"].flatMap((key) => [null, 1, "x".repeat(41), "a b", "-bad", "a\nb"].map((v) => [{ [key]: v }, `design.${key}`])),
    ...[null, "calm", Array(13).fill("calm")].map((styleKeywords) => [{ styleKeywords }, "design.styleKeywords"]),
    ...["", " ", "x".repeat(41), "a\nb", "a\0b", "a\u007Fb", 1].map((keyword) => [{ styleKeywords: [keyword] }, "design.styleKeywords[0]"]),
    [{ styleKeywords: ["Calm", " calm "] }, "design.styleKeywords[1]"],
    [{ fontSystem: null }, "design.fontSystem"], [{ fontSystem: [] }, "design.fontSystem"],
    [{ fontSystem: { fontFamily: "Inter", extra: 1 } }, "design.fontSystem.extra"],
    ...[undefined, null, "", " ", "x".repeat(121), "a\tb", "a\u007Fb"].map((fontFamily) => [{ fontSystem: { fontFamily } }, "design.fontSystem.fontFamily"]),
    [{ fontSystem: { fontFamily: "Inter", body: null } }, "design.fontSystem.body"],
    [{ fontSystem: { fontFamily: "Inter", body: { size: "16px", weight: 400, extra: 1 } } }, "design.fontSystem.body.extra"],
    ...["9px", "73px", "16", "16pt", "016px", "16.5px", " 16px ", "16px\n", 16, null].map((size) => [font(size), "design.fontSystem.body.size"]),
    ...[150, 1000, 0, 400.5, "400", null].map((weight) => [font("16px", weight), "design.fontSystem.body.weight"]),
    [{ colorSystem: [] }, "design.colorSystem"], [{ colorSystem: null }, "design.colorSystem"],
    [{ colorSystem: { other: [] } }, "design.colorSystem.other"],
    ...PLAN_COLOR_GROUPS.flatMap((group) => [null, "#123456", Array(9).fill("#123456")].map((colors) => [{ colorSystem: { [group]: colors } }, `design.colorSystem.${group}`])),
  ] as [unknown, string][])("rejects invalid design %#", (value, path) => rejected(value, path));
  it("accepts every boundary and the editor presets", () => {
    for (const size of ["10px", "72px", ...PLAN_FONT_SIZE_OPTIONS]) {
      for (const weight of PLAN_FONT_WEIGHT_OPTIONS) expect(validatePlanDesign(font(size, weight)).ok).toBe(true);
    }
    for (const preset of PLAN_FONT_FAMILY_PRESETS) expect(validatePlanDesign({ fontSystem: { fontFamily: preset.value } }).ok).toBe(true);
    expect(validatePlanDesign({ fontSystem: { fontFamily: "😀".repeat(120) }, styleKeywords: Array.from({ length: 12 }, (_, i) => `${i}${"😀".repeat(38)}`), colorSystem: { primary: Array(8).fill("#123456") } }).ok).toBe(true);
  });
  it("caps the normalized JSON, not the raw input, like the Rust authority", () => {
    const input = { framework: "x" + " ".repeat(PLAN_DESIGN_JSON_MAX_BYTES - 17) };
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(PLAN_DESIGN_JSON_MAX_BYTES);
    expect(validatePlanDesign(input)).toEqual({ ok: true, value: { framework: "x" } });
    expect(validatePlanDesign({ framework: input.framework + " " })).toEqual({ ok: true, value: { framework: "x" } });
    const unicode = { framework: "\u3000".repeat(6000) };
    expect(new TextEncoder().encode(JSON.stringify(unicode)).byteLength).toBeGreaterThan(PLAN_DESIGN_JSON_MAX_BYTES);
    expect(validatePlanDesign(unicode)).toEqual({ ok: true, value: {} });
  });
});

describe("design equality and effective approval contracts", () => {
  it("detects empty designs, including empty containers", () => {
    for (const spec of [{}, { styleKeywords: [] }, { colorSystem: {} }, { colorSystem: { primary: [] } }]) expect(isPlanDesignEmpty(spec)).toBe(true);
    for (const spec of [{ framework: "react" }, { componentLibrary: "mui" }, { styleKeywords: ["calm"] }, { fontSystem: { fontFamily: "Inter" } }, { colorSystem: { text: ["#FFFFFF"] } }]) expect(isPlanDesignEmpty(spec)).toBe(false);
  });
  it("compares normalized designs regardless of key insertion order, treating empty collections as absent", () => {
    const a: PlanDesignSpec = { framework: "react", componentLibrary: "mui", styleKeywords: ["calm", "clean"], fontSystem: { fontFamily: "Inter", body: { size: "16px", weight: 400 } }, colorSystem: { primary: ["#FFFFFF"] } };
    expect(planDesignEqual(a, structuredClone(a))).toBe(true);
    expect(planDesignEqual({ framework: "react", componentLibrary: "mui" }, { componentLibrary: "mui", framework: "react" })).toBe(true);
    const changes: PlanDesignSpec[] = [
      { framework: "vue" }, { componentLibrary: "antd" }, { styleKeywords: ["clean", "calm"] }, { styleKeywords: undefined },
      { fontSystem: undefined }, { fontSystem: { fontFamily: "Arial" } },
      { fontSystem: { fontFamily: "Inter", body: { size: "18px", weight: 400 } } },
      { fontSystem: { fontFamily: "Inter", body: { size: "16px", weight: 500 } } },
      { colorSystem: undefined }, { colorSystem: { primary: ["#000000"] } },
    ];
    for (const change of changes) expect(planDesignEqual(a, { ...a, ...change })).toBe(false);
    expect(planDesignEqual({}, { styleKeywords: [] })).toBe(true);
    expect(planDesignEqual({}, { colorSystem: {} })).toBe(true);
    expect(planDesignEqual({ colorSystem: { primary: ["#FFFFFF"] } }, { colorSystem: { primary: ["#FFFFFF"], background: [] } })).toBe(true);
  });
  it("distinguishes omitted revision from an explicit clear", () => {
    const design = { framework: "react" };
    expect(effectivePlanDesign({})).toBeUndefined();
    expect(effectivePlanDesign({ design: {} })).toBeUndefined();
    expect(effectivePlanDesign({ design })).toEqual(design);
    expect(effectivePlanDesign({ design, resolvedDesign: {} })).toBeUndefined();
    expect(effectivePlanDesign({ design, resolvedDesign: { framework: "vue" } })).toEqual({ framework: "vue" });
  });
  it("carries validated edits through an approval request to the effective contract", () => {
    const steps = validatePlanSteps([{ id: " setup ", title: " Set up " }]);
    const design = validatePlanDesign({ framework: " React ", colorSystem: { primary: ["#abcdef"] } });
    if (!steps.ok || !design.ok) throw new Error("Expected valid metadata");
    const request: PlanResolveRequest = { sessionId: "session", proposalId: "proposal", turnId: "turn", toolCallId: "tool", action: "approve", targetPermissionMode: "ask", revisedSteps: steps.value, revisedDesign: design.value };
    const stored = { steps: [{ id: "old", title: "Old", dependsOn: [] }], design: { framework: "vue" }, resolvedSteps: request.revisedSteps, resolvedDesign: request.revisedDesign };
    expect(effectivePlanSteps(stored)).toEqual([{ id: "setup", title: "Set up", dependsOn: [] }]);
    expect(effectivePlanDesign(stored)).toEqual({ framework: "react", colorSystem: { primary: ["#ABCDEF"] } });
    expect(effectivePlanSteps({ ...stored, resolvedSteps: [] })).toEqual([]);
    expect(effectivePlanDesign({ ...stored, resolvedDesign: {} })).toBeUndefined();
  });
});
