import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  validatePlanDesign,
  validatePlanSteps,
  type PlanDesignSpec,
  type PlanStep,
  type ProposalKind,
} from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";
import { planWorkspaceRequiredResult } from "./plan-workspace-error.js";

export function submitToolParameters(kind: ProposalKind) {
  const base = {
    title: Type.String({
      description:
        kind === "plan"
          ? "A concise title for the implementation plan."
          : "A concise title naming the goal.",
    }),
    markdown: Type.String({
      description:
        kind === "plan"
          ? "The exact Markdown implementation plan, including files, behavior, and validation."
          : "The exact Markdown goal contract, with a Goal section, an Acceptance criteria section of objectively checkable items, and a Boundaries section. Describe outcomes, not implementation steps.",
    }),
    question: Type.String({
      description:
        kind === "plan"
          ? "The question or decision the user should answer when approving this plan."
          : "The question or decision the user should answer when approving this goal contract.",
    }),
  };
  if (kind === "goal") return Type.Object(base);

  const fontLevel = Type.Object({
    size: Type.String({ description: 'Pixel size like "16px" (10–72px).' }),
    weight: Type.Number({ description: "Weight 100–900 in multiples of 100." }),
  });
  const colors = Type.Array(Type.String({ description: 'Color in "#RRGGBB" format.' }));
  return Type.Object({
    ...base,
    steps: Type.Optional(Type.Array(Type.Object({
      id: Type.String({ description: "Stable kebab-case step id." }),
      title: Type.String({ description: "Short concrete implementation step." }),
      detail: Type.Optional(Type.String({ description: "Additional implementation detail." })),
      dependsOn: Type.Optional(Type.Array(Type.String(), {
        description: "Ids of steps that must finish first.",
      })),
    }), {
      maxItems: 24,
      description: 'Structured implementation steps; mirror them in a "Steps" section in Markdown.',
    })),
    design: Type.Optional(Type.Object({
      framework: Type.Optional(Type.String({ description: "Framework slug, e.g. react." })),
      componentLibrary: Type.Optional(Type.String({ description: "Component library slug, e.g. shadcn." })),
      styleKeywords: Type.Optional(Type.Array(Type.String(), { description: "Short visual style keywords." })),
      fontSystem: Type.Optional(Type.Object({
        fontFamily: Type.String({ description: "Font family or font stack." }),
        heading: Type.Optional(fontLevel),
        subheading: Type.Optional(fontLevel),
        body: Type.Optional(fontLevel),
      })),
      colorSystem: Type.Optional(Type.Object({
        primary: Type.Optional(colors),
        background: Type.Optional(colors),
        text: Type.Optional(colors),
        functional: Type.Optional(colors),
      })),
    }, {
      description: 'Only for tasks that create or substantially redesign a UI; mirror in a "Design" section in Markdown.',
    })),
  });
}

function metadataError(errorCode: string, message: string): AgentToolResult<unknown> {
  return {
    content: [{
      type: "text",
      text: `${message} Fix the structured field and call SubmitPlan again with the complete snapshot. No approval was created.`,
    }],
    details: { errorCode },
    isError: true,
  };
}

type SubmitArguments = {
  ok: true;
  title: string;
  markdown: string;
  question: string;
  steps?: PlanStep[];
  design?: PlanDesignSpec;
} | { ok: false; result: AgentToolResult<unknown> };

/** Models often send null for optional fields; the host RPC also treats a JSON
 * null as an absent field, so null must not read as "present" here. */
const isMetadataPresent = (value: unknown): boolean => value !== undefined && value !== null;

export function parseSubmitArguments(kind: ProposalKind, params: unknown): SubmitArguments {
  if (kind === "goal" && isRecord(params) && (isMetadataPresent(params.steps) || isMetadataPresent(params.design))) {
    return { ok: false, result: metadataError("PLAN_METADATA_UNSUPPORTED", "PLAN_METADATA_UNSUPPORTED: Goal contracts do not support steps or design.") };
  }
  const title = isRecord(params) && typeof params.title === "string" ? params.title.trim() : "";
  const markdown = isRecord(params) && typeof params.markdown === "string" ? params.markdown : "";
  const question = isRecord(params) && typeof params.question === "string" ? params.question.trim() : "";
  if (!title || !markdown.trim() || !question) {
    return {
      ok: false,
      result: {
        content: [{ type: "text", text: `${kind === "plan" ? "SubmitPlan" : "SubmitGoal"} requires non-empty title, markdown, and question.` }],
        details: { errorCode: "PLAN_INVALID_ARGUMENT" },
        isError: true,
      },
    };
  }
  const parsed: SubmitArguments = { ok: true, title, markdown, question };
  if (kind === "plan" && isRecord(params)) {
    if (isMetadataPresent(params.steps)) {
      const steps = validatePlanSteps(params.steps);
      if (!steps.ok) return { ok: false, result: metadataError(steps.code, steps.message) };
      if (steps.value.length) parsed.steps = steps.value;
    }
    if (isMetadataPresent(params.design)) {
      const design = validatePlanDesign(params.design);
      if (!design.ok) return { ok: false, result: metadataError(design.code, design.message) };
      if (Object.keys(design.value).length) parsed.design = design.value;
    }
  }
  return parsed;
}

export function submitFailureResult(kind: ProposalKind, error: unknown): AgentToolResult<unknown> {
  const recovery = planWorkspaceRequiredResult(error);
  if (recovery) return recovery;
  const errorCode =
    (error as { data?: { errorCode?: string } })?.data?.errorCode ??
    "PLAN_SUBMIT_FAILED";
  if (["PLAN_STEPS_INVALID", "PLAN_DESIGN_INVALID", "PLAN_METADATA_UNSUPPORTED"].includes(errorCode)) {
    const message = isRecord(error) && typeof error.message === "string" ? error.message : errorCode;
    return metadataError(errorCode, message);
  }
  return {
    content: [{ type: "text", text: `${kind === "plan" ? "Plan" : "Goal"} submission failed: ${errorCode}` }],
    details: { errorCode },
    isError: true,
    terminate: true,
  };
}
