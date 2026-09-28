import { z } from "zod";
import { os1Shell } from "./os1-shell";

// This device's alert behaviour: whether a banner shows, which sound plays,
// and when. What to notify about is the person's server-side setting
// (lib/notifications.ts); this file only decides how this device presents a
// notification it has been handed. Persisted in localStorage and edited in
// Settings › Notifications. The desktop banner additionally requires the
// browser's own Notification permission.

export type NotifSound = "chime" | "ping" | "bell" | "none";
export type NotifWhen = "always" | "unfocused" | "off";

export interface NotifSettings {
  /** Show a desktop banner (needs OS Notification permission too). */
  desktop: boolean;
  /** Which sound plays on an alert. */
  sound: NotifSound;
  /** When to alert at all. */
  when: NotifWhen;
}

export const SOUND_OPTIONS: { value: NotifSound; label: string }[] = [
  { value: "chime", label: "Chime" },
  { value: "ping", label: "Ping" },
  { value: "bell", label: "Bell" },
  { value: "none", label: "None" },
];

export const WHEN_OPTIONS: { value: NotifWhen; label: string }[] = [
  { value: "always", label: "Always" },
  { value: "unfocused", label: "Only when unfocused" },
  { value: "off", label: "Off" },
];

const KEY = "opensession-notif-settings";
const CHANGE_EVENT = "opensession-notif-changed";
// Legacy single on/off flag (pre-Settings); migrated on first read.
const LEGACY_KEY = "opensession-input-alerts";

const DEFAULTS: NotifSettings = {
  desktop: true,
  sound: "chime",
  when: "unfocused",
};

// What an earlier or later build may have left in storage. Each field is
// optional and a bad one falls away on its own, so one stale value never
// resets the rest.
const storedSettingsSchema = z.object({
  desktop: z.boolean().optional().catch(undefined),
  sound: z.enum(["chime", "ping", "bell", "none"]).optional().catch(undefined),
  when: z.enum(["always", "unfocused", "off"]).optional().catch(undefined),
  // The event switches from before they moved to the server.
  needsInput: z.boolean().optional().catch(undefined),
  done: z.boolean().optional().catch(undefined),
});
type StoredSettings = z.infer<typeof storedSettingsSchema>;

function storedSettings(): StoredSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = storedSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface LegacyEventSettings {
  needsInput?: boolean;
  done?: boolean;
}

/**
 * The event switches this device used to keep before they moved to the
 * server, when they differ from the defaults. Read once to carry a person's
 * choice over (lib/notifications.ts), never written.
 */
export function legacyEventSettings(): LegacyEventSettings | null {
  const stored = storedSettings();
  if (!stored) return null;
  const out: LegacyEventSettings = {};
  if (stored.needsInput === false) out.needsInput = false;
  if (stored.done === true) out.done = true;
  return Object.keys(out).length ? out : null;
}

export function getNotifSettings(): NotifSettings {
  const stored = storedSettings();
  if (stored)
    return {
      desktop: stored.desktop ?? DEFAULTS.desktop,
      sound: stored.sound ?? DEFAULTS.sound,
      when: stored.when ?? DEFAULTS.when,
    };
  // One-time migration: a user who had explicitly muted the old flag keeps
  // alerts off; otherwise fall through to defaults.
  try {
    if (localStorage.getItem(LEGACY_KEY) === "off")
      return { ...DEFAULTS, when: "off" };
  } catch {
    // Storage unavailable: defaults.
  }
  return { ...DEFAULTS };
}

