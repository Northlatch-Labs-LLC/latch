import { redactFeedbackText } from "@zcode/shared";
export function buildErrorFeedbackDescription({
  message,
  detail,
  traceId,
  contextLines = [],
  formatMessage,
}: {
  message: string;
  detail?: string;
  traceId?: string;
  contextLines?: readonly string[];
  formatMessage: (id: string, values?: Record<string, string>) => string;
}) {
  return redactFeedbackText(
    [
      formatMessage("feedback.submit.template.section.errorSummaryLine", {
        message,
      }),
      "",
      traceId ? formatMessage("feedback.submit.template.section.errorTraceId", { traceId }) : null,
      detail
        ? ["", formatMessage("feedback.submit.template.section.errorDetail"), detail].join("\n")
        : null,
      contextLines.length > 0 ? contextLines.join("\n") : null,
      "",
      formatMessage("feedback.submit.template.section.whatDoing"),
      formatMessage("feedback.submit.template.section.supplement"),
      "",
      formatMessage("feedback.submit.template.section.expectedResult"),
      formatMessage("feedback.submit.template.section.supplement"),
    ]
      .filter((line): line is string => line != null)
      .join("\n"),
  );
}

/** 「复制完整报错」按钮写入剪贴板的纯文本模板；与反馈草稿共用同一组 i18n section 前缀。 */
export function buildErrorCopyText({
  message,
  detail,
  traceId,
  formatMessage,
}: {
  message: string;
  detail?: string;
  traceId?: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}) {
  return [
    formatMessage("feedback.submit.template.section.copyErrorHeading"),
    "",
    formatMessage("feedback.submit.template.section.errorSummary"),
    message,
    "",
    traceId ? formatMessage("feedback.submit.template.section.errorTraceId", { traceId }) : null,
    detail
      ? ["", formatMessage("feedback.submit.template.section.errorDetail"), detail].join("\n")
      : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}
