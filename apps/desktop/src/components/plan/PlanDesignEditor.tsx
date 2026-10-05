import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PLAN_COLORS_PER_GROUP_MAX,
  PLAN_COLOR_GROUPS,
  PLAN_COMPONENT_LIBRARY_OPTIONS,
  PLAN_FONT_FAMILY_PRESETS,
  PLAN_FONT_SIZE_OPTIONS,
  PLAN_FONT_WEIGHT_OPTIONS,
  PLAN_FRAMEWORK_OPTIONS,
  PLAN_STYLE_KEYWORDS_MAX,
  type PlanColorGroup,
  type PlanDesignSpec,
} from "@pi-desktop/shared";
import type { PlanDraftAction } from "../../features/plan/plan-draft-model";
import { Badge, Button, Input, Select, TooltipButton } from "../ui";
import { IconPlus, IconX } from "../icons";

type Dispatch = (action: PlanDraftAction) => void;

const FONT_LEVELS = ["heading", "subheading", "body"] as const;
const CUSTOM_FONT = "__custom__";

function StyleKeywordsEditor({ design, dispatch }: { design: PlanDesignSpec; dispatch: Dispatch }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const keywords = design.styleKeywords ?? [];
  const add = () => {
    const keyword = value.trim();
    setValue("");
    if (!keyword) return;
    if (keywords.some((existing) => existing.toLowerCase() === keyword.toLowerCase())) return;
    if (keywords.length >= PLAN_STYLE_KEYWORDS_MAX) return;
    dispatch({ type: "designAddKeyword", value: keyword });
  };
  return (
    <div>
      <h3>{t("plan.styleKeywords")}</h3>
      <div className="plan-tab-chips">
        {keywords.map((keyword, index) => (
          <Badge key={keyword} data-testid="plan-design-keyword-chip">
            {keyword}
            <TooltipButton
              type="button"
              className="plan-chip-remove"
              data-testid="plan-design-keyword-remove"
              tooltip={t("plan.removeKeyword", { keyword })}
              ariaLabel={t("plan.removeKeyword", { keyword })}
              onClick={() => dispatch({ type: "designRemoveKeyword", index })}
            >
              <IconX size={11} aria-hidden />
            </TooltipButton>
          </Badge>
        ))}
      </div>
      <div className="plan-keywords-input-row">
        <Input
          value={value}
          aria-label={t("plan.styleKeywords")}
          placeholder={t("plan.keywordPlaceholder")}
          data-testid="plan-design-keyword-input"
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          size="sm"
          data-testid="plan-design-keyword-add"
          disabled={!value.trim() || keywords.length >= PLAN_STYLE_KEYWORDS_MAX}
          onClick={add}
        >
          {t("plan.addKeyword")}
        </Button>
      </div>
    </div>
  );
}

