import type { ModelChoice } from "../../shared/application.ts";

export function availableModels(
  providers: readonly {
    id: string;
    name: string;
    enabled: boolean;
    models: readonly ModelChoice[];
  }[],
) {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        ...model,
        id: `${provider.id}:${model.id}`,
        name: `${model.name} · ${provider.name}`,
      })),
    );
}
