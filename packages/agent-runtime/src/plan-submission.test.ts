import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { parseSubmitArguments, submitFailureResult, submitToolParameters } from "./plan-submission.js";

const legacy = { title: " Plan ", markdown: "  # Plan\n\nExact bytes.  \n", question: " Proceed? " };

describe("plan submission", () => {
  it("keeps the previous Goal schema JSON exactly", () => {
    const previous = Type.Object({
      title: Type.String({ description: "A concise title naming the goal." }),
      markdown: Type.String({ description: "The exact Markdown goal contract, with a Goal section, an Acceptance criteria section of objectively checkable items, and a Boundaries section. Describe outcomes, not implementation steps." }),
      question: Type.String({ description: "The question or decision the user should answer when approving this goal contract." }),
    });
    expect(JSON.stringify(submitToolParameters("goal"))).toBe(JSON.stringify(previous));
  });

  it.each(["plan", "goal"] as const)("preserves legacy %s arguments exactly", (kind) => {
    expect(parseSubmitArguments(kind, legacy)).toEqual({
      ok: true, title: "Plan", markdown: legacy.markdown, question: "Proceed?",
    });
  });

  it("normalizes structured steps and design", () => {
    expect(parseSubmitArguments("plan", {
      ...legacy,
      steps: [
        { id: " first ", title: " First ", detail: "  " },
        { id: "second", title: "Second", detail: " Detail ", dependsOn: [" first "] },
      ],
      design: {
        framework: " React ", componentLibrary: " MUI ", styleKeywords: [" Minimal "],
        fontSystem: { fontFamily: " Inter ", body: { size: "16px", weight: 400 } },
        colorSystem: { primary: ["#aabbcc"] },
      },
    })).toEqual({
      ok: true, title: "Plan", markdown: legacy.markdown, question: "Proceed?",
      steps: [
        { id: "first", title: "First", dependsOn: [] },
        { id: "second", title: "Second", detail: "Detail", dependsOn: ["first"] },
      ],
      design: {
        framework: "react", componentLibrary: "mui", styleKeywords: ["Minimal"],
        fontSystem: { fontFamily: "Inter", body: { size: "16px", weight: 400 } },
        colorSystem: { primary: ["#AABBCC"] },
      },
    });
  });

  it.each([{}, { framework: " ", componentLibrary: "" }])("omits empty metadata: %j", (design) => {
    expect(parseSubmitArguments("plan", { ...legacy, steps: [], design }))
      .toEqual(parseSubmitArguments("plan", legacy));
  });

  it.each(["plan", "goal"] as const)("treats null steps and design as absent for %s", (kind) => {
    expect(parseSubmitArguments(kind, { ...legacy, steps: null, design: null }))
      .toEqual(parseSubmitArguments(kind, legacy));
  });

  it.each([
    { steps: [{ id: "a", title: "A", dependsOn: ["b"] }, { id: "b", title: "B", dependsOn: ["a"] }], code: "PLAN_STEPS_INVALID", text: "cycle:" },
    { design: { colorSystem: { primary: ["red"] } }, code: "PLAN_DESIGN_INVALID", text: "use #RRGGBB" },
  ])("returns a recoverable validator error for $code", ({ code, text, ...metadata }) => {
    const parsed = parseSubmitArguments("plan", { ...legacy, ...metadata });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("Expected validation failure");
    expect(parsed.result).toMatchObject({
      isError: true, details: { errorCode: code },
      content: [{ type: "text", text: expect.stringContaining(text) }],
    });
    expect(parsed.result).not.toHaveProperty("terminate");
    expect(parsed.result.content[0]).toMatchObject({ text: expect.stringContaining(" Fix the structured field and call SubmitPlan again with the complete snapshot. No approval was created.") });
  });

  it.each([{ steps: [] }, { design: {} }])("rejects Goal metadata even when empty: %j", (metadata) => {
    const parsed = parseSubmitArguments("goal", { ...legacy, ...metadata });
    expect(parsed).toMatchObject({ ok: false, result: { isError: true, details: { errorCode: "PLAN_METADATA_UNSUPPORTED" } } });
    if (!parsed.ok) expect(parsed.result).not.toHaveProperty("terminate");
  });

  it.each(["PLAN_STEPS_INVALID", "PLAN_DESIGN_INVALID", "PLAN_METADATA_UNSUPPORTED"])("recovers from host %s with its message", (errorCode) => {
    const result = submitFailureResult("plan", Object.assign(new Error("host validation detail"), { data: { errorCode } }));
    expect(result).toMatchObject({ isError: true, details: { errorCode }, content: [{ type: "text", text: expect.stringContaining("host validation detail") }] });
    expect(result).not.toHaveProperty("terminate");
  });

  it.each(["plan", "goal"] as const)("preserves generic %s host failures", (kind) => {
    expect(submitFailureResult(kind, new Error("IO failure"))).toEqual({
      content: [{ type: "text", text: `${kind === "plan" ? "Plan" : "Goal"} submission failed: PLAN_SUBMIT_FAILED` }],
      details: { errorCode: "PLAN_SUBMIT_FAILED" }, isError: true, terminate: true,
    });
  });

  it("keeps workspace recovery unchanged", () => {
    const result = submitFailureResult("plan", { data: { errorCode: "PLAN_WORKSPACE_REQUIRED" } });
    expect(result).toMatchObject({ isError: true, details: { errorCode: "PLAN_WORKSPACE_REQUIRED" } });
    expect(result).not.toHaveProperty("terminate");
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("do not retry submission until a workspace is bound") });
  });
});
