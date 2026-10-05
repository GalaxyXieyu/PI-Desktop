import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  PLAN_FLOW_COLUMN_GAP,
  PLAN_FLOW_NODE_HEIGHT,
  PLAN_FLOW_NODE_WIDTH,
  PLAN_FLOW_PADDING,
  PLAN_FLOW_ROW_GAP,
  planFlowchartLayout,
  planFlowTitleBudget,
  planFlowTitleWidth,
  truncatePlanFlowTitle,
} = await import("../src/features/plan/plan-flowchart-layout.ts");

const step = (id, dependsOn = []) => ({ id, title: `Title of ${id}`, dependsOn });

test("diamond graph: one column per layer, rows in layer order", () => {
  const steps = [step("d", ["b", "c"]), step("c", ["a"]), step("a"), step("b", ["a"])];
  const layout = planFlowchartLayout(steps);
  assert.deepEqual(layout.layers, [["a"], ["c", "b"], ["d"]]);
  assert.equal(layout.nodes.length, 4);
  assert.equal(layout.edges.length, 4);
  const byId = new Map(layout.nodes.map((node) => [node.stepId, node]));
  assert.deepEqual(
    [byId.get("a").x, byId.get("c").x, byId.get("d").x],
    [
      PLAN_FLOW_PADDING,
      PLAN_FLOW_PADDING + PLAN_FLOW_NODE_WIDTH + PLAN_FLOW_COLUMN_GAP,
      PLAN_FLOW_PADDING + 2 * (PLAN_FLOW_NODE_WIDTH + PLAN_FLOW_COLUMN_GAP),
    ],
  );
  assert.equal(byId.get("c").y, PLAN_FLOW_PADDING);
  assert.equal(byId.get("b").y, PLAN_FLOW_PADDING + PLAN_FLOW_NODE_HEIGHT + PLAN_FLOW_ROW_GAP);
  // Display index follows the input order, not the layer order.
  assert.equal(byId.get("d").index, 0);
  assert.equal(byId.get("a").index, 2);
  assert.equal(layout.width, PLAN_FLOW_PADDING * 2 + 3 * PLAN_FLOW_NODE_WIDTH + 2 * PLAN_FLOW_COLUMN_GAP);
});

test("chains lay out left to right on one row; edges bezier from right to left edge", () => {
  const layout = planFlowchartLayout([step("a"), step("b", ["a"]), step("c", ["b"])]);
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.edges.length, 2);
  assert.ok(layout.nodes.every((node) => node.y === PLAN_FLOW_PADDING));
  const [edge] = layout.edges;
  assert.equal(edge.from, "a");
  assert.equal(edge.to, "b");
  const x1 = PLAN_FLOW_PADDING + PLAN_FLOW_NODE_WIDTH;
  const x2 = PLAN_FLOW_PADDING + PLAN_FLOW_NODE_WIDTH + PLAN_FLOW_COLUMN_GAP;
  const mid = PLAN_FLOW_PADDING + PLAN_FLOW_NODE_HEIGHT / 2;
  assert.match(edge.path, /^M \d+ \d+ C \d+ \d+, \d+ \d+, \d+ \d+$/);
  assert.ok(edge.path.startsWith(`M ${x1} ${mid} `));
  assert.ok(edge.path.endsWith(`, ${x2} ${mid}`));
});

test("no dependencies collapse into a single column", () => {
  const layout = planFlowchartLayout([step("a"), step("b"), step("c")]);
  assert.equal(layout.layers.length, 1);
  assert.equal(layout.edges.length, 0);
  assert.ok(layout.nodes.every((node) => node.x === PLAN_FLOW_PADDING));
  assert.deepEqual(layout.nodes.map((node) => node.row), [0, 1, 2]);
  assert.equal(layout.height, PLAN_FLOW_PADDING * 2 + 3 * PLAN_FLOW_NODE_HEIGHT + 2 * PLAN_FLOW_ROW_GAP);
});

test("layout is deterministic and pure", () => {
  const steps = [step("a"), step("b", ["a"]), step("c", ["a"]), step("d", ["b", "c"])];
  assert.deepEqual(planFlowchartLayout(steps), planFlowchartLayout(steps));
  assert.deepEqual(planFlowchartLayout([]), {
    nodes: [], edges: [], layers: [], direction: "horizontal", width: 0,
    height: PLAN_FLOW_PADDING * 2 + PLAN_FLOW_NODE_HEIGHT,
  });
});

