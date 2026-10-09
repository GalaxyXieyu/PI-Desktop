import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createPlanDraft, planDraftReducer: reduce, planDraftValidation: validate, planDraftRevision: revision, planDraftDirty: dirty } = await import("../src/features/plan/plan-draft-model.ts");
const step = (id, dependsOn = []) => ({ id, title: id, dependsOn });
const proposal = (extra = {}) => ({ sessionId: "s", id: "p", version: 1, status: "pending", steps: [step("a"), step("b", ["a"])], ...extra });
const apply = (draft, type, fields = {}) => reduce(draft, { type, ...fields });

test("draft starts from submitted data, is isolated, and reset restores the base", () => {
  const input = proposal({ design: { framework: "react" }, resolvedSteps: [], resolvedDesign: {} });
  const base = createPlanDraft(input);
  assert.equal(base.key, "s:p:1");
  assert.deepEqual(base.steps, input.steps);
  assert.deepEqual(base.design, input.design);
  assert.notEqual(base.steps, input.steps);
  assert.notEqual(base.steps, base.baseSteps);
  let draft = apply(base, "stepAdd", { id: "c" });
  assert.equal(draft.editingStepId, "c");
  assert.equal(draft.steps[2].title, "");
  assert.equal(apply(draft, "stepAdd", { id: "c" }), draft);
  draft = apply(draft, "stepUpdate", { id: "c", title: "Third", detail: "Notes" });
  assert.deepEqual(draft.steps[2], { id: "c", title: "Third", detail: "Notes", dependsOn: [] });
  draft = apply(draft, "stepUpdate", { id: "c", detail: "More" });
  assert.equal(draft.steps[2].title, "Third");
  draft = apply(draft, "designSetFramework", { value: "vue" });
  const reset = apply(draft, "reset");
  assert.deepEqual(reset.steps, base.steps);
  assert.deepEqual(reset.design, base.design);
  assert.equal(reset.editingStepId, undefined);
  assert.equal(dirty(reset), false);
  assert.deepEqual(input.design, { framework: "react" });
});

test("step dependencies reject cycles and removal cleans every dependent", () => {
  let draft = createPlanDraft(proposal({ steps: [step("a"), step("b", ["a"]), step("c", ["b", "a"])] }));
  assert.equal(apply(draft, "stepSetDependsOn", { id: "a", dependsOn: ["c"] }), draft);
  assert.equal(apply(draft, "stepSetDependsOn", { id: "b", dependsOn: ["b"] }), draft);
  draft = apply(draft, "stepSetDependsOn", { id: "c", dependsOn: ["a"] });
  assert.deepEqual(draft.steps[2].dependsOn, ["a"]);
  draft = apply(draft, "stepRemove", { id: "a" });
  assert.deepEqual(draft.steps.map((s) => s.dependsOn), [[], []]);
  draft = apply(draft, "stepAdd", { id: "d" });
  draft = apply(draft, "stepRemove", { id: "d" });
  assert.equal(draft.editingStepId, undefined);
});

test("step movement preserves dependencies and ignores missing IDs and bounds", () => {
  const base = createPlanDraft(proposal());
  assert.equal(apply(base, "stepMove", { id: "a", direction: "up" }), base);
  assert.equal(apply(base, "stepMove", { id: "b", direction: "down" }), base);
  assert.equal(apply(base, "stepMove", { id: "missing", direction: "down" }), base);
  const moved = apply(base, "stepMove", { id: "a", direction: "down" });
  assert.deepEqual(moved.steps, [step("b", ["a"]), step("a")]);
  assert.deepEqual(apply(moved, "stepMove", { id: "a", direction: "up" }).steps, base.steps);
});

