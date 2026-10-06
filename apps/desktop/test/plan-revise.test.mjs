import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const proposal = (overrides = {}) => ({
  id: "p1", sessionId: "s", version: 1, kind: "plan", status: "approved", executionState: "interrupted",
  title: "Ship", question: "Build?", markdown: "Body",
  artifact: { relativePath: ".pi/plan/ship.md", sha256: "h", sizeBytes: 4 }, ...overrides,
});

async function setup(t) {
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const { usePlanRevise } = await ssr.load("/src/features/plan/use-plan-revise.ts");
  const previous = { ...useAppStore.getState() };
  t.after(() => useAppStore.setState(previous, true));
  const configured = [];
  const base = {
    activeSessionId: "s",
    runningSessions: {},
    pendingPlans: {},
    composerPrefill: null,
    sessions: [{ id: "s", mode: "agent", providerId: "prov", modelId: "model", thinkingLevel: "medium" }],
    configureActiveSession: async (config) => configured.push(config),
  };
  const hook = (value, remote = false, state = {}) => {
    useAppStore.setState({ ...base, ...state });
    Object.assign(useAppStore.getInitialState(), useAppStore.getState());
    let result;
    ssr.render(createElement(() => { result = usePlanRevise(value, remote); return null; }));
    return result;
  };
  return { useAppStore, hook, configured };
}

test("revise is offered only for a settled local proposal of the idle visible session", async (t) => {
  const { hook } = await setup(t);
  assert.equal(hook(proposal()).available, true);
  assert.equal(hook(proposal({ status: "rejected", executionState: undefined })).available, true);
  assert.equal(hook(proposal({ status: "pending", executionState: undefined })).available, false);
  assert.equal(hook(proposal({ executionState: "running" })).available, false);
  assert.equal(hook(proposal({ executionState: "queued" })).available, false);
  assert.equal(hook(proposal(), true).available, false);
  assert.equal(hook(proposal(), false, { activeSessionId: "other" }).available, false);
  assert.equal(hook(proposal(), false, { runningSessions: { s: true } }).available, false);
  assert.equal(hook(proposal(), false, { pendingPlans: { s: proposal({ id: "p2", status: "pending" }) } }).available, false);
});

test("revising switches the session back to its contract mode and seeds the composer", async (t) => {
  const { useAppStore, hook, configured } = await setup(t);
  await hook(proposal()).revise();
  assert.deepEqual(configured, [{ mode: "plan", providerId: "prov", modelId: "model", thinkingLevel: "medium" }]);
  const prefill = useAppStore.getState().composerPrefill;
  assert.equal(prefill.sessionId, "s");
  assert.deepEqual(prefill.fileReferences, []);
  assert.match(prefill.text, /Ship/);
  assert.match(prefill.text, /\.pi\/plan\/ship\.md/);
});

test("a session already in its contract mode is not reconfigured", async (t) => {
  const { useAppStore, hook, configured } = await setup(t);
  const revise = hook(proposal(), false, {
    sessions: [{ id: "s", mode: "plan", providerId: "prov", modelId: "model", thinkingLevel: "medium" }],
  });
  await revise.revise();
  assert.deepEqual(configured, []);
  assert.equal(useAppStore.getState().composerPrefill.sessionId, "s");
});
