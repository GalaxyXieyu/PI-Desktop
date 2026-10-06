import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const plan = (id, status, sessionId = "s") => ({
  id, sessionId, version: 1, kind: "plan", status, title: `Plan ${id}`,
  question: "Build?", markdown: "Body", artifact: { relativePath: `.pi/plan/${id}.md`, sha256: "h", sizeBytes: 4 },
});

test("a plan artifact path resolves to the visible session's proposal, live state first", async (t) => {
  const ssr = await slotSsr(t);
  const { findPlanByArtifactPath } = await ssr.load("/src/features/plan/plan-artifact-link.ts");
  const pending = plan("p", "pending");
  const history = plan("old", "approved");
  const state = {
    activeSessionId: "s",
    pendingPlans: { s: pending },
    planCheckpoints: { s: { ...pending, status: "approved" } },
    messages: [{ id: "m", planHistory: { proposal: { ...pending, status: "expired" } } },
      { id: "n", planHistory: { proposal: history } },
      { id: "x", planHistory: { proposal: plan("foreign", "pending", "other") } }],
  };
  assert.equal(findPlanByArtifactPath(state, ".pi/plan/p.md"), pending);
  assert.equal(findPlanByArtifactPath(state, "./.pi/plan/old.md"), history);
  assert.equal(findPlanByArtifactPath(state, ".pi/plan/foreign.md"), undefined);
  assert.equal(findPlanByArtifactPath(state, "src/index.ts"), undefined);
  assert.equal(findPlanByArtifactPath({ ...state, activeSessionId: undefined }, ".pi/plan/p.md"), undefined);
});

test("message prose renders a plan artifact link as the plan chip and keeps other file links", async (t) => {
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const { Markdown } = await ssr.load("/src/components/Markdown.tsx");
  const previous = { ...useAppStore.getState() };
  t.after(() => useAppStore.setState(previous, true));
  useAppStore.setState({ activeSessionId: "s", messages: [], pendingPlans: { s: plan("p", "pending") }, planCheckpoints: {} });
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
  const html = ssr.render(createElement(Markdown, {
    source: "See [the plan](.pi/plan/p.md) and [code](src/index.ts).",
  }));
  assert.match(html, /data-testid="plan-link-chip"/);
  assert.match(html, /Plan p/);
  assert.match(html, /Awaiting approval/);
  assert.doesNotMatch(html, /href="\.pi\/plan\/p\.md"/);
  assert.match(html, /href="src\/index\.ts"/);
});
