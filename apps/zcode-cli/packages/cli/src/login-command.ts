import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { CliEnv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";
import {
  completeLatchAccountLogin,
  formatLatchAccountError,
  logoutLatchAccount,
  promptLatchAccountCredentials,
  readLatchAccountWhoami,
  resolveLatchAccountTokenSession,
  signInLatchAccount,
} from "./latch-account-flow.js";

const OAUTH_PROVIDER_USAGE = "Usage: latch login [zai|bigmodel] [--no-browser]";

export async function runLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  noBrowser: boolean,
  args: readonly string[] = [],
): Promise<number> {
  try {
    const providerId = args[0];
    if (
      args.length > 1 ||
      (providerId !== undefined && providerId !== "zai" && providerId !== "bigmodel")
    ) {
      throw new Error(OAUTH_PROVIDER_USAGE);
    }
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

    // 无 provider 参数：Latch 账号（email + 密码）是默认账号流；zai/bigmodel 保留
    // 原浏览器 OAuth 流程。
    if (providerId === undefined) {
      return await runLatchAccountLoginCommand(ctx, options, deps, env);
    }

    const login = deps.loginZCodeCli ?? (await loadBootstrapModule()).loginZCodeCli;
    const result = await login({
      env,
      noBrowser,
      providerId,
      onAuthorizeUrl: (data) => {
        writeAuthorizeUrl(ctx, options, data.authorize_url, noBrowser, providerId);
      },
      onBrowserOpen: (browser) => {
        if (!options.json && !browser.opened) {
          ctx.stdout.write(`Browser open failed: ${browser.reason ?? "unknown error"}\n`);
        }
      },
    });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "ready",
          provider: result.providerId,
          user: {
            user_id: result.user.user_id,
            ...(result.user.email ? { email: result.user.email } : {}),
            ...(result.user.name ? { name: result.user.name } : {}),
            ...(result.user.avatar ? { avatar: result.user.avatar } : {}),
          },
          model: result.model,
          credentialsPath: result.credentialsPath,
          configPath: result.configPath,
          browserOpened: result.browser?.opened ?? false,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      [
        `Login successful${formatUserLabel(result.user)}.`,
        `Model: ${result.model}`,
        `Credentials: ${result.credentialsPath}`,
        `Model selection: ${result.configPath}`,
      ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

/** `latch login`（默认账号流）：终端收集 email/密码，铸造并接入 gateway key。 */
async function runLatchAccountLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  env: CliEnv,
): Promise<number> {
  // 非交互场景（CI/脚本）经 LATCH_ACCOUNT_SESSION_TOKEN 注入现成会话 token；
  // 不提供 --token argv——argv 会进入 shell 历史并暴露给本机其他用户的 ps。
  // env 仍只活在进程内存里，不落任何凭据文件；否则终端提示输入 email/密码。
  const envSessionToken = env.LATCH_ACCOUNT_SESSION_TOKEN?.trim();
  const session = envSessionToken
    ? await resolveLatchAccountTokenSession(envSessionToken, env)
    : await resolveSessionFromPrompt(ctx, env);
  const outcome = await completeLatchAccountLogin({
    token: session.token,
    email: session.email,
    env,
    deps,
  });

  if (options.json) {
    ctx.stdout.write(
      formatJson({
        status: "ready",
        account: { email: outcome.email },
        key: { id: outcome.keyId, maskedKey: outcome.maskedKey },
        gatewayUrl: outcome.gatewayUrl,
        manageUrl: outcome.manageUrl,
        model: outcome.model,
        credentialsPath: outcome.credentialsPath,
        configPath: outcome.configPath,
      }),
    );
    return 0;
  }

  ctx.stdout.write(
    [
      `Signed in as ${outcome.email}.`,
      `Gateway: ${outcome.gatewayUrl}`,
      `Gateway key: #${outcome.keyId} ${outcome.maskedKey}`,
      `Manage account: ${outcome.manageUrl}`,
      `Model: ${outcome.model}`,
      `Credentials: ${outcome.credentialsPath}`,
      `Model selection: ${outcome.configPath}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function resolveSessionFromPrompt(
  ctx: RunContext,
  env: CliEnv,
): Promise<{ token: string; email: string }> {
  const credentials = await promptLatchAccountCredentials(ctx);
  return await signInLatchAccount(credentials, env);
}

export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
): Promise<number> {
  try {
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

    // Latch 账号登出：吊销 CLI 铸造的 gateway key、清会话、移除 provider_config.json
    // 里的 gateway provider；随后沿用 logoutZCodeCli 清 zai/bigmodel OAuth 凭据。
    let accountLogoutSummary: Record<string, unknown> | undefined;
    try {
      const accountLogout = await logoutLatchAccount(env, deps);
      accountLogoutSummary = {
        hadSession: accountLogout.hadSession,
        revokedKeyId: accountLogout.revokedKeyId ?? undefined,
        removedProviderIds: accountLogout.removedProviderIds,
      };
      if (!options.json && accountLogout.hadSession) {
        ctx.stdout.write(
          `Removed the Latch account session${accountLogout.revokedKeyId ? ` and gateway key #${accountLogout.revokedKeyId}` : ""}.\n`,
        );
      }
    } catch (error) {
      // 账号侧失败不阻断共享凭据清理，但不能吞掉：打印后继续。
      ctx.stderr.write(`Warning: ${formatLatchAccountError(error)}\n`);
    }

    const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
    const result = await logout({ env });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "logged_out",
          account: accountLogoutSummary,
          provider: "zai",
          credentialsPath: result.credentialsPath,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      `Logged out from Coding Plan accounts. Credentials: ${result.credentialsPath}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

/** `latch whoami`：打印 Latch 账号 email/套餐/余额；未登录时打印 Not signed in。 */
export async function runWhoamiCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
): Promise<number> {
  try {
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

    const whoami = await readLatchAccountWhoami(env);
    if (!whoami.signedIn) {
      if (options.json) {
        ctx.stdout.write(formatJson({ signedIn: false }));
        return 1;
      }
      ctx.stdout.write("Not signed in\n");
      return 1;
    }

    const balanceUsd = whoami.balanceMicros / 1_000_000;
    if (options.json) {
      ctx.stdout.write(
        formatJson({
          signedIn: true,
          email: whoami.email,
          plan: whoami.plan,
          balanceMicros: whoami.balanceMicros,
          billingEnabled: whoami.billingEnabled,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      [
        `Account: ${whoami.email}`,
        `Plan: ${whoami.plan}`,
        `Balance: $${balanceUsd.toFixed(4)}`,
      ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    const message = formatLatchAccountError(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

function writeAuthorizeUrl(
  ctx: RunContext,
  options: GlobalOptions,
  authorizeUrl: string,
  noBrowser: boolean,
  providerId: "zai" | "bigmodel",
): void {
  const target = options.json ? ctx.stderr : ctx.stdout;
  if (noBrowser) {
    target.write(`Open this URL to sign in:\n${authorizeUrl}\n`);
    return;
  }

  target.write(
    `Opening browser for ${providerId === "bigmodel" ? "BigModel" : "Xlaunch Gateway"} authorization.\nFallback URL:\n${authorizeUrl}\n`,
  );
}

function formatUserLabel(user: { email?: string; name?: string; user_id: string }): string {
  const label = user.name || user.email || user.user_id;
  return label ? ` as ${label}` : "";
}
