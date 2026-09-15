// No DOM preload in this repo (see lib/shortcuts.test.ts): the document and
// window are stand-ins that record what they were asked.

import { afterEach, describe, expect, jest, test } from "bun:test";

import {
  COMPOSER_REFOCUS_DELAY_MS,
  refocusComposerOnWindowFocus,
  shouldRefocusComposer,
  type RefocusComposer,
  type RefocusDocument,
  type RefocusElement,
} from "./composer-refocus";

type MutableDocument = {
  -readonly [K in keyof RefocusDocument]: RefocusDocument[K];
};

function element(
  tagName: string,
  extra: Partial<RefocusElement> = {},
): RefocusElement {
  return { tagName, closest: () => null, ...extra };
}

function composerElement(disabled = false) {
  const focused: (FocusOptions | undefined)[] = [];
  const composer: RefocusComposer = {
    tagName: "TEXTAREA",
    disabled,
    closest: () => null,
    focus: (options) => {
      focused.push(options);
    },
  };
  return { composer, focused };
}

function documentWith({
  activeElement = null,
  overlayOpen = false,
  selectionCollapsed = true,
}: {
  activeElement?: RefocusElement | null;
  overlayOpen?: boolean;
  selectionCollapsed?: boolean;
} = {}): MutableDocument {
  const body = element("BODY");
  return {
    body,
    activeElement: activeElement ?? body,
    querySelector: () => (overlayOpen ? {} : null),
    getSelection: () => ({ isCollapsed: selectionCollapsed }),
  };
}

describe("shouldRefocusComposer", () => {
  test("takes the caret when focus rests on the body", () => {
    const { composer } = composerElement();
    expect(shouldRefocusComposer(documentWith(), composer)).toBe(true);
  });

  test("does nothing without a usable composer", () => {
    expect(shouldRefocusComposer(documentWith(), null)).toBe(false);
    const { composer } = composerElement(true);
    expect(shouldRefocusComposer(documentWith(), composer)).toBe(false);
  });

  test("leaves a composer that already has the caret alone", () => {
    const { composer } = composerElement();
    const doc = documentWith({ activeElement: composer });
    expect(shouldRefocusComposer(doc, composer)).toBe(false);
  });

  test("yields to another editable, a dialog, and a selection", () => {
    const { composer } = composerElement();
    for (const doc of [
      documentWith({ activeElement: element("INPUT") }),
      documentWith({ activeElement: element("TEXTAREA") }),
      documentWith({
        activeElement: element("DIV", { isContentEditable: true }),
      }),
      documentWith({
        activeElement: element("BUTTON", { closest: () => ({}) }),
      }),
      documentWith({ overlayOpen: true }),
      documentWith({ selectionCollapsed: false }),
    ]) {
      expect(shouldRefocusComposer(doc, composer)).toBe(false);
    }
  });

  test("takes the caret from a plain focused button", () => {
    const { composer } = composerElement();
    const doc = documentWith({ activeElement: element("BUTTON") });
    expect(shouldRefocusComposer(doc, composer)).toBe(true);
  });
});

describe("refocusComposerOnWindowFocus", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function fakeWindow() {
    const listeners = new Set<() => void>();
    return {
      listeners,
      addEventListener: (_type: "focus", listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: "focus", listener: () => void) => {
        listeners.delete(listener);
      },
      focus: () => {
        for (const listener of listeners) listener();
      },
    };
  }

  test("focuses the composer after the delay, without scrolling", () => {
    jest.useFakeTimers();
    const target = fakeWindow();
    const { composer, focused } = composerElement();
    refocusComposerOnWindowFocus(target, documentWith(), () => composer);
    target.focus();
    jest.advanceTimersByTime(COMPOSER_REFOCUS_DELAY_MS - 1);
    expect(focused).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(focused).toEqual([{ preventScroll: true }]);
  });

  test("decides after the delay, so the activating click wins", () => {
    jest.useFakeTimers();
    const target = fakeWindow();
    const { composer, focused } = composerElement();
    const doc = documentWith();
    refocusComposerOnWindowFocus(target, doc, () => composer);
    target.focus();
    doc.activeElement = element("INPUT");
    jest.advanceTimersByTime(COMPOSER_REFOCUS_DELAY_MS);
    expect(focused).toEqual([]);
  });

  test("unsubscribing cancels a pending refocus", () => {
    jest.useFakeTimers();
    const target = fakeWindow();
    const { composer, focused } = composerElement();
    const stop = refocusComposerOnWindowFocus(
      target,
      documentWith(),
      () => composer,
    );
    target.focus();
    stop();
    jest.advanceTimersByTime(COMPOSER_REFOCUS_DELAY_MS);
    expect(focused).toEqual([]);
    expect(target.listeners.size).toBe(0);
  });
});
