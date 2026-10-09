import type { ImageGenerationBindings, PlanTargetModel, ProviderPublic } from "@pi-desktop/shared";
import {
  composerModelDisplayName,
  composerModelsForProvider,
  sameComposerModelId,
} from "../../lib/composer-models";
import { providerDisplayName } from "../../lib/provider-display";

export type PlanExecutionModelOption = PlanTargetModel & {
  providerLabel: string;
  label: string;
};

/** Same availability rule as the composer model menu. */
export function planExecutionModelOptions(
  providers: readonly ProviderPublic[],
  imageGeneration?: ImageGenerationBindings | null,
): PlanExecutionModelOption[] {
  return providers
    .filter((provider) => provider.enabled && (provider.hasSecret || provider.authKind === "none"))
    .flatMap((provider) =>
      composerModelsForProvider(provider, undefined, imageGeneration).map((model) => ({
        providerId: provider.id,
        modelId: model.modelId,
        providerLabel: providerDisplayName(provider),
        label: composerModelDisplayName(provider, model.modelId),
      })),
    );
}

export function samePlanModel(
  left: Partial<PlanTargetModel> | null | undefined,
  right: Partial<PlanTargetModel> | null | undefined,
): boolean {
  return !!left?.providerId && left.providerId === right?.providerId &&
    sameComposerModelId(left.modelId ?? "", right?.modelId ?? "");
}

/**
 * The model to send with approval: the chosen option when it is still
 * configured and differs from the session's model, otherwise none.
 */
export function planTargetModel(
  choice: PlanTargetModel | null,
  options: readonly PlanExecutionModelOption[],
  session: Partial<PlanTargetModel> | undefined,
): PlanTargetModel | undefined {
  const option = options.find((candidate) => samePlanModel(candidate, choice));
  return option && !samePlanModel(option, session)
    ? { providerId: option.providerId, modelId: option.modelId }
    : undefined;
}
