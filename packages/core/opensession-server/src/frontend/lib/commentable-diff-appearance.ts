import type { CSSProperties } from "react";
import type { BaseDiffOptions } from "@pierre/diffs";

// Pierre supports these Shiki themes directly. Match the shared code highlighter
// without importing its full grammar registry or registering duplicate themes.
export function diffAppearanceOptions(
  theme: "light" | "dark",
  structuralHighlighting: boolean,
) {
  return {
    theme: theme === "light" ? "github-light-default" : "github-dark-default",
    themeType: theme,
    diffIndicators: "classic",
    lineDiffType: structuralHighlighting ? "word-alt" : "none",
  } as const satisfies BaseDiffOptions;
}

// Pierre mixes line/gutter targets into its canvas again (12%/20% for code).
// Soften those targets, not the text, and retain stronger word-level emphasis.
// Neutral numbers follow the selected code canvas, not the surrounding app
// theme: an explicit light/dark code override must still be readable.
const QUIET_DIFF_COLORS = {
  "--diffs-addition-color-override": "var(--green)",
  "--diffs-deletion-color-override": "var(--red)",
  "--diffs-bg-addition-override":
    "color-mix(in srgb, var(--green) 50%, var(--diffs-bg))",
  "--diffs-bg-deletion-override":
    "color-mix(in srgb, var(--red) 50%, var(--diffs-bg))",
  "--diffs-bg-addition-number-override":
    "color-mix(in srgb, var(--green) 50%, var(--diffs-bg))",
  "--diffs-bg-deletion-number-override":
    "color-mix(in srgb, var(--red) 50%, var(--diffs-bg))",
  "--diffs-bg-addition-emphasis-override":
    "color-mix(in srgb, var(--green) 16%, transparent)",
  "--diffs-bg-deletion-emphasis-override":
    "color-mix(in srgb, var(--red) 16%, transparent)",
};

/* Review headers stay neutral while Pierre's omitted-context rows carry the
   blue cue. Both follow the selected code theme, not the app theme. */
type DiffSurfaceStyle = CSSProperties & {
  [key: `--${string}`]: string;
  "--diffs-bg": string;
  "--diffs-bg-separator-override": string;
  "--review-file-border": string;
  "--review-file-header-bg": string;
  "--review-file-header-hover": string;
};
export const DIFF_SURFACE_STYLE: Record<"light" | "dark", DiffSurfaceStyle> = {
  light: {
    ...QUIET_DIFF_COLORS,
    "--diffs-bg": "var(--review-code-light)",
    "--diffs-fg-number-override":
      "color-mix(in srgb, var(--review-code-dark) 60%, var(--review-code-light))",
    "--diffs-fg-number-addition-override":
      "color-mix(in srgb, var(--review-code-dark) 60%, var(--review-code-light))",
    "--diffs-fg-number-deletion-override":
      "color-mix(in srgb, var(--review-code-dark) 60%, var(--review-code-light))",
    "--diffs-bg-separator-override":
      "color-mix(in srgb, var(--blue) 12%, var(--review-code-light))",
    "--review-file-border":
      "color-mix(in srgb, var(--review-code-light) 90%, var(--review-code-dark))",
    "--review-file-header-bg":
      "color-mix(in srgb, var(--review-code-light) 96%, var(--review-code-dark))",
    "--review-file-header-hover":
      "color-mix(in srgb, var(--review-code-light) 92%, var(--review-code-dark))",
    backgroundColor: "var(--review-code-light)",
  },
  dark: {
    ...QUIET_DIFF_COLORS,
    "--diffs-bg": "var(--review-code-dark)",
    "--diffs-fg-number-override":
      "color-mix(in srgb, var(--review-code-light) 60%, var(--review-code-dark))",
    "--diffs-fg-number-addition-override":
      "color-mix(in srgb, var(--review-code-light) 60%, var(--review-code-dark))",
    "--diffs-fg-number-deletion-override":
      "color-mix(in srgb, var(--review-code-light) 60%, var(--review-code-dark))",
    "--diffs-bg-separator-override":
      "color-mix(in srgb, var(--blue) 12%, var(--review-code-dark))",
    "--review-file-border":
      "color-mix(in srgb, var(--review-code-dark) 90%, var(--review-code-light))",
    "--review-file-header-bg":
      "color-mix(in srgb, var(--review-code-dark) 94%, var(--review-code-light))",
    "--review-file-header-hover":
      "color-mix(in srgb, var(--review-code-dark) 90%, var(--review-code-light))",
    backgroundColor: "var(--review-code-dark)",
  },
};
