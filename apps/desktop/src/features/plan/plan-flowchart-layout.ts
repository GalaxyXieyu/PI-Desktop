import { planStepTopoLayers, type PlanStep } from "@pi-desktop/shared";

/** Fixed node geometry of the hand-written plan DAG (px in SVG space). */
export const PLAN_FLOW_NODE_WIDTH = 180;
export const PLAN_FLOW_NODE_HEIGHT = 56;
export const PLAN_FLOW_COLUMN_GAP = 72;
export const PLAN_FLOW_ROW_GAP = 24;
export const PLAN_FLOW_PADDING = 16;

/** Left status bar plus inner padding that the title text must clear. */
const TITLE_INSET = 24;
/** Approximate advance width of one narrow character at the node font size. */
const TITLE_CHAR_WIDTH = 7;

/**
 * East Asian wide/fullwidth ranges (CJK ideographs, kana, hangul, CJK
 * punctuation, fullwidth forms): each character there takes two units of
 * the title budget, one narrow character takes one unit.
 */
const TITLE_WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // hangul jamo
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3041, 0x30ff], // hiragana + katakana
  [0x3400, 0x4dbf], // CJK ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7a3], // hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // fullwidth/halfwidth forms
  [0x20000, 0x3fffd], // CJK ideographs, plane 2 and 3 (extension B+)
];

/** Width of one code point in title units: East Asian wide/fullwidth = 2. */
function planFlowTitleCodePointWidth(codePoint: number): number {
  return TITLE_WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to) ? 2 : 1;
}

export type PlanFlowDirection = "horizontal" | "vertical";

export type PlanFlowchartLayoutOptions = {
  direction?: PlanFlowDirection;
  nodeWidth?: number;
};

