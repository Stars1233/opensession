/**
 * Desktop control for any Sandbox that runs a plain X display: `xdotool` for
 * input, ImageMagick `import` for screenshots, all over the Sandbox's own
 * `exec`. Box ships both on `:0`; a provider without a native control API
 * gets the same tool surface this way.
 */
import type {
  ExecOpts,
  ExecResult,
  SandboxDesktopControl,
  SandboxDesktopWindow,
  SandboxMouseButton,
  SandboxScreenshot,
} from "./provider";

export type X11Exec = (cmd: string[], opts?: ExecOpts) => Promise<ExecResult>;

const X11_BUTTON: Record<SandboxMouseButton, string> = {
  left: "1",
  middle: "2",
  right: "3",
};

const X11_KEY_ALIASES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  page_up: "Page_Up",
  pagedown: "Page_Down",
  page_down: "Page_Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "super",
  meta: "super",
  win: "super",
  super: "super",
};

/**
 * Normalize a chord like `ctrl+l`, `Cmd+Shift+T` or `Enter` into xdotool's
 * `ctrl+l`, `super+shift+t`, `Return`. Anything outside keysym characters is
 * refused so the chord can never smuggle a second command.
 */
export function x11KeyChord(chord: string): string {
  const parts = chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("Key chord is empty");
  return parts
    .map((part) => {
      const alias = X11_KEY_ALIASES[part.toLowerCase()];
      if (alias) return alias;
      if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) return part.toUpperCase();
      if (!/^[A-Za-z0-9_]+$/.test(part))
        throw new Error(`Unsupported key "${part}"`);
      return part.length === 1 ? part.toLowerCase() : part;
    })
    .join("+");
}

function px(value: number, name: string): string {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number`);
  return String(Math.round(value));
}

/** The shell pipeline that captures the root window as base64. `scale` and
 *  `format` are validated numbers and enum values, never free text. */
export function x11ScreenshotScript(
  display: string,
  scale: number,
  format: "png" | "jpeg",
): string {
  if (!/^:[0-9]+(\.[0-9]+)?$/.test(display))
    throw new Error(`Invalid X display "${display}"`);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1)
    throw new Error("scale must be between 0 and 1");
  const resize = scale === 1 ? "" : ` -resize ${Math.round(scale * 100)}%`;
  const encoder = format === "jpeg" ? "-quality 80 jpeg:-" : "png:-";
  return `DISPLAY=${display} import -window root${resize} ${encoder} | base64 -w0`;
}

export function x11DesktopControl(
  exec: X11Exec,
  display = ":0",
): SandboxDesktopControl {
  const xdotool = async (...args: string[]): Promise<string> => {
    const result = await exec(
      ["env", `DISPLAY=${display}`, "xdotool", ...args],
      {
        timeoutMs: 30_000,
      },
    );
    if (result.exitCode !== 0)
      throw new Error(
        `xdotool ${args[0]} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
      );
    return result.stdout;
  };
  const displaySize = async () => {
    const [width, height] = (await xdotool("getdisplaygeometry"))
      .trim()
      .split(/\s+/)
      .map(Number);
    if (!width || !height) throw new Error("Could not read the display size");
    return { width, height };
  };
  return {
    async screenshot(options = {}) {
      const scale = options.scale ?? 1;
      const format = options.format ?? "png";
      const [size, result] = await Promise.all([
        displaySize(),
        exec(["bash", "-c", x11ScreenshotScript(display, scale, format)], {
          timeoutMs: 60_000,
        }),
      ]);
      const data = result.stdout.trim();
      if (result.exitCode !== 0 || !data)
        throw new Error(
          `Screenshot failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        );
      return {
        data,
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        width: size.width,
        height: size.height,
      } satisfies SandboxScreenshot;
    },
    display: displaySize,
    async windows() {
      const result = await exec(
        [
          "bash",
          "-c",
          `export DISPLAY=${display}; active=$(xdotool getactivewindow 2>/dev/null); ` +
            `for w in $(xdotool search --onlyvisible --name . 2>/dev/null | head -40); do ` +
            `eval "$(xdotool getwindowgeometry --shell "$w" 2>/dev/null)"; ` +
            `printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$w" "$X" "$Y" "$WIDTH" "$HEIGHT" "$([ "$w" = "$active" ] && echo 1 || echo 0)" "$(xdotool getwindowname "$w" 2>/dev/null)"; done`,
        ],
        { timeoutMs: 30_000 },
      );
      return parseX11Windows(result.stdout);
    },
    async move(x, y) {
      await xdotool("mousemove", px(x, "x"), px(y, "y"));
    },
    async click(x, y, options = {}) {
      const button = X11_BUTTON[options.button ?? "left"];
      await xdotool(
        "mousemove",
        px(x, "x"),
        px(y, "y"),
        "click",
        ...(options.double ? ["--repeat", "2", "--delay", "80"] : []),
        button,
      );
    },
    async drag(from, to, options = {}) {
      const button = X11_BUTTON[options.button ?? "left"];
      await xdotool(
        "mousemove",
        px(from.x, "x"),
        px(from.y, "y"),
        "mousedown",
        button,
        "sleep",
        "0.15",
        "mousemove",
        px(to.x, "x"),
        px(to.y, "y"),
        "sleep",
        "0.15",
        "mouseup",
        button,
      );
    },
    async scroll(x, y, direction, amount = 3) {
      const clicks = Math.min(50, Math.max(1, Math.round(amount)));
      await xdotool(
        "mousemove",
        px(x, "x"),
        px(y, "y"),
        "click",
        "--repeat",
        String(clicks),
        "--delay",
        "30",
        direction === "up" ? "4" : "5",
      );
    },
    async type(text) {
      if (!text) return;
      await xdotool("type", "--delay", "12", "--", text);
    },
    async key(chord) {
      await xdotool("key", "--clearmodifiers", x11KeyChord(chord));
    },
  };
}

export function parseX11Windows(output: string): SandboxDesktopWindow[] {
  const windows: SandboxDesktopWindow[] = [];
  for (const line of output.split("\n")) {
    const [id, x, y, width, height, active, ...title] = line.split("\t");
    if (!id || !width || !height) continue;
    windows.push({
      id,
      title: title.join("\t").trim(),
      x: Number(x) || 0,
      y: Number(y) || 0,
      width: Number(width) || 0,
      height: Number(height) || 0,
      active: active === "1",
    });
  }
  return windows;
}
