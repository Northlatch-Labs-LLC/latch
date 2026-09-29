import { cn } from "@/components/lib/utils.js";

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="118"
      height="100"
      fill="none"
      viewBox="0 0 256 218"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
            {/* Latch mark: bold L with closed shackle — replaces upstream Z mark */}
      <path
        fill="currentColor"
        d="M40 0h44v130c0 11 9 20 20 20h112v44H84c-24.3 0-44-19.7-44-44V0Z"
      />
      <path
        fill="currentColor"
        d="M128 0h88c22.1 0 40 17.9 40 40v60c0 22.1-17.9 40-40 40h-44V96h40c4.4 0 8-3.6 8-8V44c0-4.4-3.6-8-8-8h-84V0Z"
      />
    </svg>
  );
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <svg
      width="244"
      height="54"
      viewBox="0 0 244 54"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      {/* Latch wordmark — replaces upstream lettering */}
      <text
        x="0"
        y="43"
        fill="currentColor"
        style={{ font: '700 52px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', letterSpacing: "1px" }}
      >
        Latch
      </text>
    </svg>
  );
}
