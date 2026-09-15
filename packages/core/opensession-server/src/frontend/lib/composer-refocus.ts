// Hand the caret back to the composer when the desktop window regains focus.
//
// Leaving the app (⌘-tab, another window, the lock screen) and coming back
// should land you typing again, not clicking into the composer first. The
// window `focus` event is the signal; the rest of this file is about when NOT
// to take the caret, because a focus event also precedes the click that
// activated the window, and that click may be pointing at something specific.

import { blockingOverlayOpen } from "./blocking-overlay";

/**
 * Wait this long after the window regains focus before taking the caret. A
 * click-to-activate delivers its mousedown after the focus event, and that
 * mousedown decides where focus really goes (an input, a button, or the body
 * when the click landed on plain transcript text). Deciding after it has
 * landed means we can yield to a real target and still catch the body case.
 */
export const COMPOSER_REFOCUS_DELAY_MS = 120;

const EDITABLE_TAG = /^(input|textarea|select)$/i;

/** Surfaces whose focus must not be pulled out from under the person. */
const FOCUS_OWNING_ANCESTOR =
  '[role="dialog"], [role="menu"], [role="listbox"]';

// The slices of the DOM this decision reads. Structural so the real
// `document` and a test stand-in both fit without assertions.
export interface RefocusElement {
  readonly tagName: string;
  readonly isContentEditable?: boolean;
  closest?(selector: string): object | null;
}

export interface RefocusComposer extends RefocusElement {
  readonly disabled: boolean;
  focus(options?: FocusOptions): void;
}

export interface RefocusDocument {
  readonly activeElement: RefocusElement | null;
  readonly body: RefocusElement | null;
  querySelector(selector: string): object | null;
  getSelection?(): { readonly isCollapsed: boolean } | null;
}

export interface FocusTarget {
  addEventListener(type: "focus", listener: () => void): void;
  removeEventListener(type: "focus", listener: () => void): void;
}

function activeElementKeepsFocus(doc: RefocusDocument): boolean {
  const active = doc.activeElement;
  if (!active || active === doc.body) return false;
  if (EDITABLE_TAG.test(active.tagName)) return true;
  if (active.isContentEditable === true) return true;
  return !!active.closest?.(FOCUS_OWNING_ANCESTOR);
}

/**
 * Whether the composer should take the caret now. False when there is no
 * usable composer, when it already has it, when a blocking overlay is open,
 * when another editable or a dialog owns focus, or when text is selected
 * (a drag-select that started with the activating click).
 */
export function shouldRefocusComposer(
  doc: RefocusDocument,
  composer: RefocusComposer | null,
): boolean {
  if (!composer || composer.disabled) return false;
  if (doc.activeElement === composer) return false;
  if (blockingOverlayOpen(doc)) return false;
  if (activeElementKeepsFocus(doc)) return false;
  const selection = doc.getSelection?.();
  if (selection && !selection.isCollapsed) return false;
  return true;
}

/**
 * Subscribe to the window's `focus` and, after the delay, focus the composer
 * when {@link shouldRefocusComposer} agrees. Returns the unsubscribe.
 */
export function refocusComposerOnWindowFocus(
  target: FocusTarget,
  doc: RefocusDocument,
  getComposer: () => RefocusComposer | null,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onFocus = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const composer = getComposer();
      if (shouldRefocusComposer(doc, composer))
        composer?.focus({ preventScroll: true });
    }, COMPOSER_REFOCUS_DELAY_MS);
  };
  target.addEventListener("focus", onFocus);
  return () => {
    clearTimeout(timer);
    target.removeEventListener("focus", onFocus);
  };
}
