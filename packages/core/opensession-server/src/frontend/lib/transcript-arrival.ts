import {
  newTailBlockKeys,
  shouldAnimateTranscriptItemArrival,
  TAIL_ARRIVAL_WINDOW,
} from "./transcript-block-identity";

export interface TranscriptArrivalItem {
  key: string;
  entryIds: string[];
  arrivalAliases?: string[];
  animateArrival?: boolean;
}

const NO_ARRIVALS: ReadonlySet<string> = new Set();

/**
 * Which blocks just arrived at the live edge, decided once per item list.
 *
 * The virtualizer re-renders for scrolling, measurement, and viewport
 * geometry far more often than the transcript changes, and every one of those
 * renders receives the same immutable `items` array. Reconciliation (block
 * keys and painted entry identities) is therefore keyed on array identity:
 * a list already reconciled costs nothing, and only a new list is walked.
 *
 * The result is not an entitlement that lives as long as the array. It is
 * consumed by the render that reconciled the list: a later render of the
 * same list (a row virtualized out and mounted back in, a remeasure) gets an
 * empty set, so a stateless entrance wrapper never replays the fade.
 */
export class TranscriptArrivalTracker {
  private reconciled: readonly TranscriptArrivalItem[] | null = null;
  /** Every block key ever mounted. The first build seeds without animating;
   * keys stay in the set once seen, so a virtualizer remount never replays. */
  private mountedKeys: Set<string> | null = null;
  /** Entry identities already painted inside those blocks. Unlike block keys,
   * these survive an optimistic row becoming a new durable transcript range,
   * and a range rebuilt under a new key keeps them as its stable identity. */
  private mountedEntryIds = new Set<string>();

  reconcile(items: readonly TranscriptArrivalItem[]): ReadonlySet<string> {
    if (items === this.reconciled) return NO_ARRIVALS;
    this.reconciled = items;
    // Only the tail window can arrive, so hand `newTailBlockKeys` that slice
    // instead of copying every key.
    const tail = items.slice(-TAIL_ARRIVAL_WINDOW);
    const fresh = newTailBlockKeys(
      this.mountedKeys,
      tail.map((item) => item.key),
    );
    let entering: Set<string> | undefined;
    for (const key of fresh) {
      const item = tail.find((candidate) => candidate.key === key);
      if (
        item &&
        !shouldAnimateTranscriptItemArrival(item, this.mountedEntryIds)
      )
        continue;
      (entering ??= new Set()).add(key);
    }
    // Ingest after deciding: an id painted in this build must not veto its
    // own arrival. Every item is walked, including blocks whose key already
    // mounted, because a live turn absorbs new steps under its existing key
    // and those ids are what later identifies a regrouped block as
    // reconciliation rather than an arrival.
    this.mountedKeys ??= new Set();
    for (const item of items) {
      this.mountedKeys.add(item.key);
      for (const entryId of item.entryIds) this.mountedEntryIds.add(entryId);
    }
    return entering ?? NO_ARRIVALS;
  }
}
