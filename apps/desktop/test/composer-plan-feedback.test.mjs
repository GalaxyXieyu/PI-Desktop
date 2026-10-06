import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const pending = {
  id: "p1", sessionId: "s", turnId: "t1", toolCallId: "c1", version: 2, kind: "plan", status: "pending",
  title: "Ship", question: "Build?", markdown: "Body",
};

async function submitDuringApproval(t, { rejectFails = false } = {}) {
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const { useComposerSubmit } = await ssr.load("/src/features/chat/composer/hooks/useComposerSubmit.ts");
  const previous = { ...useAppStore.getState() };
  t.after(() => useAppStore.setState(previous, true));
  const events = [];
  useAppStore.setState({
    activeSessionId: "s",
    pendingPlans: { s: pending },
    resolvePlan: async (request) => {
      events.push(["resolve", request]);
      if (rejectFails) throw new Error("host refused");
      useAppStore.setState({ pendingPlans: {} });
    },
  });
  let controller;
  ssr.render(createElement(() => {
    controller = useComposerSubmit({
      value: "Split step 3 into two tasks",
      draftKey: "session:s",
      activeSessionId: "s",
      thinkingLevel: "medium",
      modelReady: true,
      sendBlocked: false,
      pasting: false,
      activeFileReferences: [],
      t: (key) => key,
      sendPrompt: async (content) => { events.push(["send", content]); return true; },
      steerPrompt: async (content) => { events.push(["steer", content]); return true; },
      showToast: (message) => events.push(["toast", message]),
      draft: {
        ref: { current: null },
        draftSnapshot: (text) => ({ text, fileReferences: [] }),
        draftRevision: () => 0,
        clearDraftForKey: () => events.push(["clear"]),
        restoreDraftForKey: () => events.push(["restore"]),
        setValue: () => {},
        setCursor: () => {},
      },
    });
    return null;
  }));
  await controller.submit(true);
  return events;
}

test("a message sent during plan approval rejects the proposal, then goes out as a prompt", async (t) => {
  const events = await submitDuringApproval(t);
  assert.deepEqual(events.map(([kind]) => kind), ["resolve", "clear", "send"]);
  assert.deepEqual(events[0][1], {
    proposalId: "p1", sessionId: "s", turnId: "t1", toolCallId: "c1", version: 2, action: "reject",
  });
  assert.equal(events[2][1], "Split step 3 into two tasks");
});

test("a refused rejection keeps the draft and sends nothing", async (t) => {
  const events = await submitDuringApproval(t, { rejectFails: true });
  assert.deepEqual(events, [["resolve", events[0][1]], ["toast", "host refused"]]);
});
