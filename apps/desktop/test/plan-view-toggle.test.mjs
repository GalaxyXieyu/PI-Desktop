import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// Control only React's view-state scheduler. Render the production section,
// graph and SegmentedControl, and invoke the real segment button handlers.
test("List/Graph switches preserve progress and render updated draft/effective steps", async (t) => {
  let view = "list";
  globalThis.__planViewState = (initial) => initial === "list"
    ? [view, (next) => { view = next; }]
    : [initial, () => {}];
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent",
    plugins: [{ name: "plan-view-scheduler", enforce: "pre", transform(source, id) {
      if (!id.endsWith("/PlanFlowchart.tsx")) return;
      return source.replace('import { useId, useState, type ReactNode } from "react";',
        'import { useId, type ReactNode } from "react"; const useState = globalThis.__planViewState;');
    } }],
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(async () => { delete globalThis.__planViewState; await server.close(); });
  const { PlanTasksSection } = await server.ssrLoadModule("/src/components/plan/PlanFlowchart.tsx");
  const { PlanDocument } = await server.ssrLoadModule("/src/components/plan/PlanDocument.tsx");
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const previous = { ...useAppStore.getState() };
  const previousInitial = { ...useAppStore.getInitialState() };
  t.after(() => {
    useAppStore.setState(previous, true);
    Object.assign(useAppStore.getInitialState(), previousInitial);
  });
  const { SegmentedControl } = await server.ssrLoadModule("/src/components/ui.tsx");
  const { createPlanDraft, planDraftReducer } = await server.ssrLoadModule("/src/features/plan/plan-draft-model.ts");
  const { planStepProgress } = await server.ssrLoadModule("/src/features/plan/plan-step-progress.ts");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  let buttons;
  const findToggle = (element) => {
    if (!element || typeof element !== "object") return;
    if (element.type === SegmentedControl) return element;
    return [element.props?.children].flat().map(findToggle).find(Boolean);
  };
  const render = (steps, progress) => {
    function Probe() {
      const section = PlanTasksSection({ steps, progress,
        summary: progress && createElement("p", { "data-testid": "summary" }, `${progress.done} / ${progress.total} done`),
        children: createElement("ol", null, steps.map((step) => createElement("li", { key: step.id }, step.title))),
      });
      buttons = SegmentedControl(findToggle(section).props).props.children;
      return section;
    }
    return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Probe)));
  };
  const proposal = { id: "p", sessionId: "s", version: 1, status: "pending", steps: [
    { id: "a", title: "Prepare", dependsOn: [] },
    { id: "b", title: "Build", dependsOn: ["a"] },
  ] };
  let draft = createPlanDraft(proposal);
  assert.doesNotMatch(render(draft.steps), /data-testid="plan-flowchart"/);
  buttons.find((button) => button.props.children === "Graph").props.onClick();
  assert.match(render(draft.steps), /data-testid="plan-flowchart"/);
  draft = planDraftReducer(draft, { type: "stepUpdate", id: "a", title: "Revised preparation" });
  assert.match(render(draft.steps), /<title>Revised preparation<\/title>/);
  const progress = planStepProgress(draft.steps, [{ stepId: "a", content: "Prepare", status: "completed" }]);
  const graph = render(draft.steps, progress);
  assert.match(graph, /1 \/ 2 done/);
  assert.match(graph, /data-step-id="a" data-status="completed"/);
  assert.match(graph, /data-step-id="b" data-status="pending"/);
  buttons.find((button) => button.props.children === "List").props.onClick();
  const list = render(draft.steps, progress);
  assert.doesNotMatch(list, /data-testid="plan-flowchart"/);
  assert.match(list, /1 \/ 2 done/);
  assert.match(list, /Revised preparation/);

  // Exercise the actual editor/document wiring, not just the section props.
  const renderDocument = (props) => renderToStaticMarkup(createElement(I18nextProvider,
    { i18n }, createElement(PlanDocument, props)));
  const pendingProps = { proposal: { ...proposal, kind: "plan", title: "Plan", markdown: "Body" },
    draft, editable: true, dispatch: () => {} };
  assert.match(renderDocument(pendingProps), /data-testid="plan-step-deps"/);
  view = "graph";
  assert.match(renderDocument(pendingProps), /<title>Revised preparation<\/title>/);
  useAppStore.setState({ sessionTodos: { s: { todos: [
    { stepId: "a", content: "Prepare", status: "completed" },
  ] } } });
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
  const contract = renderDocument({ proposal: { ...pendingProps.proposal, status: "approved",
    executionState: "running", resolvedSteps: draft.steps } });
  assert.match(contract, /data-testid="plan-progress">1 \/ 2 done/);
  assert.match(contract, />Running</);
  assert.match(contract, /<title>Revised preparation<\/title>/);
  assert.match(contract, /data-step-id="a" data-status="completed"/);
  const legacy = renderDocument({ ...pendingProps, proposal: { ...pendingProps.proposal, steps: undefined },
    draft: createPlanDraft({ ...proposal, steps: undefined }) });
  assert.doesNotMatch(legacy, /data-testid="plan-view-toggle"|data-testid="plan-flowchart"/);
});
