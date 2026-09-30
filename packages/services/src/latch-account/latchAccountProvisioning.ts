// 把 gateway 推理 Key 接进内嵌 provider：与 LoginApiKeyForm.tsx 完全同一条路径 ——
// 先在 provider 视图里找 xlaunch-gateway 模板，再按模板 access.type 建 personal
// provider，保证桌面与 Web 行为一致。模板缺失时显式失败，不写死 access 类型。
import { isApiKeyAccess, type ProviderSettingsCreationResult } from "@zcode/provider";
import type { IProviderSettingsService } from "../model-provider/providerFacadeServices.js";
import { LATCH_GATEWAY_PROVIDER_TEMPLATE_ID } from "./config.js";
import { LatchAccountError } from "./latchAccountTypes.js";

export type LatchProviderSettingsSource = Pick<
  IProviderSettingsService,
  "getView" | "createPersonalProvider"
>;

export async function provisionLatchGatewayProvider(
  apiKey: string,
  providerSettings: LatchProviderSettingsSource,
): Promise<ProviderSettingsCreationResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new LatchAccountError("validation", "A gateway API key is required");
  }
  const template = (await providerSettings.getView()).providerTemplates.find(
    (item) => item.templateId === LATCH_GATEWAY_PROVIDER_TEMPLATE_ID,
  );
  if (!template || !isApiKeyAccess(template.config.access)) {
    throw new LatchAccountError(
      "unknown",
      "The embedded Xlaunch Gateway provider template is unavailable",
    );
  }
  return providerSettings.createPersonalProvider({
    templateId: LATCH_GATEWAY_PROVIDER_TEMPLATE_ID,
    initialConfig: { access: { type: template.config.access.type, apiKey: trimmed } },
  });
}
