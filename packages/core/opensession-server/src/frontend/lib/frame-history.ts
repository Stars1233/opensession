/**
 * How far Back and Forward can go in a framed page. The frame is cross-origin,
 * but its navigations still join the window's history, so the toolbar steps
 * it with `history.go()`. What it cannot read is where the frame sits in that
 * history, so this estimates it:
 *
 * - A load of the same frame element that Back or Forward did not cause is a
 *   new page: one more step back, nothing ahead.
 * - A single-page app adds entries without loading, so when focus comes back
 *   from the frame, any growth in `history.length` counts as steps back too.
 *
 * The window's own Back button and the app's own routing share that history
 * and can move it without telling us, so this can drift. The one drift it
 * can see, the app pushing its own entries, disables both buttons.
 */
export interface FrameHistory {
  readonly back: number;
  readonly forward: number;
  /** Back or Forward was pressed and its load, if any, has not arrived. */
  readonly stepping: boolean;
  /** `history.length` when last observed. */
  readonly length: number;
}

export function freshFrameHistory(length: number): FrameHistory {
  return { back: 0, forward: 0, stepping: false, length };
}

/** A later load of the same frame element. */
export function frameLoaded(
  history: FrameHistory,
  length: number,
): FrameHistory {
  return history.stepping
    ? { ...history, stepping: false, length }
    : { back: history.back + 1, forward: 0, stepping: false, length };
}

export function canStepFrame(history: FrameHistory, delta: -1 | 1): boolean {
  return (delta < 0 ? history.back : history.forward) > 0;
}

/**
 * Back or Forward was pressed with `history.length` at `length`. A length the
 * frame did not cause means the app pushed entries after the frame's, so the
 * step is refused and the frame starts over from there.
 */
export function frameStepped(
  history: FrameHistory,
  delta: -1 | 1,
  length: number,
): FrameHistory {
  if (length !== history.length) return freshFrameHistory(length);
  if (!canStepFrame(history, delta)) return history;
  return {
    ...history,
    back: history.back + delta,
    forward: history.forward - delta,
    stepping: true,
  };
}

/**
 * Focus moved into the frame. A step that had no load (a single-page app
 * going back) is over by now, so the next load is a new page again.
 */
export function frameEntered(history: FrameHistory): FrameHistory {
  return history.stepping ? { ...history, stepping: false } : history;
}

/**
 * Focus came back from the frame, which may have pushed entries meanwhile.
 * The first push dropped whatever was ahead, so `pushed` entries change the
 * length by `pushed - forward`.
 */
export function frameReturned(
  history: FrameHistory,
  length: number,
): FrameHistory {
  if (length === history.length) return history;
  const pushed = length - history.length + history.forward;
  return pushed > 0
    ? { back: history.back + pushed, forward: 0, stepping: false, length }
    : { ...history, length };
}
