// Latch 账号登录页（第一方登录入口，路由 /signin）：email + 密码表单，登录/创建
// 账号双模式。成功后按序做三件事：
//   1) {token, email} 存入浏览器仓储（browserLatchAccountRepo；密码绝不落盘）；
//   2) 经同源代理铸造名为 "Latch Web" 的推理 Key（完整 key 只出现一次）；
//   3) 走与桌面 LoginApiKeyForm 完全相同的 providerSettingsService 调用链
//      （provisionLatchGatewayProvider = getView 找 xlaunch-gateway 模板 +
//       createPersonalProvider 写入 apiKey）把网关 provider 接进当前 server。
// 服务来自 /ws 的 isomorphic services（connectViaWebSocket），与主应用同一条通路。
// 文案/错误映射在 latchSignInCopy.ts，已登录视图在 LatchSignedInCard.tsx。
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { connectViaWebSocket } from "@zcode/client";
import { Button } from "@zcode/ui";
import {
  LatchAccountError,
  isValidLatchEmail,
  isValidLatchPassword,
  provisionLatchGatewayProvider,
  type IServiceAccessor,
  type LatchAccountSession,
} from "@zcode/services";
import { BrowserLatchAccountRepo } from "./browserLatchAccountRepo.js";
import { createBrowserLatchCredentialService } from "./browserLatchCredentialService.js";
import {
  latchWebAccountStatus,
  latchWebLogout,
  latchWebMintGatewayKey,
  latchWebSignIn,
  latchWebSignUp,
} from "./latchAccountProxyClient.js";
import {
  describeLatchError,
  getLatchSignInCopy,
  resolveSafeSignInReturnTo,
} from "./latchSignInCopy.js";
import { LatchSignedInCard } from "./LatchSignedInCard.js";

/** Web 端登录后铸造的推理 Key 名称；与桌面端命名约定一致，用户可在账号页吊销。 */
const LATCH_WEB_KEY_NAME = "Latch Web";

type LatchSignInMode = "signin" | "signup";
type LatchSignInStage = "auth" | "mint" | "provision";

type ServicesRead =
  | { status: "connecting" }
  | { status: "ready"; services: IServiceAccessor }
  | { status: "error"; message: string };

function resolveSignInWsUrl(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
}

