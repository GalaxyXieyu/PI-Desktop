import { useMemo } from "react";
import { imageGenerationBindings } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { planExecutionModelOptions, type PlanExecutionModelOption } from "./plan-execution-model";

export function usePlanExecutionModels(): PlanExecutionModelOption[] {
  const providers = useAppStore((state) => state.providers);
  const imageGenerationModels = useAppStore((state) => state.settings?.imageGenerationModels);
  const imageGeneration = useAppStore((state) => state.settings?.imageGeneration);
  return useMemo(
    () => planExecutionModelOptions(providers, imageGenerationBindings(imageGenerationModels, imageGeneration)),
    [providers, imageGenerationModels, imageGeneration],
  );
}