test("vertical layout: single-column positions, consecutive straight, skip edge uses gutter, lanes distinct, nodeWidth honoured", () => {
  const steps = [step("a"), step("b", ["a"]), step("c", ["a"]), step("d", ["b", "c"])];
  const customWidth = 220;
  const layout = planFlowchartLayout(steps, { direction: "vertical", nodeWidth: customWidth });
  assert.equal(layout.direction, "vertical");
  assert.deepEqual(layout.layers, [["a"], ["b", "c"], ["d"]]);
  assert.equal(layout.nodes.length, 4);
  assert.equal(layout.edges.length, 4);

  // Single-column positions: strictly increasing y, same x, nodeWidth honoured
  assert.ok(layout.nodes.every((node) => node.x === PLAN_FLOW_PADDING));
  assert.ok(layout.nodes.every((node) => node.width === customWidth));
  for (let i = 1; i < layout.nodes.length; i++) {
    assert.ok(layout.nodes[i].y > layout.nodes[i - 1].y, `Node ${i} y should be > node ${i - 1} y`);
  }

  // Row order: a (0), b (1), c (2), d (3)
  const byId = new Map(layout.nodes.map((node) => [node.stepId, node]));
  assert.equal(byId.get("a").row, 0);
  assert.equal(byId.get("b").row, 1);
  assert.equal(byId.get("c").row, 2);
  assert.equal(byId.get("d").row, 3);

  // Consecutive edge: a -> b (row 0 to 1) is straight vertical line
  const edgeAB = layout.edges.find((e) => e.from === "a" && e.to === "b");
  assert.ok(edgeAB);
  const midX = PLAN_FLOW_PADDING + customWidth / 2;
  const yBottomA = byId.get("a").y + byId.get("a").height;
  const yTopB = byId.get("b").y;
  assert.equal(edgeAB.path, `M ${midX} ${yBottomA} L ${midX} ${yTopB}`);

  // Consecutive edge: c -> d (row 2 to 3) is straight vertical line
  const edgeCD = layout.edges.find((e) => e.from === "c" && e.to === "d");
  assert.ok(edgeCD);
  const yBottomC = byId.get("c").y + byId.get("c").height;
  const yTopD = byId.get("d").y;
  assert.equal(edgeCD.path, `M ${midX} ${yBottomC} L ${midX} ${yTopD}`);

  // Skip edges: a -> c (span 2: row 0 to 2) and b -> d (span 2: row 1 to 3)
  const edgeAC = layout.edges.find((e) => e.from === "a" && e.to === "c");
  const edgeBD = layout.edges.find((e) => e.from === "b" && e.to === "d");
  assert.ok(edgeAC);
  assert.ok(edgeBD);

  // Both skip edges route through the right-hand gutter using cubic beziers
  assert.ok(edgeAC.path.startsWith(`M ${PLAN_FLOW_PADDING + customWidth} `));
  assert.ok(edgeBD.path.startsWith(`M ${PLAN_FLOW_PADDING + customWidth} `));
  assert.match(edgeAC.path, /^M \d+ \d+ C \d+ \d+, \d+ \d+, \d+ \d+$/);
  assert.match(edgeBD.path, /^M \d+ \d+ C \d+ \d+, \d+ \d+, \d+ \d+$/);

  // Lanes are distinct: extract control point X coordinates
  const extractGutterX = (path) => {
    const match = path.match(/^M \d+ \d+ C (\d+) \d+, (\d+) \d+, \d+ \d+$/);
    assert.ok(match, `Path ${path} should match bezier format`);
    return Number(match[1]);
  };
  const gutterX_AC = extractGutterX(edgeAC.path);
  const gutterX_BD = extractGutterX(edgeBD.path);
  assert.notEqual(gutterX_AC, gutterX_BD, "Skip edges must use distinct lanes in the gutter");
  assert.ok(gutterX_AC > PLAN_FLOW_PADDING + customWidth, "Gutter lane should be to the right of node");
  assert.ok(gutterX_BD > PLAN_FLOW_PADDING + customWidth, "Gutter lane should be to the right of node");
});

test("title budget shrinks with width and truncation ellipsizes", () => {
  assert.ok(planFlowTitleBudget() > 10);
  assert.ok(planFlowTitleBudget(100) < planFlowTitleBudget(200));
  assert.equal(truncatePlanFlowTitle("short", 10), "short");
  assert.equal(truncatePlanFlowTitle("a much longer title", 10), "a much lo…");
  assert.equal(truncatePlanFlowTitle("abcdef", 1), "…");
});

test("title budget counts East Asian wide characters as two units", () => {
  const budget = planFlowTitleBudget();
  assert.equal(planFlowTitleWidth("a."), 2);
  assert.equal(planFlowTitleWidth("实现"), 4); // CJK ideographs
  assert.equal(planFlowTitleWidth("アイウ"), 6); // kana
  assert.equal(planFlowTitleWidth("한글"), 4); // hangul
  assert.equal(planFlowTitleWidth("（）"), 4); // fullwidth punctuation U+FF00-FFEF
  assert.equal(planFlowTitleWidth("\ud867\ude3d"), 2); // plane-2 CJK ideograph (one code point)
  // 11 CJK characters measure 22 units and still fit the default budget.
  assert.equal(truncatePlanFlowTitle("实现主题切换与偏好持久", budget), "实现主题切换与偏好持久");
  // 12 CJK characters overflow: only 10 fit before the ellipsis.
  assert.equal(truncatePlanFlowTitle("实现主题切换与偏好持久化", budget), "实现主题切换与偏好持…");
  // Mixed label from the real app: "2. " costs 3 units, so fewer wide chars fit.
  assert.equal(truncatePlanFlowTitle("2. 实现主题切换与偏好持久化（验收已改名）", budget), "2. 实现主题切换与偏好…");
  // The full label stays available to <title> / aria text (see PlanFlowchart).
});
