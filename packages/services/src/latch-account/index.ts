// Latch 账号模块的窄入口：给 CLI 这类单文件打包的消费方使用。
// 根 index 会连带 renderer 侧依赖（node-pty 等），bundle 进 CLI 会破坏构建；
// 这里只重导出 latch-account 子图（browser-safe，仅依赖 @zcode/provider 与类型），
// 导出面与根 index 中的 latch-account 段保持一致。
export type { ICredentialService } from "../credential/credential.js";
export {
  DEFAULT_LATCH_ACCOUNT_API_BASE_URL,
  DEFAULT_LATCH_ACCOUNT_MANAGE_URL,
  DEFAULT_LATCH_ACCOUNT_PURCHASE_URL,
  LATCH_ACCOUNT_API_URL_ENV_KEY,
  LATCH_ACCOUNT_MANAGE_URL_ENV_KEY,
  LATCH_ACCOUNT_PURCHASE_URL_ENV_KEY,
  LATCH_ACCOUNT_TOKEN_CREDENTIAL_KEY,
  LATCH_ACCOUNT_EMAIL_CREDENTIAL_KEY,
  LATCH_ACCOUNT_KEY_ID_CREDENTIAL_KEY,
  LATCH_GATEWAY_PROVIDER_TEMPLATE_ID,
  LATCH_MIN_PASSWORD_LENGTH,
  buildLatchAccountApiUrl,
  normalizeLatchAccountApiBaseUrl,
  readLatchAccountEnv,
  resolveLatchAccountApiBaseUrl,
  resolveLatchAccountManageUrl,
  resolveLatchAccountPurchaseUrl,
  type RuntimeLatchAccountEnv,
} from "./config.js";
export {
  LatchAccountError,
  isValidLatchEmail,
  isValidLatchPassword,
  type LatchAccountAuthResult,
  type LatchAccountErrorKind,
  type LatchAccountPlanHeld,
  type LatchAccountPlanId,
  type LatchAccountSession,
  type LatchAccountStatus,
  type LatchAccountTreasury,
  type LatchGatewayKeyMinted,
  type LatchGatewayKeySummary,
  type LatchLedger,
  type LatchLedgerEntry,
  type LatchLedgerEntryKind,
} from "./latchAccountTypes.js";
export {
  clearLatchAccountSession,
  createLatchAccountSessionStore,
  loadLatchAccountSession,
  loadLatchGatewayKeyId,
  saveLatchAccountSession,
  setLatchAccountCredentialService,
  resolveLatchAccountCredentialService,
  type LatchAccountSessionStore,
  type LatchAccountStoreOptions,
} from "./latchAccountSession.js";
export {
  fetchLatchAccountStatus,
  fetchLatchLedger,
  latchLogout,
  latchSignIn,
  latchSignUp,
  listLatchKeys,
  logLatchAccountWarning,
  mintLatchGatewayKey,
  revokeLatchKey,
  type LatchAccountFetch,
  type LatchAccountRequestOptions,
} from "./latchAccountService.js";
export {
  provisionLatchGatewayProvider,
  type LatchProviderSettingsSource,
} from "./latchAccountProvisioning.js";
export {
  invalidateLatchAccountStatusSummary,
  latchAccountStatusSummary,
  type LatchAccountStatusSummary,
  type LatchAccountStatusSummaryOptions,
} from "./latchAccountStatusSummary.js";