function TypographyEditor({ design, dispatch }: { design: PlanDesignSpec; dispatch: Dispatch }) {
  const { t } = useTranslation();
  const font = design.fontSystem;
  if (!font) return null;
  const preset = PLAN_FONT_FAMILY_PRESETS.some((preset) => preset.value === font.fontFamily);
  const familyValue = preset ? font.fontFamily : CUSTOM_FONT;
  const headingSpec = font.heading ?? { size: "24px", weight: 700 };
  const subheadingSpec = font.subheading ?? { size: "18px", weight: 600 };
  const bodySpec = font.body ?? { size: "14px", weight: 400 };

  return (
    <div>
      <h3>{t("plan.typography")}</h3>
      <div className="plan-font-family-row">
        <Select
          aria-label={t("plan.fontFamilyLabel")}
          value={familyValue}
          data-testid="plan-design-font-family"
          onChange={(event) => {
            if (event.currentTarget.value !== CUSTOM_FONT) {
              dispatch({ type: "designSetFontFamily", value: event.currentTarget.value });
            }
          }}
        >
          {PLAN_FONT_FAMILY_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>{preset.label}</option>
          ))}
          <option value={CUSTOM_FONT}>{t("plan.customFont")}</option>
        </Select>
        {!preset && (
          <Input
            value={font.fontFamily}
            aria-label={t("plan.customFontLabel")}
            onChange={(event) => dispatch({ type: "designSetFontFamily", value: event.currentTarget.value })}
          />
        )}
      </div>
      <div className="plan-font-levels">
        {FONT_LEVELS.map((level) => {
          const current = font[level] ?? { size: "16px", weight: 400 };
          const sizes = PLAN_FONT_SIZE_OPTIONS.includes(current.size as (typeof PLAN_FONT_SIZE_OPTIONS)[number])
            ? PLAN_FONT_SIZE_OPTIONS
            : [...PLAN_FONT_SIZE_OPTIONS, current.size];
          return (
            <div key={level} className="plan-font-level-row">
              <span className="plan-font-level-label plan-tab-muted">{t(`plan.${level}`)}</span>
              <div className="plan-font-level-controls">
                <Select
                  className="plan-font-size-select"
                  aria-label={t("plan.fontSizeLabel", { level: t(`plan.${level}`) })}
                  value={current.size}
                  onChange={(event) =>
                    dispatch({ type: "designSetFontLevel", level, size: event.currentTarget.value })
                  }
                >
                  {sizes.map((size) => <option key={size} value={size}>{size}</option>)}
                </Select>
                <Select
                  className="plan-font-weight-select"
                  aria-label={t("plan.fontWeightLabel", { level: t(`plan.${level}`) })}
                  value={String(current.weight)}
                  onChange={(event) =>
                    dispatch({ type: "designSetFontLevel", level, weight: Number(event.currentTarget.value) })
                  }
                >
                  {PLAN_FONT_WEIGHT_OPTIONS.map((weight) => (
                    <option key={weight} value={String(weight)}>
                      {weight} · {t(`plan.fontWeights.${weight}`)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          );
        })}
      </div>
      <div className="plan-font-preview-card" style={{ fontFamily: font.fontFamily }}>
        <div className="plan-preview-line plan-preview-line--heading" style={{ fontFamily: font.fontFamily, fontSize: headingSpec.size, fontWeight: headingSpec.weight }}>
          <span className="plan-preview-text">{t("plan.fontPreview")}</span>
          <span className="plan-preview-annotation">{headingSpec.size} · {headingSpec.weight}</span>
        </div>
        <div className="plan-preview-line plan-preview-line--subheading" style={{ fontFamily: font.fontFamily, fontSize: subheadingSpec.size, fontWeight: subheadingSpec.weight }}>
          <span className="plan-preview-text">{t("plan.fontPreview")}</span>
          <span className="plan-preview-annotation">{subheadingSpec.size} · {subheadingSpec.weight}</span>
        </div>
        <div className="plan-preview-line plan-preview-line--body" style={{ fontFamily: font.fontFamily, fontSize: bodySpec.size, fontWeight: bodySpec.weight }}>
          <span className="plan-preview-text">{t("plan.fontPreview")}</span>
          <span className="plan-preview-annotation">{bodySpec.size} · {bodySpec.weight}</span>
        </div>
      </div>
    </div>
  );
}

function ColorGroupEditor({
  design,
  group,
  dispatch,
}: {
  design: PlanDesignSpec;
  group: PlanColorGroup;
  dispatch: Dispatch;
}) {
  const { t } = useTranslation();
  const colors = design.colorSystem?.[group] ?? [];
  return (
    <div className="plan-color-group">
      <div className="plan-color-group-label">{t(`plan.colorGroups.${group}`)}</div>
      <div className="plan-color-swatches-row">
        {colors.map((color, index) => (
          <div className="plan-color" key={`${index}:${color}`}>
            <label className="plan-color-field">
              <span className="sr-only">
                {t("plan.colorSwatchLabel", { group: t(`plan.colorGroups.${group}`), index: index + 1 })}
              </span>
              <input
                type="color"
                className="plan-color-swatch"
                data-testid="plan-design-color"
                data-group={group}
                data-index={index}
                value={color}
                onChange={(event) =>
                  dispatch({ type: "designSetColor", group, index, value: event.currentTarget.value.toUpperCase() })
                }
              />
            </label>
            <code>{color}</code>
            <TooltipButton
              type="button"
              className="plan-chip-remove"
              tooltip={t("plan.removeColor")}
              ariaLabel={t("plan.removeColor")}
              onClick={() => dispatch({ type: "designRemoveColor", group, index })}
            >
              <IconX size={11} aria-hidden />
            </TooltipButton>
          </div>
        ))}
        <TooltipButton
          type="button"
          className="plan-color-add-btn"
          tooltip={t("plan.addColor")}
          ariaLabel={t("plan.addColor")}
          disabled={colors.length >= PLAN_COLORS_PER_GROUP_MAX}
          onClick={() => dispatch({ type: "designAddColor", group })}
        >
          <IconPlus size={13} aria-hidden />
        </TooltipButton>
      </div>
    </div>
  );
}

function SlugSelect({
  label,
  value,
  presets,
  testId,
  onChange,
}: {
  label: string;
  value: string | undefined;
  presets: readonly string[];
  /** Stable selector hook for E2E (`plan-design-framework`, `plan-design-component-library`). */
  testId?: string;
  onChange: (value: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const custom = value && !presets.includes(value) ? value : undefined;
  return (
    <Select
      aria-label={label}
      value={value ?? ""}
      data-testid={testId}
      onChange={(event) => onChange(event.currentTarget.value || undefined)}
    >
      <option value="">{t("plan.none")}</option>
      {presets.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
      {custom ? <option value={custom}>{custom}</option> : null}
    </Select>
  );
}

/**
 * Editable design spec for a pending local Plan draft. Only rendered when the
 * submitted proposal carried a design; plans submitted without one never grow
 * a design section here.
 */
export function PlanDesignEditor({ design, dispatch }: { design: PlanDesignSpec; dispatch: Dispatch }) {
  const { t } = useTranslation();
  return (
    <section className="plan-tab-section" aria-label={t("plan.designSpec")}>
      <h2>{t("plan.designSpec")}</h2>
      <div className="plan-design-grid">
        <div className="plan-design-column">
          <StyleKeywordsEditor design={design} dispatch={dispatch} />
          <TypographyEditor design={design} dispatch={dispatch} />
        </div>
        <div className="plan-design-column">
          <div>
            <h3>{t("plan.colors")}</h3>
            {PLAN_COLOR_GROUPS.map((group) => (
              <ColorGroupEditor key={group} design={design} group={group} dispatch={dispatch} />
            ))}
          </div>
          <div>
            <div className="plan-slug-row">
              <div className="plan-slug-item">
                <span className="plan-tab-muted">{t("plan.framework")}</span>
                <SlugSelect
                  label={t("plan.framework")}
                  value={design.framework}
                  presets={PLAN_FRAMEWORK_OPTIONS}
                  testId="plan-design-framework"
                  onChange={(value) => dispatch({ type: "designSetFramework", value })}
                />
              </div>
              <div className="plan-slug-item">
                <span className="plan-tab-muted">{t("plan.componentLibrary")}</span>
                <SlugSelect
                  label={t("plan.componentLibrary")}
                  value={design.componentLibrary}
                  presets={PLAN_COMPONENT_LIBRARY_OPTIONS}
                  testId="plan-design-component-library"
                  onChange={(value) => dispatch({ type: "designSetComponentLibrary", value })}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
