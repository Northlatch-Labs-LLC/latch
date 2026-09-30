import type { TuiSelection, TuiSubmitPrompt } from "@zcode/tui";
import { getZCodeCopy } from "@zcode/i18n";
import type {
  CommandCenterApp,
  CommandCenterLatchAccountLoginResult,
  CommandCenterLoginResult,
} from "./types.js";
import { randomUUID } from "node:crypto";

export function buildLoginSelection(locale?: string): TuiSelection {
  const copy = getZCodeCopy(locale).tui.loginSetup;
  return {
    emptyMessage: copy.emptyMessage,
    filterable: false,
    help: copy.help,
    items: [
      {
        // Latch 账号是默认账号流：先输入 email，再进入密码输入步（见
        // buildLatchAccountPasswordSelection）；密码经 mask 输入，不进历史与 transcript。
        command: "/login latch-account",
        id: "latch-account",
        input: {
          cancelStatus: copy.input.cancelStatus,
          clearStatus: copy.input.clearStatus,
          emptyStatus: copy.options.latchAccount.emptyStatus,
          help: copy.input.help,
          placeholder: copy.options.latchAccount.placeholder,
          primary: copy.options.latchAccount.inputPrimary,
          secondary: copy.options.latchAccount.inputSecondary,
          status: copy.options.latchAccount.inputPrimary,
          submitStatus: copy.options.latchAccount.submitStatus,
        },
        keywords: ["latch", "account", "email", "password"],
        primary: copy.options.latchAccount.primary,
        secondary: copy.options.latchAccount.secondary,
      },
      {
        command: "/login zai-coding-plan",
        id: "zai-coding-plan",
        keywords: ["zai", "oauth", "coding", "plan"],
        pending: {
          cancelStatus: copy.pending.cancelStatus,
          help: copy.pending.help,
          primary: copy.options.zaiOauth.pendingPrimary,
          secondary: copy.options.zaiOauth.pendingSecondary,
          status: copy.pending.status,
        },
        primary: copy.options.zaiOauth.primary,
        secondary: copy.options.zaiOauth.secondary,
      },
      {
        command: "/login bigmodel-coding-plan",
        id: "bigmodel-coding-plan",
        keywords: ["bigmodel", "oauth", "coding", "plan"],
        pending: {
          cancelStatus: copy.pending.cancelStatus,
          help: copy.pending.help,
          primary: copy.options.bigmodelOauth.pendingPrimary,
          secondary: copy.options.bigmodelOauth.pendingSecondary,
          status: copy.pending.status,
        },
        primary: copy.options.bigmodelOauth.primary,
        secondary: copy.options.bigmodelOauth.secondary,
      },
      {
        command: "/login zai-coding-plan-api-key",
        id: "zai-coding-plan-api-key",
        input: {
          cancelStatus: copy.input.cancelStatus,
          clearStatus: copy.input.clearStatus,
          emptyStatus: copy.input.emptyStatus,
          help: copy.input.help,
          mask: true,
          placeholder: copy.input.placeholder,
          primary: copy.options.zaiApiKey.inputPrimary,
          secondary: copy.options.zaiApiKey.inputSecondary,
          status: copy.input.status,
          submitStatus: copy.input.submitStatus,
        },
        keywords: ["zai", "api", "key", "manual"],
        primary: copy.options.zaiApiKey.primary,
        secondary: copy.options.zaiApiKey.secondary,
      },
      {
        command: "/login bigmodel-coding-plan-api-key",
        id: "bigmodel-coding-plan-api-key",
        input: {
          cancelStatus: copy.input.cancelStatus,
          clearStatus: copy.input.clearStatus,
          emptyStatus: copy.input.emptyStatus,
          help: copy.input.help,
          mask: true,
          placeholder: copy.input.placeholder,
          primary: copy.options.bigmodelApiKey.inputPrimary,
          secondary: copy.options.bigmodelApiKey.inputSecondary,
          status: copy.input.status,
          submitStatus: copy.input.submitStatus,
        },
        keywords: ["bigmodel", "api", "key", "manual"],
        primary: copy.options.bigmodelApiKey.primary,
        secondary: copy.options.bigmodelApiKey.secondary,
      },
    ],
    prompt: copy.prompt,
    title: copy.title,
  };
}

export function loginSetupResponse(locale?: string): string {
  return getZCodeCopy(locale).tui.loginSetup.response;
}

/**
 * email 步之后的密码输入选择：单项、mask 输入。command 携带 email（非机密），
 * 提交后由 create.ts 解析成 loginLatchAccount({email, password})。
 */
