import {
  isPlanRecord,
  PLAN_CONTROL_PATTERN,
  planJsonLimitError,
  planUnknownKey,
  planValidationError,
  type PlanValidationResult,
} from "./plan-validation.js";

export type PlanFontLevel = { size: string; weight: number };
export type PlanColorGroup = "primary" | "background" | "text" | "functional";
export type PlanDesignSpec = {
  framework?: string;
  componentLibrary?: string;
  styleKeywords?: string[];
  fontSystem?: {
    fontFamily: string;
    heading?: PlanFontLevel;
    subheading?: PlanFontLevel;
    body?: PlanFontLevel;
  };
  colorSystem?: Partial<Record<PlanColorGroup, string[]>>;
};

export const PLAN_FONT_SIZE_OPTIONS = ["12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px", "36px", "40px", "48px"] as const;
export const PLAN_FONT_WEIGHT_OPTIONS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
export const PLAN_FONT_FAMILY_PRESETS = [
  { value: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', label: "System UI" },
  ...["Inter", "Roboto", "Montserrat", "SF Pro Display", "PingFang SC", "Arial", "Helvetica", "Georgia", "Times New Roman", "Courier New"].map((name) => ({ value: name, label: name })),
] as const;
export const PLAN_FRAMEWORK_OPTIONS = ["react", "vue", "svelte", "angular", "html"] as const;
export const PLAN_COMPONENT_LIBRARY_OPTIONS = ["shadcn", "mui", "antd", "tdesign", "element-plus", "chakra"] as const;
export const PLAN_COLOR_GROUPS = ["primary", "background", "text", "functional"] as const;
export const PLAN_DESIGN_SLUG_MAX = 40;
export const PLAN_STYLE_KEYWORDS_MAX = 12;
export const PLAN_STYLE_KEYWORD_MAX = 40;
export const PLAN_COLORS_PER_GROUP_MAX = 8;
export const PLAN_FONT_FAMILY_MAX = 120;
export const PLAN_FONT_SIZE_MIN = 10;
export const PLAN_FONT_SIZE_MAX = 72;
export const PLAN_FONT_WEIGHT_MIN = 100;
export const PLAN_FONT_WEIGHT_MAX = 900;
export const PLAN_DESIGN_JSON_MAX_BYTES = 16 * 1024;
export const PLAN_HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const FONT_LEVELS = ["heading", "subheading", "body"] as const;
const invalid = (path: string, reason: string) => planValidationError("PLAN_DESIGN_INVALID", path, reason);

// Mirrors the Rust authority (crates/host-core/src/plans/metadata/design.rs):
// normalization drops empty collections, so a design that only carried empty
// collections normalizes to `{}`, and the serialized-JSON byte cap applies to
// the normalized value only (the authority never caps the raw input).
export function validatePlanDesign(value: unknown): PlanValidationResult<PlanDesignSpec> {
  if (!isPlanRecord(value)) return invalid("design", "expected an object");
  const unknownKey = planUnknownKey(value, ["framework", "componentLibrary", "styleKeywords", "fontSystem", "colorSystem"]);
  if (unknownKey !== undefined) return invalid(`design.${unknownKey}`, "unknown key");
  const spec: PlanDesignSpec = {};
  for (const key of ["framework", "componentLibrary"] as const) {
    const input = value[key];
    if (input === undefined) continue;
    if (typeof input !== "string") return invalid(`design.${key}`, "expected a string");
    const slug = input.trim().toLowerCase();
    if (!slug) continue;
    if (slug.length > PLAN_DESIGN_SLUG_MAX || !/^[a-z0-9][a-z0-9.+/_-]*$/.test(slug)) {
      return invalid(`design.${key}`, `expected a 1..${PLAN_DESIGN_SLUG_MAX} character lowercase slug`);
    }
    spec[key] = slug;
  }
  if (value.styleKeywords !== undefined) {
    if (!Array.isArray(value.styleKeywords) || value.styleKeywords.length > PLAN_STYLE_KEYWORDS_MAX) {
      return invalid("design.styleKeywords", `expected an array of at most ${PLAN_STYLE_KEYWORDS_MAX} keywords`);
    }
    const keywords: string[] = [];
    const seen = new Set<string>();
    for (const [index, input] of value.styleKeywords.entries()) {
      const path = `design.styleKeywords[${index}]`;
      if (typeof input !== "string") return invalid(path, "expected a string");
      const keyword = input.trim();
      if (!keyword || [...keyword].length > PLAN_STYLE_KEYWORD_MAX || PLAN_CONTROL_PATTERN.test(keyword)) {
        return invalid(path, `expected 1..${PLAN_STYLE_KEYWORD_MAX} characters without control characters`);
      }
      if (seen.has(keyword.toLowerCase())) return invalid(path, `duplicate keyword "${keyword}"`);
      seen.add(keyword.toLowerCase());
      keywords.push(keyword);
    }
    if (keywords.length) spec.styleKeywords = keywords;
  }
  if (value.fontSystem !== undefined) {
    const font = value.fontSystem;
    if (!isPlanRecord(font)) return invalid("design.fontSystem", "expected an object");
    const key = planUnknownKey(font, ["fontFamily", ...FONT_LEVELS]);
    if (key !== undefined) return invalid(`design.fontSystem.${key}`, "unknown key");
    if (typeof font.fontFamily !== "string") return invalid("design.fontSystem.fontFamily", "expected a string");
    const fontFamily = font.fontFamily.trim();
    if (!fontFamily || [...fontFamily].length > PLAN_FONT_FAMILY_MAX || PLAN_CONTROL_PATTERN.test(fontFamily)) {
      return invalid("design.fontSystem.fontFamily", `expected 1..${PLAN_FONT_FAMILY_MAX} characters without control characters`);
    }
    spec.fontSystem = { fontFamily };
    for (const level of FONT_LEVELS) {
      const input = font[level];
      if (input === undefined) continue;
      const path = `design.fontSystem.${level}`;
      if (!isPlanRecord(input)) return invalid(path, "expected an object");
      const unknown = planUnknownKey(input, ["size", "weight"]);
      if (unknown !== undefined) return invalid(`${path}.${unknown}`, "unknown key");
      if (typeof input.size !== "string" || input.size !== input.size.trim() || !/^\d{1,2}px$/.test(input.size)
        || Number.parseInt(input.size, 10) < PLAN_FONT_SIZE_MIN || Number.parseInt(input.size, 10) > PLAN_FONT_SIZE_MAX) {
        return invalid(`${path}.size`, `expected a pixel size from ${PLAN_FONT_SIZE_MIN}px to ${PLAN_FONT_SIZE_MAX}px`);
      }
      if (typeof input.weight !== "number" || !Number.isInteger(input.weight)
        || input.weight < PLAN_FONT_WEIGHT_MIN || input.weight > PLAN_FONT_WEIGHT_MAX || input.weight % 100 !== 0) {
        return invalid(`${path}.weight`, "expected an integer weight from 100 to 900 in multiples of 100");
      }
      spec.fontSystem[level] = { size: input.size, weight: input.weight };
    }
  }
  if (value.colorSystem !== undefined) {
    const colors = value.colorSystem;
    if (!isPlanRecord(colors)) return invalid("design.colorSystem", "expected an object");
    const key = planUnknownKey(colors, PLAN_COLOR_GROUPS);
    if (key !== undefined) return invalid(`design.colorSystem.${key}`, "unknown key");
    const normalized: Partial<Record<PlanColorGroup, string[]>> = {};
    for (const group of PLAN_COLOR_GROUPS) {
      const input = colors[group];
      if (input === undefined) continue;
      const path = `design.colorSystem.${group}`;
      if (!Array.isArray(input) || input.length > PLAN_COLORS_PER_GROUP_MAX) return invalid(path, `expected an array of at most ${PLAN_COLORS_PER_GROUP_MAX} colors`);
      const groupColors: string[] = [];
      for (const [index, color] of input.entries()) {
        if (typeof color !== "string" || color.length !== 7 || !PLAN_HEX_COLOR_PATTERN.test(color)) return invalid(`${path}[${index}]`, "use #RRGGBB");
        groupColors.push(color.toUpperCase());
      }
      // Empty groups are dropped; a colorSystem without a non-empty group is absent.
      if (groupColors.length) normalized[group] = groupColors;
    }
    if (Object.keys(normalized).length) spec.colorSystem = normalized;
  }
  // Byte cap on the normalized JSON, like the Rust authority's byte_cap.
  const normalizedByteError = planJsonLimitError(spec, PLAN_DESIGN_JSON_MAX_BYTES, "PLAN_DESIGN_INVALID", "design");
  return normalizedByteError ?? { ok: true, value: spec };
}

export function isPlanDesignEmpty(spec: PlanDesignSpec): boolean {
  return !spec.framework && !spec.componentLibrary && !spec.styleKeywords?.length && !spec.fontSystem
    && !PLAN_COLOR_GROUPS.some((group) => spec.colorSystem?.[group]?.length);
}

/** Deep equality for normalized designs, independent of object key insertion order.
 * Empty collections are dropped by normalization, so an empty collection
 * compares equal to an absent key. */
export function planDesignEqual(a: PlanDesignSpec, b: PlanDesignSpec): boolean {
  const arrayEqual = (left: string[] | undefined, right: string[] | undefined) => {
    const values = left ?? [];
    const others = right ?? [];
    return values.length === others.length && values.every((value, index) => value === others[index]);
  };
  if (a.framework !== b.framework || a.componentLibrary !== b.componentLibrary || !arrayEqual(a.styleKeywords, b.styleKeywords)) return false;
  if ((a.fontSystem === undefined) !== (b.fontSystem === undefined) || a.fontSystem?.fontFamily !== b.fontSystem?.fontFamily) return false;
  for (const level of FONT_LEVELS) {
    if (a.fontSystem?.[level]?.size !== b.fontSystem?.[level]?.size || a.fontSystem?.[level]?.weight !== b.fontSystem?.[level]?.weight) return false;
  }
  return PLAN_COLOR_GROUPS.every((group) => arrayEqual(a.colorSystem?.[group], b.colorSystem?.[group]));
}
