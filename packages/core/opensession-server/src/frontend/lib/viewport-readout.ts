// A live readout of the numbers the phone layout depends on: window and
// screen size, the visual viewport's height, pan and scale, the keyboard
// state, and what the standalone bootstrap's phantom-pan release last saw.
// Off by default; a Debug switch in Preferences turns it on for this device
// only. It exists so a screenshot of a misbehaving phone carries the
// measurements instead of another guess.

/** What the standalone bootstrap (index.html) records about its phantom-pan
 * release: how often it ran, why the last run stopped, and the readings it
 * stopped on. */
export interface PanReleaseRecord {
  runs: number;
  released: number;
  reason: string;
  pan: number;
  scrollY: number;
  scale: number;
  viewportEvents: number;
  scrollerEvents: number;
}

declare global {
  interface Window {
    __os1PanRelease?: PanReleaseRecord;
  }
}

export interface ViewportSample {
  platform: string;
  standalone: boolean;
  innerWidth: number;
  innerHeight: number;
  screenWidth: number;
  screenHeight: number;
  rootHeight: string;
  viewportHeight: number | null;
  viewportOffsetTop: number | null;
  viewportPageTop: number | null;
  viewportScale: number | null;
  scrollY: number;
  keyboard: boolean;
  focused: string;
  hidden: boolean;
  scrollerTop: number | null;
  pan: PanReleaseRecord | null;
}

const KEY = "opensession-viewport-readout";
const EVENT = "opensession-viewport-readout-changed";

export function getViewportReadoutPref(): boolean {
  return localStorage.getItem(KEY) === "on";
}

export function setViewportReadoutPref(on: boolean) {
  if (on) localStorage.setItem(KEY, "on");
  else localStorage.removeItem(KEY);
  window.dispatchEvent(new Event(EVENT));
}

export function onViewportReadoutChanged(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** "iOS 27.0" from a WebKit user agent, else the platform string. */
export function describePlatform(userAgent: string, platform: string): string {
  const ios = /(?:iPhone|CPU) OS (\d+)_(\d+)/.exec(userAgent);
  if (ios) return `iOS ${ios[1]}.${ios[2]}`;
  return platform || "unknown";
}

export function sampleViewport(): ViewportSample {
  const viewport = window.visualViewport;
  const scroller = document.querySelector<HTMLElement>(".viewer-messages");
  return {
    platform: describePlatform(navigator.userAgent, navigator.platform),
    standalone:
      matchMedia("(display-mode: standalone)").matches ||
      ("standalone" in navigator && navigator.standalone === true),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    rootHeight: document.documentElement.style.height,
    viewportHeight: viewport ? Math.round(viewport.height) : null,
    viewportOffsetTop: viewport ? Math.round(viewport.offsetTop) : null,
    viewportPageTop: viewport ? Math.round(viewport.pageTop) : null,
    viewportScale: viewport ? Math.round(viewport.scale * 1000) / 1000 : null,
    scrollY: Math.round(window.scrollY),
    keyboard: document.body.classList.contains("kb-open"),
    focused: document.activeElement?.tagName.toLowerCase() ?? "none",
    hidden: document.hidden,
    scrollerTop: scroller ? Math.round(scroller.scrollTop) : null,
    pan: window.__os1PanRelease ?? null,
  };
}

const orDash = (value: number | string | null) =>
  value === null ? "-" : value;

export function formatViewportReadout(sample: ViewportSample): string[] {
  const { pan } = sample;
  return [
    `${sample.platform} ${sample.standalone ? "standalone" : "browser"}`,
    `win ${sample.innerWidth}x${sample.innerHeight} screen ${sample.screenWidth}x${sample.screenHeight} root ${sample.rootHeight || "auto"}`,
    `vv h${orDash(sample.viewportHeight)} top${orDash(sample.viewportOffsetTop)} page${orDash(sample.viewportPageTop)} scale${orDash(sample.viewportScale)} scrollY ${sample.scrollY}`,
    `kb ${sample.keyboard ? "open" : "closed"} focus ${sample.focused} ${sample.hidden ? "hidden" : "visible"} scroller ${orDash(sample.scrollerTop)}`,
    pan
      ? `pan ${pan.reason} runs${pan.runs} rel${pan.released} pan${pan.pan} sy${pan.scrollY} scale${pan.scale} vv${pan.viewportEvents} sc${pan.scrollerEvents}`
      : "pan release not installed",
  ];
}
