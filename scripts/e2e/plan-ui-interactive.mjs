#!/usr/bin/env node
/**
 * E2E-PLAN-interactive-tab-edit-build-progress — interactive Plan tab over the real Electron UI.
 *
 * data-testid contract exercised by this module (all additive, no behavior):
 *   plan-tab                                  Plan tab root (work panel)
 *   plan-tab-build / plan-tab-reject          pending tab header Build / Reject
 *   plan-step-row (+ data-step-id)            one editable step row
 *   plan-step-title-input                     inline step title editor input
 *   plan-step-add / plan-step-delete          add-step / delete-step buttons
 *   plan-step-deps-trigger                    "Depends on" picker trigger
 *   plan-step-dep-option (+ data-step-id)     dependency picker checkbox
 *   plan-design-keyword-input / -add          style keyword input / add button
 *   plan-design-keyword-chip / -remove        style keyword chip / chip remove
 *   plan-design-color (+ data-group, data-index)  design color swatch input
 *   plan-design-font-family                   design font family select
 *   plan-design-framework                     design framework select
 *   plan-design-component-library             design component library select
 *
 * Pre-existing testids reused: plan-approval-bar, plan-view-plan,
 * plan-view-toggle, plan-flowchart, plan-flowchart-node (+ data-step-id,
 * data-status), plan-flowchart-edge, plan-progress, plan-progress-step
 * (+ data-step-id, data-status), plan-step-deps.
 *
 * Every UI action goes through real DOM events (native value setters +
 * input/change for React controlled inputs, keydown Enter for the
 * uncontrolled step-title editor, input.click() for checkboxes), so the
 * case exercises the same reducer and approval path a user drives.
 */
import { deepStrictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BODY_EDIT = " Edited body marker.";

const CHECKPOINT = {
  title: "Interactive plan UI",
  question: "How should the interactive plan tab hold up end to end?",
  markdown: [
    "# Interactive plan UI",
    "",
    "## Goal",
    "",
    "Verify that a structured proposal can be edited in the Plan tab and",
    "that the approved revision, not the submitted one, drives execution.",
    "",
    "## Scope",
    "",
    "- Step list edits: rename, delete, add, dependency picker with cycles",
    "- Design edits: keywords, colors, font family, component library",
    "- Graph draft and post-approval progress states",
  ].join("\n"),
  steps: [
    { id: "s1", title: "Audit layout", detail: "Inspect current breakpoints", dependsOn: [] },
    { id: "s2", title: "Draft copy", detail: "Write headings and body", dependsOn: [] },
    { id: "s3", title: "Build page", detail: "", dependsOn: ["s1", "s2"] },
    { id: "s4", title: "Ship checklist", dependsOn: ["s3"] },
  ],
  design: {
    styleKeywords: ["minimal", "accessible"],
    fontSystem: {
      fontFamily: "Inter",
      heading: { size: "32px", weight: 600 },
      subheading: { size: "24px", weight: 500 },
      body: { size: "16px", weight: 400 },
    },
    colorSystem: {
      primary: ["#1A2B3C", "#3E5C76"],
      background: ["#F8F9FA"],
      text: ["#111827"],
    },
    framework: "react",
    componentLibrary: "mui",
  },
};

/** Host normalization of the submitted checkpoint (empty detail dropped). */
const EXPECTED_SUBMITTED_STEPS = [
  { id: "s1", title: "Audit layout", detail: "Inspect current breakpoints", dependsOn: [] },
  { id: "s2", title: "Draft copy", detail: "Write headings and body", dependsOn: [] },
  { id: "s3", title: "Build page", dependsOn: ["s1", "s2"] },
  { id: "s4", title: "Ship checklist", dependsOn: ["s3"] },
];

/** Draft edits made through the UI: s2 renamed, s4 removed, step added on s3. */
const editedStepsFor = (newStepId) => [
  { id: "s1", title: "Audit layout", detail: "Inspect current breakpoints", dependsOn: [] },
  { id: "s2", title: "Draft launch copy", detail: "Write headings and body", dependsOn: [] },
  { id: "s3", title: "Build page", dependsOn: ["s1", "s2"] },
  { id: newStepId, title: "Polish animations", dependsOn: ["s3"] },
];

/** Draft design edits: drop "minimal", add "glassmorphism", new primary color,
 * new font family, new component library. */
const EXPECTED_EDITED_DESIGN = {
  styleKeywords: ["accessible", "glassmorphism"],
  fontSystem: {
    fontFamily: "Roboto",
    heading: { size: "32px", weight: 600 },
    subheading: { size: "24px", weight: 500 },
    body: { size: "16px", weight: 400 },
  },
  colorSystem: {
    primary: ["#3050C8", "#3E5C76"],
    background: ["#F8F9FA"],
    text: ["#111827"],
  },
  framework: "react",
  componentLibrary: "shadcn",
};

/** TodoWrite progress pushed on the still-running submit turn after Build. */
const progressTodosFor = (newStepId) => [
  { content: "Audit layout", status: "completed", priority: "medium", stepId: "s1" },
  { content: "Draft launch copy", status: "pending", priority: "medium", stepId: "s2" },
  { content: "Build page", status: "in_progress", priority: "medium", stepId: "s3" },
  { content: "Polish animations", status: "pending", priority: "medium", stepId: newStepId },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deepEqual(actual, expected) {
  try {
    deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

function evalPage(state, source) {
  return state.cdp.evaluate(`(() => { ${source} })()`);
}

/** Snapshot of every Plan tab surface this case asserts on. */
function readPlanDom(state) {
  return state.cdp.evaluate(`(() => {
    const text = (node) => (node?.textContent || "").replace(/\\s+/g, " ").trim();
    const tab = document.querySelector('[data-testid="plan-tab"]');
    const rows = [...document.querySelectorAll('[data-testid="plan-step-row"]')].map((row) => ({
      stepId: row.getAttribute("data-step-id") || "",
      title: text(row.querySelector(".plan-step-title")),
      editing: Boolean(row.querySelector('[data-testid="plan-step-title-input"]')),
      deps: [...row.querySelectorAll('[data-testid="plan-step-deps"] .badge')].map((badge) => badge.getAttribute("title")),
    }));
    const progressSteps = [...document.querySelectorAll('[data-testid="plan-progress-step"]')].map((row) => ({
      stepId: row.getAttribute("data-step-id") || "",
      status: row.getAttribute("data-status") || "",
    }));
    const openMenu = document.querySelector(".plan-step-deps-menu.is-open");
    const progressEl = document.querySelector('[data-testid="plan-progress"]');
    const graphButton = [...document.querySelectorAll('[data-testid="plan-view-toggle"] [role="radio"]')]
      .find((button) => text(button) === "Graph");
    return {
      tab: Boolean(tab),
      tabTitle: text(tab?.querySelector(".plan-tab-title")),
      build: Boolean(document.querySelector('[data-testid="plan-tab-build"]')),
      reject: Boolean(document.querySelector('[data-testid="plan-tab-reject"]')),
      rows,
      progressText: text(progressEl),
      executionBadge: text(progressEl?.querySelector(".badge")),
      progressSteps,
      keywordChips: [...document.querySelectorAll('[data-testid="plan-design-keyword-chip"]')].map(text),
      colors: [...document.querySelectorAll('[data-testid="plan-design-color"]')].map((input) => ({
        group: input.getAttribute("data-group") || "",
        index: Number(input.getAttribute("data-index") || -1),
        value: input.value,
        code: text(input.closest(".plan-color")?.querySelector("code")),
      })),
      fontFamily: document.querySelector('[data-testid="plan-design-font-family"]')?.value ?? null,
      framework: document.querySelector('[data-testid="plan-design-framework"]')?.value ?? null,
      componentLibrary: document.querySelector('[data-testid="plan-design-component-library"]')?.value ?? null,
      graphToggle: Boolean(graphButton),
      graphChecked: graphButton?.getAttribute("aria-checked") === "true",
      flowNodes: [...document.querySelectorAll('[data-testid="plan-flowchart-node"]')].map((node) => ({
        stepId: node.getAttribute("data-step-id") || "",
        status: node.getAttribute("data-status") || "",
      })),
      flowEdges: document.querySelectorAll('[data-testid="plan-flowchart-edge"]').length,
      depsMenu: {
        open: Boolean(openMenu),
        options: [...(openMenu?.querySelectorAll('[data-testid="plan-step-dep-option"]') ?? [])].map((input) => ({
          stepId: input.getAttribute("data-step-id") || "",
          checked: input.checked,
          disabled: input.disabled,
          title: input.getAttribute("title") || "",
          label: text(input.closest("label")),
        })),
      },
      approveMenuOpen: Boolean(document.querySelector(".plan-approval-menu.is-open")),
      askModeSelected: Boolean(
        document.querySelector('.plan-approval-menu.is-open [data-approval-mode="ask"][aria-checked="true"]'),
      ),
    };
  })()`);
}

/** Set a React controlled input/select value through the native setter. */
function setPageValue(state, selector, value, description) {
  return evalPage(state, `
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { ok: false, reason: "missing" };
    if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement) && !(node instanceof HTMLSelectElement)) {
      return { ok: false, reason: "unsupported element" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(node.constructor.prototype, "value");
    descriptor?.set?.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: node.value };
  `).then((result) => {
    assert(result?.ok === true, `could not set ${description || selector}: ${JSON.stringify(result)}`);
    return result;
  });
}

/** Dispatch a keydown on a selector (used for Enter in the title editor). */
function pressKey(state, selector, key, description) {
  return evalPage(state, `
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { ok: false, reason: "missing" };
    node.focus();
    node.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)},
      bubbles: true,
      cancelable: true,
    }));
    return { ok: true };
  `).then((result) => {
    assert(result?.ok === true, `could not press ${key} on ${description || selector}`);
    return result;
  });
}

function scrollSelectorIntoView(state, selector) {
  return evalPage(state, `
    const node = document.querySelector(${JSON.stringify(selector)});
    if (node) node.scrollIntoView({ block: "center" });
    return Boolean(node);
  `);
}

/** Click the "Graph" half of the list/graph SegmentedControl by label. */
function clickGraphToggle(state) {
  return evalPage(state, `
    const button = [...document.querySelectorAll('[data-testid="plan-view-toggle"] [role="radio"]')]
      .find((node) => (node.textContent || "").trim() === "Graph");
    if (!button) return { clicked: false };
    button.click();
    return { clicked: true };
  `).then((result) => {
    assert(result?.clicked === true, "could not click the Graph view toggle");
    return result;
  });
}

async function openDepsMenu(h, state, stepId) {
  await scrollSelectorIntoView(state, `[data-testid="plan-step-row"][data-step-id="${stepId}"] [data-testid="plan-step-deps-trigger"]`);
  await h.clickSelector(state, `[data-step-id="${stepId}"] [data-testid="plan-step-deps-trigger"]`, `deps trigger for ${stepId}`);
  await h.waitFor(async () => (await readPlanDom(state)).depsMenu.open, `dependency menu for ${stepId}`, state);
}

async function closeDepsMenu(h, state, stepId) {
  await h.clickSelector(state, `[data-step-id="${stepId}"] [data-testid="plan-step-deps-trigger"]`, `close deps menu for ${stepId}`);
  await h.waitFor(async () => !(await readPlanDom(state)).depsMenu.open, `dependency menu for ${stepId} closed`, state);
}

/** Run the whole E2E-PLAN-interactive-tab-edit-build-progress case; `h` carries harness helpers. */
export async function runInteractivePlanCase(state, h) {
  const { waitFor, clickSelector, captureScreenshot, runPlanProbe, getPreloadResult,
    setLanguage, reloadRenderer, selectSession, getSession, settlePlanProbe,
    classifyExpectedDiagnostic, jsonText, record } = h;

  // English labels ("Would create a cycle", "1 / 4 done", ...) are asserted.
  await setLanguage(state, "en");

  const seed = await runPlanProbe(state, { operation: "seed", workspace: state.workspace });
  const sessionId = seed.sessionId;
  state.interactiveSessionId = sessionId;
  const json = jsonText;

  const submit = await runPlanProbe(state, {
    operation: "submit",
    workspace: state.workspace,
    sessionId,
    revision: "second",
    toolCallId: "plan-ui-probe-interactive",
    title: CHECKPOINT.title,
    markdown: CHECKPOINT.markdown,
    question: CHECKPOINT.question,
    steps: CHECKPOINT.steps,
    design: CHECKPOINT.design,
  });
  assert(submit.status === "pending", `interactive submit was not pending: ${json(submit)}`);
  const proposalId = submit.proposal.id;
  const submitTurnId = submit.turnId;
  assert(
    deepEqual(submit.proposal.steps, EXPECTED_SUBMITTED_STEPS),
    `submitted steps echo mismatch: ${json(submit.proposal.steps)}`,
  );
  assert(
    deepEqual(submit.proposal.design, CHECKPOINT.design),
    `submitted design echo mismatch: ${json(submit.proposal.design)}`,
  );

  await reloadRenderer(state);
  await selectSession(state, sessionId);
  await waitFor(
    async () => {
      const snapshot = await h.inspectUi(state);
      return snapshot.bar?.status === "pending" ? snapshot : null;
    },
    "interactive Plan pending approval bar",
    state,
  );

  // (a) Open the Plan tab and inspect the seeded draft.
  if (!(await readPlanDom(state)).tab) {
    await clickSelector(state, '[data-testid="plan-view-plan"]', "Plan tab opener");
  }
  let dom = await waitFor(
    async () => {
      const current = await readPlanDom(state);
      return current.tab && current.rows.length === 4 ? current : null;
    },
    "interactive Plan tab with 4 step rows",
    state,
  );
  assert(dom.tabTitle === CHECKPOINT.title, `plan tab title mismatch: ${dom.tabTitle}`);
  assert(dom.build === true && dom.reject === true, "plan tab Build/Reject actions missing");
  assert(
    dom.rows.map((row) => row.stepId).join(",") === "s1,s2,s3,s4",
    `seeded step ids mismatch: ${json(dom.rows)}`,
  );
  assert(
    dom.rows.map((row) => row.title).join("|") === "Audit layout|Draft copy|Build page|Ship checklist",
    `seeded step titles mismatch: ${json(dom.rows)}`,
  );
  assert(
    dom.keywordChips.join("|") === "minimal|accessible",
    `seeded keyword chips mismatch: ${json(dom.keywordChips)}`,
  );
  assert(
    dom.colors.filter((color) => color.group === "primary").length === 2 &&
      dom.colors.some((color) => color.group === "primary" && color.value.toUpperCase() === "#1A2B3C") &&
      dom.colors.some((color) => color.group === "background" && color.value.toUpperCase() === "#F8F9FA"),
    `seeded color swatches mismatch: ${json(dom.colors)}`,
  );
  assert(dom.fontFamily === "Inter", `seeded font family mismatch: ${dom.fontFamily}`);
  assert(dom.framework === "react", `seeded framework mismatch: ${dom.framework}`);
  assert(dom.componentLibrary === "mui", `seeded component library mismatch: ${dom.componentLibrary}`);
  await scrollSelectorIntoView(state, '[data-testid="plan-tab"] .plan-tab-header');
  await captureScreenshot(state, "plan-tab-opened");

  // (b) Edit steps: rename s2, delete s4, add a step depending on s3.
  await clickSelector(
    state,
    '[data-step-id="s2"] button[aria-label="Edit task"]',
    "edit s2 title",
  );
  await setPageValue(state, '[data-step-id="s2"] [data-testid="plan-step-title-input"]', "Draft launch copy", "s2 title");
  await pressKey(state, '[data-step-id="s2"] [data-testid="plan-step-title-input"]', "Enter", "s2 title commit");

  await clickSelector(state, '[data-step-id="s4"] [data-testid="plan-step-delete"]', "delete s4");

  await clickSelector(state, '[data-testid="plan-step-add"]', "add step");
  dom = await waitFor(
    async () => {
      const current = await readPlanDom(state);
      return current.rows.length === 4 && /^step-[a-z0-9]{8}$/.test(current.rows[3].stepId) && current.rows[3].editing
        ? current
        : null;
    },
    "newly added step row in edit mode",
    state,
  );
  const newStepId = dom.rows[3].stepId;
  await setPageValue(
    state,
    `[data-step-id="${newStepId}"] [data-testid="plan-step-title-input"]`,
    "Polish animations",
    "new step title",
  );
  await pressKey(state, `[data-step-id="${newStepId}"] [data-testid="plan-step-title-input"]`, "Enter", "new step title commit");

  await openDepsMenu(h, state, newStepId);
  dom = await readPlanDom(state);
  const newStepOption = dom.depsMenu.options.find((option) => option.stepId === newStepId);
  assert(newStepOption === undefined, "dependency picker offered the step itself");
  const s3Option = dom.depsMenu.options.find((option) => option.stepId === "s3");
  assert(s3Option, `s3 missing from the dependency picker: ${json(dom.depsMenu.options)}`);
  assert(s3Option.checked === false && s3Option.disabled === false, "s3 option was not selectable");
  await clickSelector(
    state,
    `.plan-step-deps-menu.is-open [data-testid="plan-step-dep-option"][data-step-id="s3"]`,
    "depend new step on s3",
  );
  await closeDepsMenu(h, state, newStepId);

  dom = await waitFor(
    async () => {
      const current = await readPlanDom(state);
      return current.rows.length === 4 && current.rows[3].deps.length === 1 && !current.rows[3].editing
        ? current
        : null;
    },
    "new step dependency chip",
    state,
  );
  assert(
    dom.rows.map((row) => `${row.stepId}:${row.title}`).join("|") ===
      `s1:Audit layout|s2:Draft launch copy|s3:Build page|${newStepId}:Polish animations`,
    `edited step rows mismatch: ${json(dom.rows)}`,
  );
  assert(
    dom.rows[2].deps.join("|") === "1. Audit layout|2. Draft launch copy",
    `s3 dependency chips mismatch: ${json(dom.rows[2].deps)}`,
  );
  await scrollSelectorIntoView(state, '[data-testid="plan-step-row"]');
  await captureScreenshot(state, "plan-steps-edited");

  // (c) s1 -> s3 would create a cycle, so the option is disabled.
  await openDepsMenu(h, state, "s1");
  dom = await readPlanDom(state);
  const cycleOption = dom.depsMenu.options.find((option) => option.stepId === "s3");
  assert(cycleOption, `s3 missing from s1 dependency picker: ${json(dom.depsMenu.options)}`);
  assert(
    cycleOption.disabled === true && cycleOption.title === "Would create a cycle",
    `s3 option in s1 picker was not cycle-disabled: ${json(cycleOption)}`,
  );
  assert(cycleOption.label === "3. Build page", `s3 option label mismatch: ${cycleOption.label}`);
  await closeDepsMenu(h, state, "s1");

  // (d) Edit the design spec.
  await scrollSelectorIntoView(state, '[data-testid="plan-design-keyword-input"]');
  await clickSelector(
    state,
    '[data-testid="plan-design-keyword-chip"] [data-testid="plan-design-keyword-remove"]',
    "remove first keyword",
  );
  await waitFor(
    async () => (await readPlanDom(state)).keywordChips.join("|") === "accessible",
    "keyword removed",
    state,
  );
  await setPageValue(state, '[data-testid="plan-design-keyword-input"]', "glassmorphism", "keyword input");
  await clickSelector(state, '[data-testid="plan-design-keyword-add"]', "add keyword");
  await waitFor(
    async () => (await readPlanDom(state)).keywordChips.join("|") === "accessible|glassmorphism",
    "keyword added",
    state,
  );

  await setPageValue(
    state,
    '[data-testid="plan-design-color"][data-group="primary"][data-index="0"]',
    "#3050C8",
    "primary color 0",
  );
  await setPageValue(state, '[data-testid="plan-design-font-family"]', "Roboto", "font family");
  await setPageValue(state, '[data-testid="plan-design-component-library"]', "shadcn", "component library");
  dom = await waitFor(
    async () => {
      const current = await readPlanDom(state);
      return current.fontFamily === "Roboto" &&
        current.componentLibrary === "shadcn" &&
        current.colors.some((color) => color.group === "primary" && color.index === 0 && color.value.toLowerCase() === "#3050c8")
        ? current
        : null;
    },
    "edited design values",
    state,
  );
  assert(
    dom.colors.some((color) => color.group === "primary" && color.index === 0 && color.value.toLowerCase() === "#3050c8"),
    `primary color swatch did not update: ${json(dom.colors)}`,
  );
  assert(
    dom.colors.some((color) => color.group === "primary" && color.index === 0 && color.code === "#3050C8"),
    `primary color code label mismatch: ${json(dom.colors)}`,
  );
  await scrollSelectorIntoView(state, '[data-testid="plan-design-keyword-chip"]');
  await captureScreenshot(state, "plan-design-edited");

  // (e) Draft dependency graph: 4 nodes, edited edges, chips name s3.
  dom = await readPlanDom(state);
  assert(
    dom.rows[3].deps.join("|") === "3. Build page",
    `new step dependency chip did not name s3: ${json(dom.rows[3].deps)}`,
  );
  await clickGraphToggle(state);
  dom = await waitFor(
    async () => {
      const current = await readPlanDom(state);
      return current.graphChecked && current.flowNodes.length === 4 ? current : null;
    },
    "draft dependency graph with 4 nodes",
    state,
  );
  assert(dom.flowEdges === 3, `draft graph edge count mismatch: ${dom.flowEdges}`);
  assert(
    dom.flowNodes.map((node) => node.stepId).sort().join(",") === [newStepId, "s1", "s2", "s3"].sort().join(","),
    `draft graph node ids mismatch: ${json(dom.flowNodes)}`,
  );
  assert(
    dom.flowNodes.every((node) => node.status === "pending"),
    `draft graph node statuses mismatch: ${json(dom.flowNodes)}`,
  );
  await captureScreenshot(state, "plan-graph-draft");

  // (e2) Type into the WYSIWYG plan body at the end of the Goal paragraph.
  await scrollSelectorIntoView(state, '[data-testid="plan-markdown-editor"]');
  const caret = await state.cdp.evaluate(`(() => {
    const editor = document.querySelector('[data-testid="plan-markdown-editor"]');
    const paragraph = [...(editor?.querySelectorAll("p") ?? [])].find((node) => node.textContent.includes("drives execution."));
    if (!paragraph) return false;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
  assert(caret === true, "plan body editor or Goal paragraph missing");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await state.cdp.send("Input.insertText", { text: BODY_EDIT });
  await waitFor(
    async () => state.cdp.evaluate(`document.querySelector('[data-testid="plan-markdown-editor"]')?.textContent.includes(${JSON.stringify(BODY_EDIT.trim())})`),
    "typed plan body edit",
    state,
  );
  await captureScreenshot(state, "plan-body-edited");

  // (f) Build with the Ask default and verify the approved revision.
  await scrollSelectorIntoView(state, '[data-testid="plan-tab"] .plan-tab-actions');
  await clickSelector(state, '[data-testid="plan-tab"] .plan-approval-approve-menu', "plan tab approval mode menu");
  await waitFor(
    async () => (await readPlanDom(state)).approveMenuOpen,
    "plan tab approval mode menu open",
    state,
  );
  dom = await readPlanDom(state);
  assert(dom.askModeSelected === true, `Ask was not the default approval mode: ${json(dom)}`);
  await clickSelector(state, '[data-testid="plan-tab"] .plan-approval-approve-menu', "close plan tab approval mode menu");
  await waitFor(
    async () => !(await readPlanDom(state)).approveMenuOpen,
    "plan tab approval mode menu closed",
    state,
  );

  await clickSelector(state, '[data-testid="plan-tab-build"]', "Build");
  await waitFor(
    async () => {
      const session = await getSession(state, sessionId);
      const snapshot = await h.inspectUi(state);
      return session?.mode === "agent" && snapshot.bar === null ? snapshot : null;
    },
    "approved interactive plan switched to Agent mode",
    state,
  );
  const plansResult = await getPreloadResult(state, "plansGet", [{ sessionId, proposalId }]);
  const proposal = plansResult.proposal;
  assert(proposal?.status === "approved", `interactive plan was not approved: ${json(proposal)}`);
  const expectedEditedSteps = editedStepsFor(newStepId);
  assert(
    deepEqual(proposal.resolvedSteps, expectedEditedSteps),
    `resolved steps mismatch: ${json(proposal.resolvedSteps)}`,
  );
  assert(
    deepEqual(proposal.resolvedDesign, EXPECTED_EDITED_DESIGN),
    `resolved design mismatch: ${json(proposal.resolvedDesign)}`,
  );
  assert(
    proposal.markdown.includes(`edited in the Plan tab and that the approved revision, not the submitted one, drives execution.${BODY_EDIT}`) &&
      proposal.artifact.relativePath !== submit.proposal.artifact.relativePath,
    `approved body was not the edited artifact: ${json({ markdown: proposal.markdown, artifact: proposal.artifact })}`,
  );
  const workspacePath = (relativePath) => join(state.workspace, ...relativePath.split("/"));
  assert(
    await readFile(workspacePath(proposal.artifact.relativePath), "utf8") === proposal.markdown &&
      await readFile(workspacePath(submit.proposal.artifact.relativePath), "utf8") === CHECKPOINT.markdown,
    "edited artifact bytes or the preserved submitted artifact mismatch",
  );

  const todosSnapshot = await getPreloadResult(state, "todosGet", [{ sessionId }]);
  const seededTodos = expectedEditedSteps.map((step) => ({
    content: step.title,
    status: "pending",
    priority: "medium",
    stepId: step.id,
  }));
  assert(
    deepEqual(todosSnapshot.todos, seededTodos),
    `seeded checklist mismatch: ${json(todosSnapshot.todos)}`,
  );

  // Push TodoWrite progress on the still-running submit turn, then settle it
  // so the renderer can dispatch the approved plan.
  const todoPush = await runPlanProbe(state, {
    operation: "todo",
    sessionId,
    turnId: submitTurnId,
    todos: progressTodosFor(newStepId),
  });
  assert(
    todoPush.response?.ok === true && todoPush.response?.toolCallId === "plan-ui-probe-todo",
    `todo push failed: ${json(todoPush)}`,
  );
  await settlePlanProbe(state, sessionId, submitTurnId, "completed");

  dom = await waitFor(
    async () => {
      const current = await readPlanDom(state);
      return current.progressText.startsWith("1 / 4 done") ? current : null;
    },
    "plan progress 1 / 4 done",
    state,
  );
  const expectedProgress = [
    { stepId: "s1", status: "completed" },
    { stepId: "s2", status: "pending" },
    { stepId: "s3", status: "in_progress" },
    { stepId: newStepId, status: "pending" },
  ];
  assert(
    deepEqual(dom.progressSteps, expectedProgress),
    `progress step statuses mismatch: ${json(dom.progressSteps)}`,
  );
  assert(
    dom.rows.length === 0 && dom.build === false && dom.reject === false,
    `approved plan still rendered editable controls: ${json(dom)}`,
  );
  await scrollSelectorIntoView(state, '[data-testid="plan-progress"]');
  await captureScreenshot(state, "plan-progress");

  const snapshot = await h.inspectUi(state);
  if (snapshot.executionErrorText) {
    assert(
      classifyExpectedDiagnostic(snapshot.executionErrorText, "interactive plan execution"),
      `unexpected visible execution error: ${snapshot.executionErrorText}`,
    );
  }

  await clickGraphToggle(state);
  dom = await waitFor(
    async () => {
      const current = await readPlanDom(state);
      return current.graphChecked && current.flowNodes.length === 4 ? current : null;
    },
    "progress dependency graph with 4 nodes",
    state,
  );
  const nodeStatus = new Map(dom.flowNodes.map((node) => [node.stepId, node.status]));
  assert(
    nodeStatus.get("s1") === "completed" &&
      nodeStatus.get("s3") === "in_progress" &&
      nodeStatus.get("s2") === "pending" &&
      nodeStatus.get(newStepId) === "pending",
    `progress graph node statuses mismatch: ${json(dom.flowNodes)}`,
  );
  await captureScreenshot(state, "plan-graph-progress");

  record(
    "E2E-PLAN-interactive-tab-edit-build-progress",
    true,
    `plan tab edits (rename/delete/add/dependency cycle guard), design edits, draft graph, Ask Build with resolved revision, and checklist progress verified (session ${sessionId})`,
  );
}