export function buildLatchAccountPasswordSelection(
  locale: string | undefined,
  email: string,
): TuiSelection {
  const copy = getZCodeCopy(locale).tui.loginSetup;
  return {
    emptyMessage: copy.emptyMessage,
    filterable: false,
    help: copy.input.help,
    items: [
      {
        command: `/login latch-account-password ${email}`,
        id: "latch-account-password",
        input: {
          cancelStatus: copy.input.cancelStatus,
          clearStatus: copy.input.clearStatus,
          emptyStatus: copy.options.latchAccountPassword.emptyStatus,
          help: copy.input.help,
          mask: true,
          placeholder: copy.options.latchAccountPassword.placeholder,
          primary: copy.options.latchAccountPassword.inputPrimary,
          secondary: copy.options.latchAccountPassword.inputSecondary,
          status: copy.options.latchAccountPassword.inputPrimary,
          submitStatus: copy.options.latchAccountPassword.submitStatus,
        },
        keywords: ["latch", "account", "password"],
        primary: copy.options.latchAccountPassword.primary,
        secondary: copy.options.latchAccountPassword.secondary,
      },
    ],
    prompt: copy.prompt,
    title: copy.title,
  };
}

export function formatLatchAccountLoginResult(
  result: CommandCenterLatchAccountLoginResult,
): string {
  return [
    `Signed in as ${result.email}.`,
    `Gateway: ${result.gatewayUrl}`,
    `Gateway key: #${result.keyId} ${result.maskedKey}`,
    `Manage account: ${result.manageUrl}`,
    `Model: ${result.model}`,
    `Credentials: ${result.credentialsPath}`,
    `Model selection: ${result.configPath}`,
  ].join("\n");
}

export function formatLoginResult(result: CommandCenterLoginResult): string {
  const label = result.user.name || result.user.email || result.user.user_id;
  const browserNote =
    result.browser && !result.browser.opened
      ? `\nBrowser open failed: ${result.browser.reason ?? "unknown error"}`
      : "";

  return [
    `Configured Xlaunch Gateway as ${label}.`,
    `Model: ${result.model}`,
    `Credentials: ${result.credentialsPath}`,
    `Model selection: ${result.configPath}${browserNote}`,
  ].join("\n");
}

export function formatProviderSetupResult(result: {
  configPath: string;
  model: string;
  providerId: "bigmodel" | "zai";
}): string {
  const provider = result.providerId === "bigmodel" ? "BigModel Coding Plan" : "Xlaunch Gateway";
  return [
    `Configured ${provider}.`,
    `Model: ${result.model}`,
    `Model selection: ${result.configPath}`,
  ].join("\n");
}

export async function emitLoginAuthorizeMessage(
  options: Parameters<TuiSubmitPrompt>[1],
  authorizeUrl: string,
  providerName: string,
  session: Pick<CommandCenterApp, "sessionId" | "traceId">,
): Promise<void> {
  const onEvent = options.onEvent;
  if (!onEvent) return;

  await onEvent({
    id: `local-login-authorize-${randomUUID()}` as never,
    payload: {
      content: [
        `Open this URL to sign in with ${providerName}:`,
        "",
        authorizeUrl,
        "",
        "After authorization, return here and I will finish the login automatically.",
      ].join("\n"),
    },
    sequenceNumber: 0,
    sessionId: session.sessionId as never,
    timestamp: new Date(),
    traceId: session.traceId as never,
    type: "assistant_message" as never,
  });
}

export function parseApiKeyLoginArgs(args: string): {
  apiKey: string;
  kind: "bigmodel-coding-plan-api-key" | "zai-coding-plan-api-key";
  providerId: "bigmodel" | "zai";
} | null {
  const [kind, ...rest] = args.split(/\s+/u);
  if (kind !== "zai-coding-plan-api-key" && kind !== "bigmodel-coding-plan-api-key") {
    return null;
  }
  return {
    apiKey: rest.join(" ").trim(),
    kind,
    providerId: kind.startsWith("bigmodel") ? "bigmodel" : "zai",
  };
}

/**
 * `/login latch-account [email]` 与 `/login latch-account-password <email> <password>`。
 * password 形态只由密码输入步产生；这里解析后立即交给 loginLatchAccount，
 * 不进入 transcript（app-submit.ts 脱敏）与输入历史（history.ts 过滤）。
 */
export function parseLatchAccountLoginArgs(
  args: string,
):
  | { email: string; kind: "latch-account" }
  | { email: string; kind: "latch-account-password"; password: string }
  | null {
  const [kind, ...rest] = args.split(/\s+/u);
  if (kind !== "latch-account" && kind !== "latch-account-password") return null;
  if (kind === "latch-account") {
    return { email: rest.join(" ").trim(), kind };
  }
  const [email, ...passwordParts] = rest;
  return {
    email: (email ?? "").trim(),
    kind,
    password: passwordParts.join(" ").trim(),
  };
}
