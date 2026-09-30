// Latch 账号登录表单：email + password 直连 gateway customer-api（signup/login），
// 成功后铸造推理 Key（"Latch Desktop"）并接进内嵌 xlaunch-gateway provider。
// 密码只存在于两个请求体里：输入框 state 用完立即清空，绝不写日志/凭据存储。
import { useRef, useState } from "react";
import {
  LATCH_MIN_PASSWORD_LENGTH,
  LatchAccountError,
  invalidateLatchAccountStatusSummary,
  isValidLatchEmail,
  isValidLatchPassword,
  latchSignIn,
  latchSignUp,
  mintLatchGatewayKey,
  provisionLatchGatewayProvider,
  saveLatchAccountSession,
  type LatchAccountErrorKind,
} from "@zcode/services";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import {
  TID_LOGIN_LATCH_EMAIL_INPUT,
  TID_LOGIN_LATCH_ERROR,
  TID_LOGIN_LATCH_MODE_TOGGLE,
  TID_LOGIN_LATCH_MORE_OPTIONS_BUTTON,
  TID_LOGIN_LATCH_PASSWORD_INPUT,
  TID_LOGIN_LATCH_SUBMIT_BUTTON,
  TID_LOGIN_LATCH_SWITCH_TO_SIGN_IN,
  TID_LOGIN_LATCH_USE_API_KEY_BUTTON,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/** 桌面端铸造的推理 Key 名称；gateway 侧要求 trim 后 1-100 字符。 */
const LATCH_DESKTOP_KEY_NAME = "Latch Desktop";

type LatchFormMode = "signIn" | "signUp";

interface LatchFormError {
  kind: LatchAccountErrorKind;
  message: string;
}

interface LatchAccountFormProps {
  /** 登录 + 铸造 + 接线全部成功后回调（由 WelcomeScreen 转成 loginComplete("latchAccount")）。 */
  onSignedIn: () => void | Promise<void>;
  /** 次要入口：改用 API Key（存量 key 用户的回退路径）。 */
  onUseApiKey: () => void;
  /** 次要入口：回到 OAuth 渠道列表。 */
  onUseProviderLogin: () => void;
}

function resolveLatchErrorMessage(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  error: LatchAccountError,
): string {
  switch (error.kind) {
    case "invalid_credentials":
      return intl.formatMessage({ id: "login.latch.error.invalidCredentials" });
    case "rate_limited":
      return intl.formatMessage({ id: "login.latch.error.rateLimited" });
    case "network":
      return intl.formatMessage({ id: "login.latch.error.network" });
    case "server":
      return intl.formatMessage({ id: "login.latch.error.server" });
    case "email_taken":
      return intl.formatMessage({ id: "login.latch.emailTaken.message" });
    case "validation":
      // 服务端 400 的 message（如邮箱已超长）比本地校验提示更具体，可用时优先透出。
      return error.message || intl.formatMessage({ id: "login.latch.error.validation" });
    default:
      return error.message || intl.formatMessage({ id: "login.latch.error.unknown" });
  }
}

export function LatchAccountForm({
  onSignedIn,
  onUseApiKey,
  onUseProviderLogin,
}: LatchAccountFormProps) {
  const { intl } = useZCodeIntl();
  const { credentialService, providerSettingsService } = useServices();
  const [mode, setMode] = useState<LatchFormMode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showFieldErrors, setShowFieldErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LatchFormError | null>(null);
  // 登录成功但铸造/接线失败时置 true：展示“重试接线”，重试只需要 token 不需要密码。
  const [provisionFailed, setProvisionFailed] = useState(false);
  const provisionRetryRef = useRef<(() => Promise<void>) | null>(null);

  const emailInvalid = showFieldErrors && !isValidLatchEmail(email);
  const passwordInvalid = showFieldErrors && !isValidLatchPassword(password);

  const mintAndProvision = async (token: string): Promise<void> => {
    const minted = await mintLatchGatewayKey(token, LATCH_DESKTOP_KEY_NAME, { credentialService });
    await provisionLatchGatewayProvider(minted.key, providerSettingsService);
    invalidateLatchAccountStatusSummary(token);
  };

  const handleSubmit = async () => {
    setShowFieldErrors(true);
    if (!isValidLatchEmail(email) || !isValidLatchPassword(password)) {
      return;
    }

    setBusy(true);
    setError(null);
    setProvisionFailed(false);
    provisionRetryRef.current = null;
    // token 落定即表示认证已成功：后续失败不会再让用户重输密码。
    let token: string | null = null;
    try {
      const auth =
        mode === "signIn" ? await latchSignIn(email, password) : await latchSignUp(email, password);
      token = auth.token;
      // 密码只服务于这一次请求；认证成功后立刻从 UI state 清掉。
      setPassword("");
      setShowFieldErrors(false);
      await saveLatchAccountSession(
        { token: auth.token, email: auth.email },
        { credentialService },
      );
      invalidateLatchAccountStatusSummary(auth.token);
      const sessionToken: string = auth.token;
      try {
        await mintAndProvision(sessionToken);
      } catch (provisionError) {
        // 只有铸造/接线本身失败才给“重试”入口；重试会再铸一把 Key，
        // 不能把 onSignedIn 的收尾失败也混进来。
        provisionRetryRef.current = () => mintAndProvision(sessionToken);
        setProvisionFailed(true);
        setError({
          kind: "unknown",
          message: intl.formatMessage(
            { id: "login.latch.provisionError" },
            {
              error:
                provisionError instanceof Error ? provisionError.message : String(provisionError),
            },
          ),
        });
        logger.warn("[LoginEntry] Latch 登录成功但网关 Key 接线失败", {
          error: provisionError,
        });
        return;
      }
      try {
        await onSignedIn();
      } catch (completeError) {
        // 收尾（Root 刷新/关屏）失败不回滚登录态：session 已保存、provider 已接线，
        // 这里只记录；WelcomeScreen 的完成链路自己负责关闭时机。
        logger.warn("[LoginEntry] Latch 登录收尾失败", { error: completeError });
      }
    } catch (submitError) {
      if (token) {
        // 认证成功但本地 session 落盘失败：如实提示，用户可重试登录。
        setError({
          kind: "unknown",
          message: intl.formatMessage(
            { id: "login.latch.sessionSaveError" },
            { error: submitError instanceof Error ? submitError.message : String(submitError) },
          ),
        });
        logger.warn("[LoginEntry] Latch 登录成功但保存本地会话失败", {
          error: submitError,
        });
        return;
      }
      if (submitError instanceof LatchAccountError) {
        // 只记录错误分类与服务端消息；LatchAccountError 不携带密码。
        logger.warn("[LoginEntry] Latch 账号登录失败", {
          kind: submitError.kind,
          status: submitError.status,
          mode,
        });
        setError({
          kind: submitError.kind,
          message: resolveLatchErrorMessage(intl, submitError),
        });
        return;
      }
      logger.error("[LoginEntry] Latch 账号登录出现未分类失败", {
        error: submitError,
      });
      setError({
        kind: "unknown",
        message: intl.formatMessage({ id: "login.latch.error.unknown" }),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRetryProvision = async () => {
    const retry = provisionRetryRef.current;
    if (!retry) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await retry();
      provisionRetryRef.current = null;
      setProvisionFailed(false);
      await onSignedIn();
    } catch (retryError) {
      logger.warn("[LoginEntry] Latch 网关 Key 接线重试失败", {
        error: retryError,
      });
      setError({
        kind: "unknown",
        message: intl.formatMessage(
          { id: "login.latch.provisionError" },
          { error: retryError instanceof Error ? retryError.message : String(retryError) },
        ),
      });
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (nextMode: LatchFormMode) => {
    setMode(nextMode);
    setError(null);
    setShowFieldErrors(false);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({
            id: mode === "signIn" ? "login.latch.signIn.title" : "login.latch.signUp.title",
          })}
        </h2>
        <div className="space-y-2">
          <div className="space-y-1">
            <Input
              id="login-latch-email"
              type="email"
              size="lg"
              className="h-10 w-full text-ui-base"
              data-testid={TID_LOGIN_LATCH_EMAIL_INPUT}
              aria-label={intl.formatMessage({ id: "login.latch.emailLabel" })}
              aria-invalid={emailInvalid || undefined}
              placeholder={intl.formatMessage({ id: "login.latch.emailPlaceholder" })}
              autoComplete="email"
              disabled={busy}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
            />
            {emailInvalid ? (
              <p className="text-ui-xs text-destructive">
                {intl.formatMessage({ id: "login.latch.emailInvalidError" })}
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Input
              id="login-latch-password"
              type="password"
              size="lg"
              className="h-10 w-full text-ui-base"
              data-testid={TID_LOGIN_LATCH_PASSWORD_INPUT}
              aria-label={intl.formatMessage({ id: "login.latch.passwordLabel" })}
              aria-invalid={passwordInvalid || undefined}
              placeholder={intl.formatMessage({ id: "login.latch.passwordPlaceholder" })}
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
              disabled={busy}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy) {
                  void handleSubmit();
                }
              }}
            />
            {passwordInvalid ? (
              <p className="text-ui-xs text-destructive">
                {intl.formatMessage(
                  { id: "login.latch.passwordInvalidError" },
                  { count: String(LATCH_MIN_PASSWORD_LENGTH) },
                )}
              </p>
            ) : (
              <p className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage(
                  { id: "login.latch.passwordHint" },
                  { count: String(LATCH_MIN_PASSWORD_LENGTH) },
                )}
              </p>
            )}
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" data-testid={TID_LOGIN_LATCH_ERROR}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* 注册撞到已注册邮箱（gateway 409）：一键切回登录并保留邮箱，而不是让用户重走表单。 */}
      {error?.kind === "email_taken" && mode === "signUp" ? (
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_LATCH_SWITCH_TO_SIGN_IN}
          disabled={busy}
          onClick={() => switchMode("signIn")}
        >
          {intl.formatMessage({ id: "login.latch.emailTaken.switchToSignIn" })}
        </Button>
      ) : null}

      {provisionFailed && !busy ? (
        <Button
          type="button"
          className="h-10 w-full text-ui-base"
          size="lg"
          onClick={() => void handleRetryProvision()}
        >
          {intl.formatMessage({ id: "login.latch.retryProvision" })}
        </Button>
      ) : null}

      <div className="space-y-2">
        <Button
          type="button"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_LATCH_SUBMIT_BUTTON}
          disabled={busy}
          onClick={() => void handleSubmit()}
        >
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({
            id: mode === "signIn" ? "login.latch.submit.signIn" : "login.latch.submit.signUp",
          })}
        </Button>
        <Button
          type="button"
          variant="link"
          className="h-7 w-full text-ui-base text-foreground-subtle hover:text-foreground"
          data-testid={TID_LOGIN_LATCH_MODE_TOGGLE}
          disabled={busy}
          onClick={() => switchMode(mode === "signIn" ? "signUp" : "signIn")}
        >
          {intl.formatMessage({
            id: mode === "signIn" ? "login.latch.switchToSignUp" : "login.latch.switchToSignIn",
          })}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full text-ui-base"
          size="lg"
          data-testid={TID_LOGIN_LATCH_USE_API_KEY_BUTTON}
          disabled={busy}
          onClick={onUseApiKey}
        >
          {intl.formatMessage({ id: "login.useApiKey" })}
        </Button>
        <Button
          type="button"
          variant="link"
          className="h-7 w-full text-ui-base text-foreground-subtle hover:text-foreground"
          data-testid={TID_LOGIN_LATCH_MORE_OPTIONS_BUTTON}
          disabled={busy}
          onClick={onUseProviderLogin}
        >
          {intl.formatMessage({ id: "login.latch.moreOptions" })}
        </Button>
      </div>
    </div>
  );
}
