import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const structured = {
  id: "p", sessionId: "s", version: 1, kind: "plan", status: "pending",
  title: "Build a page", question: "Ready to build?", markdown: "Immutable **plan** body.",
  steps: [{ id: "a", title: "Prepare", detail: "Inspect the layout", dependsOn: [] },
    { id: "b", title: "Implement", dependsOn: ["a"] }],
  design: { styleKeywords: ["Calm"], framework: "react", componentLibrary: "mui",
    fontSystem: { fontFamily: "Inter", heading: { size: "24px", weight: 600 } },
    colorSystem: { primary: ["#ABCDEF"], background: ["#FFFFFF"], text: ["#123456"], functional: ["#00FF00"] } },
};
const legacy = {
  id: "p", sessionId: "s", version: 1, kind: "plan", status: "pending",
  title: "Build a page", question: "Ready to build?", markdown: "Immutable **plan** body.",
};
const goal = { ...legacy, kind: "goal" };

async function setup(t, proposal, source = "local") {
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const { PlanTab } = await ssr.load("/src/components/workpanel/PlanTab.tsx");
  const { usePlanDraftStore, discardPlanDraft } = await ssr.load("/src/features/plan/plan-draft-store.ts");
  const previous = { ...useAppStore.getState() };
  t.after(() => { useAppStore.setState(previous, true); discardPlanDraft("s:p:1"); });
  const render = () => {
    Object.assign(useAppStore.getInitialState(), useAppStore.getState());
    Object.assign(usePlanDraftStore.getInitialState(), usePlanDraftStore.getState());
    return ssr.render(createElement(PlanTab, { sessionId: "s", proposalId: "p" }));
  };
  useAppStore.setState({ activeSessionId: "s", sessions: [{ id: "s", source }],
    pendingPlans: { s: proposal }, planCheckpoints: { s: proposal } });
  return { ssr, render, useAppStore, usePlanDraftStore };
}

test("a pending local plan renders the editors and the tab Build controls", async (t) => {
  const { render } = await setup(t, structured);
  const html = render();
  // Tab-variant Build split button and Reject.
  assert.match(html, />Build</);
  assert.match(html, />Reject</);
  assert.match(html, /plan-approval-approve-main/);
  assert.match(html, /plan-approval-approve-menu/);
  // Steps editor: row controls and the add button.
  assert.match(html, /New task/);
  assert.match(html, /aria-label="Edit task"/);
  assert.match(html, /aria-label="Delete task"/);
  assert.match(html, /aria-label="Move up"/);
  assert.match(html, /aria-label="Move down"/);
  assert.match(html, /Depends on/);
  // Design editor: selects, color inputs, keyword input.
  assert.match(html, /<select/);
  assert.match(html, /type="color"/);
  assert.match(html, /aria-label="Font family"/);
  assert.match(html, /400 · Regular/);
  assert.match(html, /font-family:Inter;font-size:24px;font-weight:600/);
});

test("a legacy plan without steps or design gets a steps editor but no design editor", async (t) => {
  const { render } = await setup(t, legacy);
  const html = render();
  assert.match(html, /New task/);
  assert.match(html, />Build</);
  assert.doesNotMatch(html, /type="color"|aria-label="Font family"|Style keywords/);
});

test("edits mark the tab as Modified with a reset that restores the submitted plan", async (t) => {
  const { render, usePlanDraftStore } = await setup(t, structured);
  assert.doesNotMatch(render(), /Modified|Reset changes/);
  usePlanDraftStore.getState().dispatch(structured, { type: "stepUpdate", id: "a", title: "Draft task" });
  const dirty = render();
  assert.match(dirty, /Modified/);
  assert.match(dirty, /Reset changes/);
  assert.match(dirty, /Draft task/);
  usePlanDraftStore.getState().dispatch(structured, { type: "reset" });
  const clean = render();
  assert.doesNotMatch(clean, /Modified|Reset changes|Draft task/);
});

test("a remote pending plan shows the read-only note and never the editors", async (t) => {
  const { render } = await setup(t, structured, "remote");
  const html = render();
  assert.match(html, /Editing the plan structure is not available for remote sessions\./);
  assert.match(html, /Remote session plans are read-only\./);
  // Build still works remotely (without a revision), but nothing is editable.
  assert.match(html, />Build</);
  assert.doesNotMatch(html, /type="color"|aria-label="Font family"|aria-label="Edit task"|New task/);
});

test("a goal proposal keeps the read-only document without editors or tab Build", async (t) => {
  const { render } = await setup(t, goal);
  const html = render();
  assert.match(html, /Goal/);
  assert.match(html, /Awaiting approval/);
  assert.doesNotMatch(html, /New task|plan-approval-approve-main|type="color"/);
});
