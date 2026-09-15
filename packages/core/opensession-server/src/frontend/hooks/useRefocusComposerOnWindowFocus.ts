import { useEffect, type RefObject } from "react";

import { refocusComposerOnWindowFocus } from "../lib/composer-refocus";

/**
 * While enabled, returning to the window puts the caret back in the composer.
 * Callers gate `enabled` on the pane being the focused one, the composer
 * being on screen, and the client being the desktop shell.
 */
export function useRefocusComposerOnWindowFocus(
  enabled: boolean,
  composerRef: RefObject<HTMLTextAreaElement | null>,
): void {
  useEffect(() => {
    if (!enabled) return;
    return refocusComposerOnWindowFocus(
      window,
      document,
      () => composerRef.current,
    );
  }, [enabled, composerRef]);
}
