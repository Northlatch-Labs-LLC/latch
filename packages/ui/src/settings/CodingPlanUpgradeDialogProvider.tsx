import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CodingPlanUpgradeDialog,
  type CodingPlanUpgradeDialogTarget,
} from "@/settings/CodingPlanUpgradeDialog.js";

import {
  useCodingPlanEntryPlanList,
  type CodingPlanEntryInventory,
} from "@/hooks/useCodingPlanEntryPlanList.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { isWebRuntime, openLatchBillingEntry } from "@/lib/latchBillingNavigation.js";

interface CodingPlanUpgradeDialogContextValue {
  inventory: CodingPlanEntryInventory;
  openCodingPlanUpgrade: (
    target: CodingPlanUpgradeDialogTarget,
    observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
  ) => boolean;
}

const CodingPlanUpgradeDialogContext = createContext<CodingPlanUpgradeDialogContextValue | null>(
  null,
);

export function CodingPlanUpgradeDialogProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const inventory = useCodingPlanEntryPlanList();
  const [target, setTarget] = useState<CodingPlanUpgradeDialogTarget | undefined>(undefined);
  const [openVersion, setOpenVersion] = useState(0);
  const opening = useRef<((opened: boolean) => void) | null>(null);
  const handleOpenResult = useCallback((opened: boolean) => opening.current?.(opened), []);
  useEffect(() => () => opening.current?.(false), []);
  const openCodingPlanUpgrade = useCallback(
    (
      _nextTarget: CodingPlanUpgradeDialogTarget,
      observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
    ) => {
      if (observation?.signal.aborted) return false;
      // The web app has no Electron <webview>: every upgrade entry routes through the
      // Latch billing seam instead (signed-in users go to /pricing, signed-out users
      // go to /signin first). The split has to happen before mounting the dialog,
      // otherwise the browser renders a blank "Upgrade Plan" dialog (the webview tag
      // does not exist and the loadError fallback never fires).
      if (isWebRuntime()) {
        openLatchBillingEntry({ platform, intent: "purchase" });
        return true;
      }
      // Desktop no longer opens the provider plan webview either: Latch subscriptions
      // ($14/month, $99/year) complete on the Latch pricing page in the system
      // browser, and the embedded provider upgrade dialog is retired as a whole.
      openLatchBillingEntry({ platform, intent: "purchase" });
      observation?.onResult(true);
      return true;
    },
    [platform],
  );
  const value = useMemo(
    () => ({ openCodingPlanUpgrade, inventory }),
    [openCodingPlanUpgrade, inventory],
  );

  return (
    <CodingPlanUpgradeDialogContext.Provider value={value}>
      {children}
      <CodingPlanUpgradeDialog
        key={openVersion}
        target={target}
        onClose={() => {
          handleOpenResult(false);
          setTarget(undefined);
        }}
        onOpenResult={opening.current ?? undefined}
        onReopen={setTarget}
      />
    </CodingPlanUpgradeDialogContext.Provider>
  );
}

export function useCodingPlanUpgradeDialog() {
  const context = useContext(CodingPlanUpgradeDialogContext);
  if (!context) {
    throw new Error(
      "useCodingPlanUpgradeDialog must be used within CodingPlanUpgradeDialogProvider",
    );
  }
  return context;
}

/**
 * A conversation pane that can be mounted standalone uses the optional context;
 * the full app root still injects the real purchase panel.
 */
export function useOptionalCodingPlanUpgradeDialog() {
  return useContext(CodingPlanUpgradeDialogContext);
}
