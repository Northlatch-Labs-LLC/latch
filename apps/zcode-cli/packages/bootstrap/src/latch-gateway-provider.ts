// 把 xlaunch gateway 推理 Key 接进 standalone CLI 的 ~/.latch/v2/provider_config.json。
// 桌面端走 services/provisionLatchGatewayProvider（IProviderSettingsService.createPersonalProvider）；
// CLI 登录命令不拉起整个 Registry，改用同一份 ProviderConfigService 事务写 Personal 层：
// 首次登录按模板建 personal provider（providerId 即模板种子），重复登录只覆盖 access.apiKey，
// 最后像 persistStandaloneCodingPlanConnection 一样落默认模型选择。
import { createSharedZCodeCredentialStore } from "@zcode/adapters";
import type { EnvRecord } from "@zcode/adapters/model";
import {
  ApiKeyAccessConfig,
  ProviderConfig,
  ProviderConfigService,
  isApiKeyAccess,
  type ApiKeyAccessConfigObject,
  type ModelId,
  type ProviderId,
} from "@zcode/provider";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
  NodeZCodeBuiltinProviderConfigSource,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { dirname, join } from "node:path";
import { readLegacyCliPersonalProviderConfig } from "./app/legacy-cli-personal-provider-config-importer.js";

// 与 services latch-account/config.ts 的 LATCH_GATEWAY_PROVIDER_TEMPLATE_ID 同源；
// bootstrap 不依赖 @zcode/services（其根入口含 renderer 侧依赖），这里保持字面量。
export const LATCH_GATEWAY_PROVIDER_TEMPLATE_ID = "xlaunch-gateway";

export interface LatchGatewayProviderOptions {
  readonly env?: EnvRecord;
  /** 覆盖 Built-in Config 路径；缺省用 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE。 */
  readonly builtinProviderConfigPath?: string;
  readonly personalProviderConfigPath?: string;
}

export interface LatchGatewayProviderConnection {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly configPath: string;
}

export interface LatchGatewayProviderRemoval {
  readonly configPath: string;
  readonly removedProviderIds: readonly ProviderId[];
}

export class LatchGatewayProviderError extends Error {
  readonly code: "template_unavailable" | "builtin_config_missing" | "api_key_invalid";

  constructor(
    code: LatchGatewayProviderError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "LatchGatewayProviderError";
    this.code = code;
  }
}

/** CLI 登录/登出共用的 Built-in + Personal + 默认选择运行边界；调用方负责 dispose。 */
function createGatewayProviderRuntime(options: LatchGatewayProviderOptions) {
  const env = options.env ?? process.env;
  const builtinFilePath = (
    options.builtinProviderConfigPath ?? env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]
  )?.trim();
  if (!builtinFilePath) {
    // 与 standalone-account-provider-runtime 的登录错误口径一致：
    // CLI 入口（provider-runtime-env.ts）在 login/logout 前必须已写入该 env。
    throw new LatchGatewayProviderError(
      "builtin_config_missing",
      `${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is required for login`,
    );
  }
  const credentialStore = createSharedZCodeCredentialStore({ env });
  const personalFilePath =
    (options.personalProviderConfigPath ?? env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV])?.trim() ||
    join(dirname(credentialStore.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);

  const zcodeBuiltinSource = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: builtinFilePath,
    watch: false,
  });
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: personalFilePath,
    importLegacy: () => readLegacyCliPersonalProviderConfig({}),
    pollingIntervalMs: false,
  });
  const configService = new ProviderConfigService({
    zcodeBuiltinSource,
    personalRepository,
  });
  const modelSelectionRepository = new NodeModelSelectionConfigRepository({
    personalRepository,
  });
  return {
    configService,
    modelSelectionRepository,
    personalRepository,
    personalFilePath,
    dispose() {
      modelSelectionRepository.dispose();
      configService.dispose();
      personalRepository.dispose();
      zcodeBuiltinSource.dispose();
    },
  };
}

type GatewayTemplateAccess = ApiKeyAccessConfigObject["type"];

