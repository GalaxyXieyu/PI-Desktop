import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const legacy = {
  id: "p", sessionId: "s", version: 1, kind: "plan", status: "pending",
  title: "Build a page", question: "Ready to build?", markdown: "Immutable **plan** body.",
};
const structured = {
  ...legacy,
  steps: [{ id: "a", title: "Prepare", detail: "Inspect the layout", dependsOn: [] },
    { id: "b", title: "Implement", dependsOn: ["a"] }],
  design: { styleKeywords: ["Calm"], framework: "react", componentLibrary: "mui",
    fontSystem: { fontFamily: "Inter", heading: { size: "24px", weight: 600 } },
    colorSystem: { primary: ["#ABCDEF"], background: ["#FFFFFF"], text: ["#123456"], functional: ["#00FF00"] } },
};

test("Plan document renders legacy, structured and effective approved contracts", async (t) => {
  const ssr = await slotSsr(t);
  const { PlanDocument } = await ssr.load("/src/components/plan/PlanDocument.tsx");
  const render = (proposal) => ssr.render(createElement(PlanDocument, { proposal }));
  const plain = render(legacy);
  assert.match(plain, /Build a page/);
  assert.match(plain, /Ready to build\?/);
  assert.match(plain, /Immutable/);
  assert.doesNotMatch(plain, /Design spec|aria-label="Tasks"/);
  const rich = render(structured);
  assert.match(rich, /Design spec/);
  assert.match(rich, /aria-label="Tasks"/);
  assert.match(rich, /Inspect the layout/);
  assert.match(rich, /Depends on/);
  assert.match(rich, /1\. Prepare/);
  for (const color of ["#ABCDEF", "#FFFFFF", "#123456", "#00FF00"]) assert.ok(rich.includes(`<code>${color}</code>`));
  assert.match(rich, /font-family:Inter;font-size:24px;font-weight:600/);
  assert.match(rich, /Aa Typography preview/);
  const revised = render({ ...structured, status: "approved", resolvedSteps: [{ id: "new", title: "Revised task", dependsOn: [] }], resolvedDesign: { framework: "vue" } });
  assert.match(revised, /Revised task/);
  assert.match(revised, /vue/);
  assert.doesNotMatch(revised, /Prepare|#ABCDEF|>react</);
  const cleared = render({ ...structured, status: "approved", resolvedSteps: [], resolvedDesign: {} });
  assert.doesNotMatch(cleared, /Design spec|aria-label="Tasks"/);
});

test("approval entry opens a session-scoped plan tab and shared draft survives tab closure until resolution", async (t) => {
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const { PlanApprovalBar } = await ssr.load("/src/components/PlanApprovalBar.tsx");
  const { PlanTab } = await ssr.load("/src/components/workpanel/PlanTab.tsx");
  const { planWorkPanelTab } = await ssr.load("/src/lib/work-panel-tabs.ts");
  const { usePlanDraftStore, discardPlanDraft } = await ssr.load("/src/features/plan/plan-draft-store.ts");
  const previous = { ...useAppStore.getState() };
  const render = (element) => {
    Object.assign(useAppStore.getInitialState(), useAppStore.getState());
    Object.assign(usePlanDraftStore.getInitialState(), usePlanDraftStore.getState());
    return ssr.render(element);
  };
  t.after(() => { useAppStore.setState(previous, true); discardPlanDraft("s:p:1"); });
  useAppStore.setState({ activeSessionId: "s", sessions: [{ id: "s", source: "local" }],
    pendingPlans: { s: structured }, planCheckpoints: { s: structured } });
  assert.match(ssr.render(createElement(PlanApprovalBar, { proposal: legacy })), /View plan/);
  const bar = ssr.render(createElement(PlanApprovalBar, { proposal: structured }));
  assert.match(bar, /Review &amp; edit plan/);
  assert.match(bar, /2 tasks/);
  assert.match(bar, /data-testid="plan-view-plan"/);
  useAppStore.getState().openWorkPanelTabForSession("s", planWorkPanelTab(structured));
  assert.equal(useAppStore.getState().activeWorkPanelTabId, "plan:p");
  assert.match(render(createElement(PlanTab, { sessionId: "s", proposalId: "p" })), /Awaiting approval/);
  usePlanDraftStore.getState().dispatch(structured, { type: "stepUpdate", id: "a", title: "Draft task" });
  assert.match(render(createElement(PlanTab, { sessionId: "s", proposalId: "p" })), /Draft task/);
  usePlanDraftStore.getState().dispatch(structured, { type: "stepRemove", id: "b" });
  assert.match(render(createElement(PlanApprovalBar, { proposal: structured })), /1 task/);
  useAppStore.getState().closeWorkPanelTab("plan:p");
  assert.ok(usePlanDraftStore.getState().drafts["s:p:1"]);
  useAppStore.setState({ pendingPlans: {}, planCheckpoints: { s: { ...structured, status: "approved", executionState: "completed", resolvedSteps: [], resolvedDesign: {} } } });
  assert.equal(usePlanDraftStore.getState().drafts["s:p:1"], undefined);
  const approved = render(createElement(PlanTab, { sessionId: "s", proposalId: "p" }));
  assert.match(approved, /Completed/);
  assert.doesNotMatch(approved, /Draft task|Design spec|aria-label="Tasks"/);
  useAppStore.setState({ sessions: [{ id: "s", source: "remote" }] });
  assert.match(render(createElement(PlanTab, { sessionId: "s", proposalId: "missing" })), /not available in the remote session/);
  assert.match(render(createElement(PlanTab, { sessionId: "s", proposalId: "p" })), /Remote session plans are read-only/);
});