test("design actions preserve other fields and update individual font and color values", () => {
  let draft = createPlanDraft(proposal({ steps: [] }));
  draft = apply(draft, "designAddKeyword", { value: "Minimal" });
  draft = apply(draft, "designAddKeyword", { value: "Calm" });
  draft = apply(draft, "designRemoveKeyword", { index: 0 });
  assert.deepEqual(draft.design.styleKeywords, ["Calm"]);
  draft = apply(draft, "designSetFontLevel", { level: "body", weight: 500 });
  assert.equal(draft.design.fontSystem.body.size, "16px");
  draft = apply(draft, "designSetFontFamily", { value: "Inter" });
  for (const level of ["heading", "subheading", "body"]) {
    draft = apply(draft, "designSetFontLevel", { level, size: "24px" });
    draft = apply(draft, "designSetFontLevel", { level, weight: 600 });
    assert.deepEqual(draft.design.fontSystem[level], { size: "24px", weight: 600 });
  }
  assert.equal(draft.design.fontSystem.fontFamily, "Inter");
  for (const group of ["primary", "background", "text", "functional"]) {
    draft = apply(draft, "designAddColor", { group });
    assert.deepEqual(draft.design.colorSystem[group], ["#000000"]);
    draft = apply(draft, "designSetColor", { group, index: 0, value: "#abcdef" });
    draft = apply(draft, "designAddColor", { group });
    draft = apply(draft, "designRemoveColor", { group, index: 1 });
    assert.deepEqual(draft.design.colorSystem[group], ["#abcdef"]);
  }
  draft = apply(draft, "designSetFramework", { value: " React " });
  draft = apply(draft, "designSetComponentLibrary", { value: "MUI" });
  assert.equal(revision(draft).revisedDesign.framework, "react");
  assert.equal(revision(draft).revisedDesign.componentLibrary, "mui");
  draft = apply(draft, "designSetFramework", { value: undefined });
  draft = apply(draft, "designSetComponentLibrary", { value: undefined });
  assert.equal(revision(draft).revisedDesign.framework, undefined);
  assert.equal(validate(draft), null);
});

test("validation reports the first offending path, including empty titles and invalid colors", () => {
  let draft = createPlanDraft(proposal());
  assert.equal(validate(draft), null);
  draft = apply(draft, "stepAdd", { id: "c" });
  assert.equal(validate(draft).path, "steps[2].title");
  draft = apply(draft, "designAddColor", { group: "primary" });
  draft = apply(draft, "designSetColor", { group: "primary", index: 0, value: "red" });
  assert.equal(validate(draft).code, "PLAN_STEPS_INVALID");
  draft = apply(draft, "stepUpdate", { id: "c", title: "Valid" });
  assert.equal(validate(draft).path, "design.colorSystem.primary[0]");
  assert.match(validate(draft).message, /#RRGGBB/);
});

test("revision includes only normalized differences, preserving explicit clear semantics", () => {
  const base = createPlanDraft(proposal({ design: { framework: " React ", colorSystem: { primary: ["#abcdef"] } } }));
  assert.deepEqual(revision(base), {});
  let draft = apply(base, "stepUpdate", { id: "a", title: " a ", detail: " " });
  draft = apply(draft, "designSetFramework", { value: "react" });
  draft = apply(draft, "designSetColor", { group: "primary", index: 0, value: "#ABCDEF" });
  assert.deepEqual(revision(draft), {});
  draft = apply(draft, "stepRemove", { id: "a" });
  draft = apply(draft, "stepRemove", { id: "b" });
  assert.deepEqual(revision(draft), { revisedSteps: [] });
  draft = apply(draft, "designSetFramework", { value: undefined });
  draft = apply(draft, "designRemoveColor", { group: "primary", index: 0 });
  assert.deepEqual(revision(draft), { revisedSteps: [], revisedDesign: {} });
  assert.equal(dirty(draft), true);
  const empty = createPlanDraft(proposal({ steps: [], design: { styleKeywords: [], colorSystem: { text: [] } } }));
  assert.deepEqual(revision({ ...empty, design: {} }), {});
  assert.deepEqual(revision(createPlanDraft(proposal({ steps: undefined, design: undefined }))), {});
});

test("markdown edits travel as revisedMarkdown and reset restores the submitted body", () => {
  const base = createPlanDraft(proposal({ markdown: "# Plan\n" }));
  assert.equal(base.markdown, "# Plan\n");
  let draft = apply(base, "markdownSet", { value: "# Edited\n" });
  assert.deepEqual(revision(draft), { revisedMarkdown: "# Edited\n" });
  assert.equal(dirty(draft), true);
  draft = apply(draft, "markdownSet", { value: "# Plan\n" });
  assert.deepEqual(revision(draft), {});
  draft = apply(apply(draft, "markdownSet", { value: "# Edited\n" }), "reset");
  assert.equal(draft.markdown, "# Plan\n");
  assert.equal(dirty(draft), false);
});

test("a settled draft starts from the approved revision and survives execution version bumps", () => {
  const approved = proposal({ status: "approved", version: 4, resolvedSteps: [step("a")], resolvedDesign: { framework: "vue" } });
  const draft = createPlanDraft(approved);
  assert.equal(draft.key, "s:p:settled");
  assert.equal(createPlanDraft({ ...approved, version: 5 }).key, draft.key);
  assert.deepEqual(draft.steps, [step("a")]);
  assert.deepEqual(draft.design, { framework: "vue" });
  const unlocked = apply(draft, "tasksEdit");
  assert.equal(unlocked.tasksEditing, true);
  assert.equal(dirty(unlocked), false);
  assert.equal(apply(unlocked, "reset").tasksEditing, undefined);
});
