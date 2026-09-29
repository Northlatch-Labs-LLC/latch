import { cn } from "@/components/lib/utils.js";

export function WindowsTopLeftLogo({
  className,
  imageClassName,
}: {
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div
      className={cn(
        // Workspace 的左侧工具组从 1px 面板边框之后开始，Settings 旧标题层却从窗口 0 点开始，
        // Workspace 的 logo 位于 28px 按钮内，图像相对按钮左沿还有 4px 居中留白；
        // Settings 直接渲染 20px 图像，不能拿按钮容器的 left 13px 当作图像坐标。
        // 计入 4px 外层留白、1px 边框和按钮内 4px 后，两处图像均为 left 17px / top 19px。
        "absolute left-1 top-1 mt-px ml-px z-20 flex h-12 items-center px-3 [app-region:drag]",
        className,
      )}
    >
      <svg
        viewBox="0 0 256 218"
        className={cn("pointer-events-none size-5 select-none", imageClassName)}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        {/* Latch mark: bold L with closed shackle */}
        <path d="M40 0h44v130c0 11 9 20 20 20h112v44H84c-24.3 0-44-19.7-44-44V0Z" />
        <path d="M128 0h88c22.1 0 40 17.9 40 40v60c0 22.1-17.9 40-40 40h-44V96h40c4.4 0 8-3.6 8-8V44c0-4.4-3.6-8-8-8h-84V0Z" />
      </svg>
    </div>
  );
}
