import { useEffect } from "react";
import type { PreviewService } from "../lib/api";
import {
  defaultSidebarPortalFor,
  portalOpenPlacement,
  type PortalTarget,
} from "../lib/portals";

interface SimulatorPortalPlacementOptions {
  sessionId: string;
  focused: boolean;
  isPhone: boolean;
  services: PreviewService[];
  routedPortal: PortalTarget | null;
  pinnedPortal: PortalTarget | null;
  openPortal?: (target: PortalTarget) => void;
  openSession?: (sessionId: string) => void;
  setPanelOpen: (open: boolean) => void;
  pinPortal: (target: PortalTarget) => void;
  autoPinPortal: (target: PortalTarget) => boolean;
  expandPinnedPortal: () => PortalTarget | null;
}

/** Keep portrait simulator Portals beside the conversation on desktop while
 * preserving the single full-width Portal surface on phones. */
export function useSimulatorPortalPlacement({
  sessionId,
  focused,
  isPhone,
  services,
  routedPortal,
  pinnedPortal,
  openPortal,
  openSession,
  setPanelOpen,
  pinPortal,
  autoPinPortal,
  expandPinnedPortal,
}: SimulatorPortalPlacementOptions) {
  useEffect(() => {
    if (!isPhone || !pinnedPortal) return;
    const target = expandPinnedPortal();
    if (!target) return;
    setPanelOpen(false);
    openPortal?.(target);
  }, [expandPinnedPortal, isPhone, openPortal, pinnedPortal, setPanelOpen]);

  const defaultSidebarPortal = defaultSidebarPortalFor(
    sessionId,
    services,
    routedPortal,
    isPhone,
  );
  const routedSimulatorPortal =
    !!routedPortal && defaultSidebarPortal === routedPortal;
  useEffect(() => {
    if (!focused || !defaultSidebarPortal) return;
    if (!autoPinPortal(defaultSidebarPortal)) return;
    setPanelOpen(true);
    if (routedSimulatorPortal) openSession?.(sessionId);
  }, [
    autoPinPortal,
    defaultSidebarPortal,
    focused,
    openSession,
    routedSimulatorPortal,
    sessionId,
    setPanelOpen,
  ]);

  return (target: PortalTarget) => {
    if (portalOpenPlacement(target, isPhone) === "main") {
      openPortal?.(target);
      return;
    }
    pinPortal(target);
    setPanelOpen(true);
    openSession?.(sessionId);
  };
}
