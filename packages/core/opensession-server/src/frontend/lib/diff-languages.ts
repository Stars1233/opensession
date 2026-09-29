import { registerCustomLanguage } from "@pierre/diffs";

let registered = false;

/**
 * Teach @pierre/diffs the languages Shiki does not bundle, so review diffs
 * highlight them like the transcript does. Idempotent; call before rendering
 * a FileDiff. The grammar loads lazily on the first matching file.
 */
export function ensureDiffLanguages(): void {
  if (registered) return;
  registered = true;
  registerCustomLanguage(
    "rescript",
    async () => ({ default: [(await import("./rescript-language")).rescript] }),
    ["res", "resi"],
  );
}