async function requireGatewayTemplate(configService: ProviderConfigService): Promise<{
  accessType: GatewayTemplateAccess;
  modelId: ModelId;
}> {
  // ProviderConfigService 的快照自带 Built-in Template 视图，登录路径不必再建 Facade。
  const snapshot = await configService.read();
  const template = snapshot.zcodeBuiltinProviderTemplates.get(LATCH_GATEWAY_PROVIDER_TEMPLATE_ID);
  if (!template || !isApiKeyAccess(template.config.access)) {
    throw new LatchGatewayProviderError(
      "template_unavailable",
      "The embedded Xlaunch Gateway provider template is unavailable",
    );
  }
  const modelId = template.config.builtinModelIds?.find((id) => id.trim())?.trim();
  if (!modelId) {
    throw new LatchGatewayProviderError(
      "template_unavailable",
      "The embedded Xlaunch Gateway provider template declares no models",
    );
  }
  return { accessType: template.config.access.type, modelId };
}

/**
 * 把 gateway 推理 Key 写成 xlaunch-gateway 模板的 personal provider，并把默认模型
 * 指到该 provider。首次登录创建；再次登录复用同一 provider，仅覆盖 access.apiKey，
 * 不堆叠新 provider，也不动用户的其他 personal 配置。
 */
export async function configureLatchGatewayProvider(
  apiKey: string,
  options: LatchGatewayProviderOptions = {},
): Promise<LatchGatewayProviderConnection> {
  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) {
    throw new LatchGatewayProviderError("api_key_invalid", "Gateway API key must not be empty.");
  }
  const runtime = createGatewayProviderRuntime(options);
  try {
    const template = await requireGatewayTemplate(runtime.configService);
    const personal = await runtime.personalRepository.read();
    const existing = personal.providers
      .rules()
      .find((rule) => rule.templateId === LATCH_GATEWAY_PROVIDER_TEMPLATE_ID);
    const access = new ApiKeyAccessConfig({
      type: template.accessType,
      apiKey: trimmedApiKey,
    });
    let providerId: ProviderId;
    if (existing) {
      await runtime.configService.savePersonalProviderOverlay(
        existing.providerId,
        existing.config.overlay(new ProviderConfig({ access })),
      );
      providerId = existing.providerId;
    } else {
      providerId = (
        await runtime.configService.createPersonalProvider({
          templateId: LATCH_GATEWAY_PROVIDER_TEMPLATE_ID,
          initialConfig: new ProviderConfig({ access }),
        })
      ).providerId;
    }
    await runtime.modelSelectionRepository.saveConfiguredDefault({
      providerId,
      modelId: template.modelId,
    });
    return {
      providerId,
      modelId: template.modelId,
      configPath: runtime.personalFilePath,
    };
  } finally {
    runtime.dispose();
  }
}

/**
 * 登出时移除 gateway 模板实例化的 personal provider，并清理指向它们的默认模型选择。
 * 只动 xlaunch-gateway 模板的实例；用户手工配置的其他 provider 不受影响。
 */
export async function removeLatchGatewayProviders(
  options: LatchGatewayProviderOptions = {},
): Promise<LatchGatewayProviderRemoval> {
  const runtime = createGatewayProviderRuntime(options);
  try {
    const personal = await runtime.personalRepository.read();
    const removedProviderIds = personal.providers
      .rules()
      .filter((rule) => rule.templateId === LATCH_GATEWAY_PROVIDER_TEMPLATE_ID)
      .map((rule) => rule.providerId);
    if (removedProviderIds.length === 0) {
      return { configPath: runtime.personalFilePath, removedProviderIds: [] };
    }
    for (const providerId of removedProviderIds) {
      await runtime.configService.deletePersonalProvider(providerId);
    }
    const configuredDefault = await runtime.modelSelectionRepository.read();
    if (
      configuredDefault &&
      removedProviderIds.includes(configuredDefault.providerId as ProviderId)
    ) {
      await runtime.modelSelectionRepository.saveConfiguredDefault(undefined);
    }
    return { configPath: runtime.personalFilePath, removedProviderIds };
  } finally {
    runtime.dispose();
  }
}
