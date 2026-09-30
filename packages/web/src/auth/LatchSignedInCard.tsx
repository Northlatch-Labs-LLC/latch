// LatchSignInPage 登录成功后的已登录视图（email、铸 Key/接线进度、失败重试与退出）。
// 从页面拆出是为了让页面本体保持在 lint 行数约束内；结构与文案未变。
import { Loader2Icon } from "lucide-react";
import { Button } from "@zcode/ui";
import type { LatchAccountSession } from "@zcode/services";
import type { LatchSignInCopy } from "./latchSignInCopy.js";

export function LatchSignedInCard({
  copy,
  session,
  stageStatus,
  provisioned,
  postAuthError,
  busy,
  servicesReady,
  onRetryPostAuth,
  onContinue,
  onSignOut,
}: {
  copy: LatchSignInCopy;
  session: LatchAccountSession;
  /** mint/provision 阶段的本地化进度文案；非该二阶段时为 null。 */
  stageStatus: string | null;
  provisioned: boolean;
  postAuthError: string | null;
  busy: boolean;
  servicesReady: boolean;
  onRetryPostAuth: () => void;
  onContinue: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="space-y-4">
      <h1 className="text-ui-lg font-medium">{copy.signedInTitle}</h1>
      <p className="text-ui-xs leading-6 text-foreground-subtle">
        {copy.signedInAs}: <span className="break-all">{session.email}</span>
      </p>
      {stageStatus ? (
        <p className="flex items-center gap-2 text-ui-xs text-foreground-subtle" role="status">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          {stageStatus}
        </p>
      ) : null}
      {provisioned ? (
        <p className="text-ui-xs leading-6 text-foreground-subtle">{copy.provisionedNote}</p>
      ) : null}
      {postAuthError ? (
        <div
          className="space-y-2 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs leading-5 text-foreground-subtle"
          role="alert"
        >
          <p>{copy.provisionFailedTitle}</p>
          <p>{postAuthError}</p>
        </div>
      ) : null}
      <div className="space-y-2">
        {postAuthError && !busy ? (
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={!servicesReady}
            onClick={onRetryPostAuth}
          >
            {copy.provisionRetryAction}
          </Button>
        ) : null}
        {provisioned && !busy ? (
          <Button type="button" size="lg" className="w-full" onClick={onContinue}>
            {copy.continueAction}
          </Button>
        ) : null}
        {!busy ? (
          <Button type="button" variant="outline" size="lg" className="w-full" onClick={onSignOut}>
            {copy.signOutAction}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
