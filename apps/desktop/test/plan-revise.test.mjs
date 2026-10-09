import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const proposal = (overrides = {}) => ({
  id: "p1", sessionId: "s", version: 1, kind: "plan", status: "approved", executionState: "interrupted",
  title: "Ship", question: "Build?", markdown: "Body",
  steps: [{ id: "a", title: "Prepare", dependsOn: [] }], design: { framework: "react" },
  artifact: { relativePath: ".pi/plan/ship.md", sha256: "h", sizeBytes: 4 }, ...overrides,
});

async function setup(t) {
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const { usePlanRevise, planRevisionMessage } = await ssr.load("/src/features/plan/use-plan-revise.ts");
  const { createPlanDraft, planDraftReducer } = await ssr.load("/src/features/plan/plan-draft-model.ts");
  const { usePlanDraftStore } = await ssr.load("/src/features/plan/plan-draft-store.ts");
  const previous = { ...useAppStore.getState() };
  t.after(() => useAppStore.setState(previous, true));
  const calls = [];
  const base = {
    activeSessionId: "s",
    runningSessions: {},
    pendingPlans: {},
    planCheckpoints: {},
    sessions: [{ id: "s", mode: "agent", providerId: "prov", modelId: "model", thinkingLevel: "medium" }],
    configureActiveSession: async (config) => calls.push(["configure", config.mode]),
    sendPrompt: async (content, _draft, sessionId) => (calls.push(["send", sessionId, content]), true),
    abortSession: async (sessionId) => {
      calls.push(["abort", sessionId]);
      setTimeout(() => useAppStore.setState({ runningSessions: {} }), 5);
    },
    showToast: (message) => calls.push(["toast", message]),
  };
  const edited = (value, action = { type: "markdownSet", value: "Edited body" }) =>
    planDraftReducer(createPlanDraft(value), action);
  const hook = (value, draft = edited(value), remote = false, state = {}) => {
    useAppStore.setState({ ...base, ...state });
    Object.assign(useAppStore.getInitialState(), useAppStore.getState());
    let result;
    ssr.render(createElement(() => { result = usePlanRevise(value, draft, remote); return null; }));
    return result;
  };
  return { hook, calls, edited, createPlanDraft, planDraftReducer, planRevisionMessage, usePlanDraftStore };
}

test("revise is offered only once a settled local Plan has been edited", async (t) => {
  const { hook, createPlanDraft } = await setup(t);
  assert.equal(hook(proposal()).available, true);
  assert.equal(hook(proposal({ status: "rejected", executionState: undefined })).available, true);
  assert.equal(hook(proposal({ executionState: "running" }), undefined, false, { runningSessions: { s: true } }).available, true);
  assert.equal(hook(proposal(), createPlanDraft(proposal())).available, false);
  assert.equal(hook(proposal({ status: "pending", executionState: undefined })).available, false);
  assert.equal(hook(proposal({ executionState: "queued" })).available, false);
  assert.equal(hook(proposal({ kind: "goal" })).available, false);
  assert.equal(hook(proposal(), undefined, true).available, false);
  assert.equal(hook(proposal(), undefined, false, { activeSessionId: "other" }).available, false);
  assert.equal(hook(proposal(), undefined, false, { pendingPlans: { s: proposal({ id: "p2", status: "pending" }) } }).available, false);
});

test("revising an idle plan switches to Plan mode and sends the edited plan", async (t) => {
  const { hook, calls, edited, usePlanDraftStore } = await setup(t);
  const draft = edited(proposal());
  usePlanDraftStore.setState({ drafts: { [draft.key]: draft } });
  await hook(proposal(), draft).revise();
  assert.deepEqual(calls.map(([kind]) => kind), ["configure", "send"]);
  assert.equal(calls[0][1], "plan");
  const [, sessionId, message] = calls[1];
  assert.equal(sessionId, "s");
  assert.match(message, /Ship/);
  assert.match(message, /\.pi\/plan\/ship\.md/);
  assert.match(message, /Edited body/);
  assert.equal(usePlanDraftStore.getState().drafts[draft.key], undefined);
});

test("revising a running plan stops execution before sending", async (t) => {
  const { hook, calls, edited } = await setup(t);
  const running = proposal({ executionState: "running" });
  await hook(running, edited(running), false, { runningSessions: { s: true } }).revise();
  assert.deepEqual(calls.map(([kind]) => kind), ["abort", "configure", "send"]);
});

test("the revision message carries tasks and design only when they changed", async (t) => {
  const { edited, planDraftReducer, planRevisionMessage } = await setup(t);
  const labels = { intro: "Intro", tasks: "Tasks", design: "Design" };
  const body = planRevisionMessage(edited(proposal()), labels);
  assert.equal(body, "Intro\n\nEdited body");
  const steps = planDraftReducer(edited(proposal(), { type: "stepUpdate", id: "a", title: "Renamed" }),
    { type: "designSetFramework", value: "vue" });
  const message = planRevisionMessage(steps, labels);
  assert.match(message, /## Tasks\n\n1\. \[a\] Renamed/);
  assert.match(message, /## Design\n\n```json\n[\s\S]*"framework": "vue"/);
});