export function LatchSignInPage({
  returnTo,
  onDone,
}: {
  /** 原样透传的 ?return_to= 参数；解析与同源校验在 resolveSafeSignInReturnTo。 */
  returnTo: string | null;
  onDone: (target: string) => void;
}) {
  const copy = getLatchSignInCopy();
  const repoRef = useRef(new BrowserLatchAccountRepo());
  // key-id 镜像专用：浏览器本地凭据服务（不碰宿主共享存储，见其模块头注释）。
  const credentialRef = useRef(createBrowserLatchCredentialService());
  const [servicesRead, setServicesRead] = useState<ServicesRead>({ status: "connecting" });
  const [mode, setMode] = useState<LatchSignInMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [stage, setStage] = useState<LatchSignInStage | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [session, setSession] = useState<LatchAccountSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [provisioned, setProvisioned] = useState(false);
  const [postAuthError, setPostAuthError] = useState<string | null>(null);

  // provider 接线需要 /ws 的 isomorphic services；未连上前不能提交
  //（登录的后半段依赖 providerSettingsService），连接失败给出刷新入口。
  useEffect(() => {
    let cancelled = false;
    connectViaWebSocket(resolveSignInWsUrl())
      .then((services) => {
        if (!cancelled) {
          setServicesRead({ status: "ready", services });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setServicesRead({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 已有本地登录态时先经代理打一次 /me：401 清掉过期会话回表单，网络失败不打扰
  //（保留登录态展示，交给用户手动退出）。
  useEffect(() => {
    const stored = repoRef.current.loadSession();
    if (!stored) {
      setSessionChecked(true);
      return;
    }
    let cancelled = false;
    setSession(stored);
    latchWebAccountStatus(stored.token)
      .then((status) => {
        if (!cancelled) {
          setSession({ token: stored.token, email: status.email || stored.email });
          setSessionChecked(true);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setSessionChecked(true);
        if (error instanceof LatchAccountError && error.kind === "unauthorized") {
          repoRef.current.clearSession();
          setSession(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runPostAuth = useCallback(
    async (activeSession: LatchAccountSession): Promise<void> => {
      if (servicesRead.status !== "ready") {
        throw new LatchAccountError("network", copy.errorServicesTitle);
      }
      const { services } = servicesRead;
      // 铸造 Key：key id 镜像进浏览器本地凭据存储。不能传 services.credentialService
      //——那是宿主进程共享的加密存储，多用户自托管 Web 时会互相覆盖（状态串台）。
      setStage("mint");
      const minted = await latchWebMintGatewayKey(activeSession.token, LATCH_WEB_KEY_NAME, {
        credentialService: credentialRef.current,
      });
      // 与桌面 LoginApiKeyForm 完全相同的调用链：getView 找 xlaunch-gateway 模板，
      // createPersonalProvider 写入 apiKey。失败时 session 已存好，用户可手动重试。
      setStage("provision");
      await provisionLatchGatewayProvider(minted.key, services.providerSettingsService);
      setProvisioned(true);
    },
    [copy.errorServicesTitle, servicesRead],
  );

  const handleSubmit = useCallback(async () => {
    setFormError(null);
    setEmailTaken(false);
    if (!isValidLatchEmail(email)) {
      setFormError(copy.errorEmailInvalid);
      return;
    }
    if (!isValidLatchPassword(password)) {
      setFormError(copy.errorPasswordMin);
      return;
    }
    if (servicesRead.status !== "ready") {
      setFormError(copy.errorServicesTitle);
      return;
    }
    setStage("auth");
    // 用本地标志而不是 stage state 判定失败阶段：闭包里的 state 不会随 setStage 更新。
    let postAuthReached = false;
    try {
      const auth =
        mode === "signup"
          ? await latchWebSignUp(email, password)
          : await latchWebSignIn(email, password);
      repoRef.current.saveSession({ token: auth.token, email: auth.email });
      setSession({ token: auth.token, email: auth.email });
      // 密码用完即弃：不留在 React 状态里，也绝不进入仓储。
      setPassword("");
      setPostAuthError(null);
      postAuthReached = true;
      await runPostAuth({ token: auth.token, email: auth.email });
      onDone(resolveSafeSignInReturnTo(returnTo));
    } catch (error: unknown) {
      if (error instanceof LatchAccountError && error.kind === "email_taken") {
        setEmailTaken(true);
      }
      const message = describeLatchError(error, copy);
      // mint/provision 阶段的失败发生在登录成功之后：session 已保存，错误挪到
      // 已登录视图里给“重新尝试接入”，表单不再重复报错。
      if (postAuthReached) {
        setPostAuthError(message);
      } else {
        setFormError(message);
      }
    } finally {
      setStage(null);
    }
    // password 必须在依赖里：copy 是稳定对象引用（COPY[locale]），只改密码不会重建
    // 本回调，缺了它按钮/回车会闭包到上一次的空密码，误报“密码至少 10 个字符”。
  }, [copy, email, mode, onDone, password, returnTo, runPostAuth, servicesRead.status]);

  const handleSignOut = useCallback(async () => {
    const stored = repoRef.current.loadSession();
    repoRef.current.clearSession();
    setSession(null);
    setProvisioned(false);
    setPostAuthError(null);
    setEmail("");
    setPassword("");
    if (!stored) {
      return;
    }
    try {
      // 同 mint：登出清理也走浏览器本地凭据存储，不碰宿主共享存储。
      await latchWebLogout(stored.token, { credentialService: credentialRef.current });
    } catch {
      // 网关会话销毁失败不阻塞本地退出（与 services 侧 latchLogout 同语义）。
    }
  }, []);

  const handleRetryPostAuth = useCallback(async () => {
    if (!session) {
      return;
    }
    setPostAuthError(null);
    try {
      await runPostAuth(session);
      onDone(resolveSafeSignInReturnTo(returnTo));
    } catch (error: unknown) {
      setPostAuthError(describeLatchError(error, copy));
    } finally {
      setStage(null);
    }
  }, [copy, onDone, returnTo, runPostAuth, session]);

  const busy = stage !== null;
  const inputClass =
    "h-10 w-full rounded-lg border border-border bg-surface px-3 text-ui-base text-foreground placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:opacity-50";
  // mint/provision 的进度文案只在已登录视图里展示，其余阶段为 null。
  const stageStatus =
    stage === "mint" || stage === "provision"
      ? stage === "mint"
        ? copy.mintingStatus
        : copy.provisioningStatus
      : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-card-border bg-card p-5 shadow-sm">
        <div className="mb-4 text-ui-sm font-medium text-brand">{copy.title}</div>

        {session ? (
          <LatchSignedInCard
            copy={copy}
            session={session}
            stageStatus={stageStatus}
            provisioned={provisioned}
            postAuthError={postAuthError}
            busy={busy}
            servicesReady={servicesRead.status === "ready"}
            onRetryPostAuth={() => void handleRetryPostAuth()}
            onContinue={() => onDone(resolveSafeSignInReturnTo(returnTo))}
            onSignOut={() => void handleSignOut()}
          />
        ) : (
          <div className="space-y-4">
            <p className="text-ui-xs leading-6 text-foreground-subtle">{copy.description}</p>
            <div className="space-y-2">
              <label
                className="block text-ui-xs font-medium text-foreground-subtle"
                htmlFor="latch-signin-email"
              >
                {copy.emailLabel}
              </label>
              <input
                id="latch-signin-email"
                type="email"
                className={inputClass}
                value={email}
                autoComplete="username"
                disabled={busy || !sessionChecked}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFormError(null);
                  setEmailTaken(false);
                }}
              />
            </div>
            <div className="space-y-2">
              <label
                className="block text-ui-xs font-medium text-foreground-subtle"
                htmlFor="latch-signin-password"
              >
                {copy.passwordLabel}
              </label>
              <input
                id="latch-signin-password"
                type="password"
                className={inputClass}
                value={password}
                title={copy.passwordHint}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                disabled={busy || !sessionChecked}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setFormError(null);
                  setEmailTaken(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !busy && sessionChecked) {
                    void handleSubmit();
                  }
                }}
              />
              <p className="text-ui-xs text-foreground-subtle">{copy.passwordHint}</p>
            </div>
            {formError ? (
              <div
                className="space-y-1 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs leading-5 text-foreground-subtle"
                role="alert"
              >
                <p>{formError}</p>
                {emailTaken ? <p>{copy.errorEmailTakenHint}</p> : null}
              </div>
            ) : null}
            {servicesRead.status === "connecting" ? (
              <p
                className="flex items-center gap-2 text-ui-xs text-foreground-subtle"
                role="status"
              >
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                {copy.servicesConnecting}
              </p>
            ) : null}
            {servicesRead.status === "error" ? (
              <div
                className="space-y-2 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs leading-5 text-foreground-subtle"
                role="alert"
              >
                <p>{copy.errorServicesTitle}</p>
                <Button
                  type="button"
                  size="lg"
                  className="w-full"
                  onClick={() => window.location.reload()}
                >
                  {copy.errorServicesAction}
                </Button>
              </div>
            ) : null}
            <Button
              type="button"
              size="lg"
              className="w-full"
              disabled={busy || !sessionChecked || servicesRead.status !== "ready"}
              onClick={() => void handleSubmit()}
            >
              {busy && stage === "auth" ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {mode === "signup" ? copy.signUpAction : copy.signInAction}
            </Button>
            <Button
              type="button"
              variant="link"
              className="h-7 w-full text-ui-base text-foreground-subtle hover:text-foreground"
              disabled={busy}
              onClick={() => {
                setMode(mode === "signup" ? "signin" : "signup");
                setFormError(null);
                setEmailTaken(false);
              }}
            >
              {mode === "signup" ? copy.switchToSignIn : copy.switchToSignUp}
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
