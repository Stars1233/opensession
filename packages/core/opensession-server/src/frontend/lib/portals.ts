import type { PreviewService } from "./api";

/** A running preview service opened in the center-panel browser. */
export interface PortalTarget {
  sessionId: string;
  name: string;
  key: string;
  port: number;
  url: string;
}

const IOS_SIMULATOR_PORTAL_NAME = /^ios-simulator-[0-9a-f]{12}/i;

/** Simulator streams are portrait-shaped, so desktop gives them the tall side
 * panel by default. The phone keeps its single full-width portal surface. */
export function portalOpenPlacement(
  target: Pick<PortalTarget, "name">,
  isPhone: boolean,
): "main" | "sidebar" {
  return !isPhone && IOS_SIMULATOR_PORTAL_NAME.test(target.name)
    ? "sidebar"
    : "main";
}

/** Find the simulator belonging to this viewer, whether navigation already
 * opened it or the session's Portal poll has just discovered it. */
export function defaultSidebarPortalFor(
  sessionId: string,
  services: PreviewService[],
  routedTarget: PortalTarget | null,
  isPhone: boolean,
): PortalTarget | null {
  if (
    routedTarget?.sessionId === sessionId &&
    portalOpenPlacement(routedTarget, isPhone) === "sidebar"
  )
    return routedTarget;
  for (const service of services) {
    const target = portalTargetFor(sessionId, service);
    if (target && portalOpenPlacement(target, isPhone) === "sidebar")
      return target;
  }
  return null;
}

export function portalTargetFor(
  sessionId: string,
  service: PreviewService,
): PortalTarget | null {
  const openable = service.running || service.state === "sleeping";
  if (!openable || !service.previewUrl) return null;
  const url = service.defaultPath
    ? new URL(
        service.defaultPath.startsWith("/")
          ? service.defaultPath
          : `/${service.defaultPath}`,
        service.previewUrl,
      ).toString()
    : service.previewUrl;
  return {
    sessionId,
    name: service.name,
    key: service.key,
    port: service.port,
    url,
  };
}
