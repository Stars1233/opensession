import { useLayoutEffect } from "react";
import {
  pickDiffScrollAnchor,
  rememberDiffScroll,
  rememberedDiffScroll,
} from "../lib/diff-expansion";
import { scrollParent } from "./useStickyEdges";

/* Files mount a batch per frame and highlight after that, so the rows above
   the anchor keep growing for a moment after a remount. Hold the anchor in
   place until the reader moves or the layout has had this long to settle. */
const RESTORE_WINDOW_MS = 3000;

/**
 * Keep a multi-file diff's scroll position across remounts. The phone
 * Changes page unmounts whenever the reader goes back, so without this every
 * return starts at the top even though the open files were kept.
 */
export function useDiffScrollMemory(
  root: HTMLElement | null,
  key: string | undefined,
): void {
  useLayoutEffect(() => {
    if (!root || !key) return;
    const scroller = scrollParent(root);
    if (!scroller) return;
    const isDocument = scroller === document.scrollingElement;
    const edgeTop = () =>
      isDocument ? 0 : scroller.getBoundingClientRect().top;
    const rows = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>("[data-diff-file]"),
        (row) => ({
          path: row.dataset.diffFile ?? "",
          element: row,
          top: row.getBoundingClientRect().top,
        }),
      );

    let restoring = rememberedDiffScroll(key);
    const restore = () => {
      if (!restoring) return;
      const target = rows().find((row) => row.path === restoring!.path);
      if (!target) return;
      const delta = target.top - edgeTop() - restoring.offset;
      if (Math.abs(delta) > 1) scroller.scrollTop += delta;
    };
    const stopRestoring = () => {
      restoring = null;
      resize.disconnect();
      clearTimeout(timer);
    };
    const resize = new ResizeObserver(restore);
    const timer = setTimeout(stopRestoring, RESTORE_WINDOW_MS);
    if (restoring) {
      restore();
      resize.observe(root);
    }

    let frame = 0;
    const save = () => {
      frame = 0;
      // Our own corrections fire scroll events too; only the reader's
      // position is worth keeping.
      if (restoring || !root.isConnected) return;
      rememberDiffScroll(key, pickDiffScrollAnchor(rows(), edgeTop()));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(save);
    };
    const onInput = () => stopRestoring();
    const inputs = ["touchstart", "wheel", "pointerdown", "keydown"] as const;
    for (const type of inputs)
      scroller.addEventListener(type, onInput, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      stopRestoring();
      if (frame) cancelAnimationFrame(frame);
      for (const type of inputs) scroller.removeEventListener(type, onInput);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [root, key]);
}
