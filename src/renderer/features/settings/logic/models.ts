import type { ModelChoice } from "../../../../contracts/application.ts";

export function availableModels(
  providers: readonly {
    id: string;
    name: string;
    enabled: boolean;
    models: readonly ModelChoice[];
    unavailableModels?: readonly string[];
  }[],
) {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models
        .filter((model) => !provider.unavailableModels?.includes(model.id))
        .map((model) => ({
          ...model,
          id: `${provider.id}:${model.id}`,
          name: `${model.name} · ${provider.name}`,
        })),
    );
}
