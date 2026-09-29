import {
  BUILTIN_PROVIDER_TEMPLATE_IDS,
  type AppSettings,
  type Locale,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

export type ApiKeyProviderChoice = "xlaunch-gateway" | "zai" | "bigmodel";

export function resolveLoginApiKeyDefaultProvider(_locale: Locale): ApiKeyProviderChoice {
  // Latch: the mandatory provider is the Xlaunch Gateway. Z.ai/BigModel keys
  // remain available as custom choices.
  return "xlaunch-gateway";
}

export function resolveLoginApiKeyTemplateId(
  choice: ApiKeyProviderChoice,
): "xlaunch-gateway" | "zai-api" | "bigmodel-api" {
  return choice === "zai"
    ? BUILTIN_PROVIDER_TEMPLATE_IDS.zai
    : choice === "bigmodel"
      ? BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel
      : "xlaunch-gateway";
}

export function resolveLoginApiKeyProviderLabel(choice: ApiKeyProviderChoice): string {
  return choice === "zai" ? "Z.ai" : choice === "bigmodel" ? "BigModel" : "Xlaunch Gateway";
}

function resolveLoginApiKeyProviderFamilyDomain(
  choice: ApiKeyProviderChoice,
): ProviderFamilyDomain {
  return choice === "xlaunch-gateway" ? "zai" : choice;
}

export function buildLoginApiKeySkipSettings(
  choice: ApiKeyProviderChoice,
  now: number,
): Pick<
  AppSettings,
  "providerFamilyDomain" | "providerFamilyDomainUpdatedAt" | "providerFamilyDomainMigrated"
> {
  return {
    providerFamilyDomain: resolveLoginApiKeyProviderFamilyDomain(choice),
    providerFamilyDomainUpdatedAt: now,
    providerFamilyDomainMigrated: true,
  };
}

export function shouldShowLoginApiKeyLink(
  apiKeyValue: string,
  apiKeyUrl: string | undefined,
): boolean {
  return Boolean(apiKeyUrl) && apiKeyValue.trim().length === 0;
}

export function buildLoginApiKeyDefaultModelPreferenceFromSelection(
  view: ModelSelectionView,
  providerId: string,
): string | null {
  const firstModel = view.providers.find((provider) => provider.providerId === providerId)
    ?.models[0]?.modelId;
  return firstModel ? encodeCustomModelValue(providerId, firstModel) : null;
}