export function setNotifSettings(patch: Partial<NotifSettings>): NotifSettings {
  const next = { ...getNotifSettings(), ...patch };
  // Keep keys this version no longer owns (the legacy event switches), so
  // the one-time carry-over still sees them.
  localStorage.setItem(KEY, JSON.stringify({ ...storedSettings(), ...next }));
  // Any settings edit is a user gesture — a good moment to arm audio and ask for
  // notification permission if we'll want them.
  armAudio();
  if (next.desktop) requestPermission();
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

export function onNotifSettingsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

let audioCtx: AudioContext | null = null;

// An AudioContext can't start without a user gesture, and asking for Notification
// permission is best done from one too. Arm both on the first pointer/key
// interaction, then detach. Idempotent — safe to call repeatedly.
export function initAlerts(): void {
  const arm = () => {
    armAudio();
    window.removeEventListener("pointerdown", arm);
    window.removeEventListener("keydown", arm);
  };
  window.addEventListener("pointerdown", arm);
  window.addEventListener("keydown", arm);
}

function armAudio(): void {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx?.state === "suspended") void audioCtx.resume();
  } catch {
    // AudioContext unavailable (old browser / blocked) — sound just no-ops.
  }
}

function requestPermission(): void {
  try {
    if ("Notification" in window && Notification.permission === "default")
      void Notification.requestPermission().catch(() => {});
  } catch {
    // Notification API unavailable — banner just no-ops.
  }
}

// Ask for OS notification permission from a user gesture (e.g. toggling the
// desktop-notifications switch on).
export function ensureNotificationPermission(): void {
  requestPermission();
}

// Short WebAudio tones — no asset to bundle. Each sound is a sequence of
// (frequency, startOffset) notes with a soft attack + exponential decay.
const SOUND_NOTES: Record<Exclude<NotifSound, "none">, [number, number][]> = {
  chime: [
    [660, 0],
    [880, 0.14],
  ],
  ping: [[880, 0]],
  bell: [
    [988, 0],
    [1319, 0.16],
    [988, 0.32],
  ],
};

// Play a sound unconditionally (used by the Settings "Test" button and by the
// alert path once it has decided to fire). Defaults to the configured sound.
export function playSound(kind: NotifSound = getNotifSettings().sound): void {
  if (kind === "none") return;
  armAudio();
  const ctx = audioCtx;
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  for (const [freq, offset] of SOUND_NOTES[kind]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = now + offset;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.14, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.24);
  }
}

/** The person is looking at this window right now. */
export function appFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

// Bring the app forward from a notification click. In the desktop shell the
// page's own window.focus() does not raise the window on macOS, so the shell's
// main process is asked to do it (os1-mac preload). Older shells do not expose
// that bridge, hence the feature check.
export function focusApp(): void {
  try {
    const shell = os1Shell();
    if (shell?.focusWindow instanceof Function) shell.focusWindow();
  } catch {
    // The bridge is missing or threw. The plain focus below still runs.
  }
  try {
    window.focus();
  } catch {
    // Focus can be refused; the click still routes.
  }
}

// Banners this page raised, by tag, so a read on another device can take
// them down again.
const shown = new Map<string, Notification>();

/**
 * Present one notification on this device: sound and a desktop banner,
 * subject to this device's settings. `tag` names what it is about, so a newer
 * banner about the same thing replaces the older one instead of stacking.
 */
export function showAlert(alert: {
  title: string;
  body: string;
  tag: string;
  onClick: () => void;
}): void {
  const s = getNotifSettings();
  if (s.when === "off") return;
  if (s.when === "unfocused" && appFocused()) return;
  playSound(s.sound);
  if (!s.desktop) return;
  try {
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    const n = new Notification(alert.title, {
      body: alert.body,
      tag: alert.tag,
    });
    shown.get(alert.tag)?.close();
    shown.set(alert.tag, n);
    n.onclick = () => {
      focusApp();
      alert.onClick();
      n.close();
    };
    n.onclose = () => {
      if (shown.get(alert.tag) === n) shown.delete(alert.tag);
    };
  } catch {
    // Constructing a Notification can throw on some platforms — ignore.
  }
}

/** Take down a banner once what it announced has been seen elsewhere. */
export function closeAlert(tag: string): void {
  shown.get(tag)?.close();
  shown.delete(tag);
  // Pushed banners belong to the service worker, not this page.
  try {
    void navigator.serviceWorker
      ?.getRegistration()
      .then((registration) => registration?.getNotifications({ tag }))
      .then((notifications) => {
        for (const n of notifications ?? []) n.close();
      })
      .catch(() => {});
  } catch {}
}
