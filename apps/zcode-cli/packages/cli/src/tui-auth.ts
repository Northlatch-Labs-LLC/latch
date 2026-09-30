import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";
import { completeLatchAccountLogin, signInLatchAccount } from "./latch-account-flow.js";
import type {
  CommandCenterApiKeyOptions,
  CommandCenterBigmodelLoginOptions,
  CommandCenterLatchAccountLoginOptions,
  CommandCenterLatchAccountLoginResult,
  CommandCenterLoginOptions,
} from "./command-center/types.js";

export async function loginForTui(deps: RunDependencies, options?: CommandCenterLoginOptions) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const login = deps.loginZCodeCli ?? (await loadBootstrapModule()).loginZCodeCli;
  return await login({
    abortSignal: options?.abortSignal,
    env,
    onAuthorizeUrl: options?.onAuthorizeUrl,
  });
}

export async function loginBigmodelForTui(
  deps: RunDependencies,
  options?: CommandCenterBigmodelLoginOptions,
) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const login =
    deps.loginBigmodelCodingPlan ?? (await loadBootstrapModule()).loginBigmodelCodingPlan;
  return await login({
    abortSignal: options?.abortSignal,
    env,
    onAuthorizeUrl: options?.onAuthorizeUrl,
  });
}

export async function configureApiKeyForTui(
  deps: RunDependencies,
  options: CommandCenterApiKeyOptions,
) {
  const configure =
    deps.configureCodingPlanApiKey ?? (await loadBootstrapModule()).configureCodingPlanApiKey;
  return await configure({
    apiKey: options.apiKey,
    env: deps.env ?? process.env,
    providerId: options.providerId,
  });
}

/**
 * TUI 的 Latch 账号登录：email + 密码（由 /login 的两步输入收集）走与 `latch login`
 * 相同的登录 → 铸 Key → provider_config.json 接线；密码不进入任何本地状态。
 */
export async function loginLatchAccountForTui(
  deps: RunDependencies,
  options: CommandCenterLatchAccountLoginOptions,
): Promise<CommandCenterLatchAccountLoginResult> {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const session = await signInLatchAccount(
    { email: options.email, password: options.password },
    env,
  );
  const outcome = await completeLatchAccountLogin({
    token: session.token,
    email: session.email,
    env,
    deps,
  });
  return {
    configPath: outcome.configPath,
    credentialsPath: outcome.credentialsPath,
    email: outcome.email,
    gatewayUrl: outcome.gatewayUrl,
    keyId: outcome.keyId,
    manageUrl: outcome.manageUrl,
    maskedKey: outcome.maskedKey,
    model: outcome.model,
  };
}

export async function logoutForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
  return await logout({ env });
}