export type PlanFlowNode = {
  stepId: string;
  /** Position of the step in the input list (0-based display index). */
  index: number;
  layer: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PlanFlowEdge = {
  /** Dependency step id (edge source). */
  from: string;
  /** Dependent step id (edge target). */
  to: string;
  /** Cubic Bézier SVG path between the source and target node edges. */
  path: string;
};

export type PlanFlowchartLayout = {
  nodes: PlanFlowNode[];
  edges: PlanFlowEdge[];
  width: number;
  height: number;
  /** Topo layers behind the layout, kept for the accessible summary. */
  layers: string[][];
  direction: PlanFlowDirection;
};

/**
 * Deterministic layered layout:
 * - horizontal: one column per topo layer, rows in layer order (left-to-right).
 * - vertical: layers stacked as rows (top-to-bottom), nodes of a layer side by side.
 * Pure and side-effect free; the same steps and options always produce identical output.
 */
export function planFlowchartLayout(
  steps: readonly PlanStep[],
  options?: PlanFlowchartLayoutOptions,
): PlanFlowchartLayout {
  const direction: PlanFlowDirection = options?.direction ?? "horizontal";
  const layers = planStepTopoLayers(steps);
  const nodes: PlanFlowNode[] = [];
  const byId = new Map<string, PlanFlowNode>();
  const indexOf = new Map(steps.map((step, index) => [step.id, index]));

  if (direction === "vertical") {
    const nodeWidth = options?.nodeWidth ?? PLAN_FLOW_NODE_WIDTH;
    const vRowGap = 32;
    let rowIndex = 0;
    layers.forEach((layer, layerIndex) => {
      layer.forEach((id) => {
        const node: PlanFlowNode = {
          stepId: id,
          index: indexOf.get(id) ?? 0,
          layer: layerIndex,
          row: rowIndex,
          x: PLAN_FLOW_PADDING,
          y: PLAN_FLOW_PADDING + rowIndex * (PLAN_FLOW_NODE_HEIGHT + vRowGap),
          width: nodeWidth,
          height: PLAN_FLOW_NODE_HEIGHT,
        };
        nodes.push(node);
        byId.set(id, node);
        rowIndex += 1;
      });
    });

    // Identify edges and sort skip-edges into distinct lanes in the gutter
    type PendingEdge = {
      from: string;
      to: string;
      srcRow: number;
      tgtRow: number;
      isConsecutive: boolean;
    };
    const pendingEdges: PendingEdge[] = [];
    for (const step of steps) {
      const target = byId.get(step.id);
      if (!target) continue;
      for (const dependencyId of step.dependsOn) {
        const source = byId.get(dependencyId);
        if (!source) continue;
        const isConsecutive = target.row === source.row + 1;
        pendingEdges.push({
          from: dependencyId,
          to: step.id,
          srcRow: source.row,
          tgtRow: target.row,
          isConsecutive,
        });
      }
    }

    // Sort skip edges deterministically: by span (larger span outer lane), then source row, target row
    const skipEdges = pendingEdges.filter((e) => !e.isConsecutive);
    skipEdges.sort((a, b) => {
      const spanA = a.tgtRow - a.srcRow;
      const spanB = b.tgtRow - b.srcRow;
      if (spanA !== spanB) return spanA - spanB;
      if (a.srcRow !== b.srcRow) return a.srcRow - b.srcRow;
      return a.tgtRow - b.tgtRow;
    });

    const laneMap = new Map<string, number>();
    skipEdges.forEach((e, idx) => {
      laneMap.set(`${e.from}->${e.to}`, idx);
    });

    const gutterLaneWidth = 16;
    const gutterBaseX = PLAN_FLOW_PADDING + nodeWidth + 14;

    const edges: PlanFlowEdge[] = [];
    for (const pe of pendingEdges) {
      const source = byId.get(pe.from)!;
      const target = byId.get(pe.to)!;
      if (pe.isConsecutive) {
        // Consecutive edge: straight vertical line from source bottom-center to target top-center
        const x = source.x + source.width / 2;
        const y1 = source.y + source.height;
        const y2 = target.y;
        edges.push({
          from: pe.from,
          to: pe.to,
          path: `M ${x} ${y1} L ${x} ${y2}`,
        });
      } else {
        // Skip edge: routes through the right-hand gutter in its dedicated lane
        const lane = laneMap.get(`${pe.from}->${pe.to}`) ?? 0;
        const gutterX = gutterBaseX + lane * gutterLaneWidth;
        const x1 = source.x + source.width;
        const y1 = source.y + source.height / 2;
        const x2 = target.x + target.width;
        const y2 = target.y + target.height / 2;
        const r = 8;
        // SVG path: from source right side, horizontal to gutterX - r, corner up/down to gutterX,
        // vertical along gutterX to y2 - r, corner back to target right side
        // Note: target arrow marker points into the target's right side (orient="auto" will orient correctly)
        const path = `M ${x1} ${y1} ` +
          `C ${gutterX} ${y1}, ${gutterX} ${y2}, ${x2} ${y2}`;
        edges.push({
          from: pe.from,
          to: pe.to,
          path,
        });
      }
    }

    const totalLanes = skipEdges.length;
    const gutterTotalWidth = totalLanes > 0 ? (totalLanes - 1) * gutterLaneWidth + 24 : 0;
    const totalWidth = PLAN_FLOW_PADDING * 2 + nodeWidth + (totalLanes > 0 ? 14 + gutterTotalWidth : 0);
    const totalHeight = nodes.length > 0
      ? PLAN_FLOW_PADDING * 2 + nodes.length * PLAN_FLOW_NODE_HEIGHT + (nodes.length - 1) * vRowGap
      : PLAN_FLOW_PADDING * 2 + PLAN_FLOW_NODE_HEIGHT;

    return {
      nodes,
      edges,
      layers,
      direction,
      width: totalWidth,
      height: totalHeight,
    };
  }

  layers.forEach((layer, layerIndex) => {
    layer.forEach((id, row) => {
      const node: PlanFlowNode = {
        stepId: id,
        index: indexOf.get(id) ?? 0,
        layer: layerIndex,
        row,
        x: PLAN_FLOW_PADDING + layerIndex * (PLAN_FLOW_NODE_WIDTH + PLAN_FLOW_COLUMN_GAP),
        y: PLAN_FLOW_PADDING + row * (PLAN_FLOW_NODE_HEIGHT + PLAN_FLOW_ROW_GAP),
        width: PLAN_FLOW_NODE_WIDTH,
        height: PLAN_FLOW_NODE_HEIGHT,
      };
      nodes.push(node);
      byId.set(id, node);
    });
  });
  const edges: PlanFlowEdge[] = [];
  for (const step of steps) {
    const target = byId.get(step.id);
    if (!target) continue;
    for (const dependencyId of step.dependsOn) {
      const source = byId.get(dependencyId);
      if (!source) continue;
      const x1 = source.x + source.width;
      const y1 = source.y + source.height / 2;
      const x2 = target.x;
      const y2 = target.y + target.height / 2;
      const bend = Math.max(24, Math.round((x2 - x1) / 2));
      edges.push({
        from: dependencyId,
        to: step.id,
        path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      });
    }
  }
  const rows = Math.max(1, ...layers.map((layer) => layer.length));
  return {
    nodes,
    edges,
    layers,
    direction,
    width: layers.length
      ? PLAN_FLOW_PADDING * 2 +
        layers.length * PLAN_FLOW_NODE_WIDTH +
        (layers.length - 1) * PLAN_FLOW_COLUMN_GAP
      : 0,
    height: PLAN_FLOW_PADDING * 2 +
      rows * PLAN_FLOW_NODE_HEIGHT +
      (rows - 1) * PLAN_FLOW_ROW_GAP,
  };
}

/**
 * Title budget in width units given the node width: the label is clipped to
 * what fits next to the status bar, and the full title stays available
 * through `<title>` / aria text.
 */
export function planFlowTitleBudget(width: number = PLAN_FLOW_NODE_WIDTH): number {
  return Math.max(1, Math.floor((width - TITLE_INSET) / TITLE_CHAR_WIDTH));
}

/** Measured width of a label: like `length`, but wide/fullwidth code points count as 2. */
export function planFlowTitleWidth(title: string): number {
  let units = 0;
  for (let index = 0; index < title.length; index += 1) {
    const code = title.codePointAt(index) ?? 0;
    units += planFlowTitleCodePointWidth(code);
    if (code > 0xffff) index += 1; // astral code points occupy two UTF-16 units
  }
  return units;
}

/**
 * Ellipsis-truncates a label to `maxUnits` width units, where East Asian
 * wide/fullwidth code points cost two units. The full title stays available
 * through `<title>` / aria text.
 */
export function truncatePlanFlowTitle(title: string, maxUnits: number): string {
  if (planFlowTitleWidth(title) <= maxUnits) return title;
  // Reserve one unit for the ellipsis, then trim trailing whitespace.
  const limit = Math.max(0, maxUnits - 1);
  let used = 0;
  let cut = 0;
  for (let index = 0; index < title.length; ) {
    const code = title.codePointAt(index) ?? 0;
    const width = planFlowTitleCodePointWidth(code);
    if (used + width > limit) break;
    used += width;
    index += code > 0xffff ? 2 : 1; // astral code points span two UTF-16 units
    cut = index;
  }
  return `${title.slice(0, cut).trimEnd()}…`;
}
