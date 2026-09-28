import { type RefObject, useEffect, useEffectEvent } from "react";

/**
 * Calls `onEnter` when focus moves into the frame (the window blurs and the
 * frame becomes the active element) and `onReturn` when it comes back to
 * this window. See frame-history.ts for why the toolbar cares.
 */
export function useFrameFocus(
  frame: RefObject<HTMLIFrameElement | null>,
  onEnter: () => void,
  onReturn: () => void,
) {
  const enter = useEffectEvent(onEnter);
  const returned = useEffectEvent(onReturn);
  useEffect(() => {
    let inside = false;
    const blur = () => {
      if (!frame.current || document.activeElement !== frame.current) return;
      inside = true;
      enter();
    };
    const focus = () => {
      if (!inside) return;
      inside = false;
      returned();
    };
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
    };
  }, [frame]);
}
