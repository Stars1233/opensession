import { describe, expect, test } from "bun:test";
import {
  TranscriptArrivalTracker,
  type TranscriptArrivalItem,
} from "./transcript-arrival";
import {
  newTailBlockKeys,
  TAIL_ARRIVAL_WINDOW,
} from "./transcript-block-identity";

function block(key: string, ...entryIds: string[]): TranscriptArrivalItem {
  return { key, entryIds: entryIds.length ? entryIds : [key] };
}

/** Wrap every item so each property read on it is counted. The tracker can
 * only learn a key or an entry id by reading it, so zero reads means zero
 * reconciliation work. */
function counted(items: TranscriptArrivalItem[]) {
  let reads = 0;
  const wrapped = items.map(
    (item) =>
      new Proxy(item, {
        get(target, property) {
          reads++;
          // SAFETY: the proxy forwards whichever field the tracker reads from
          // the same item; the fixture only declares arrival fields.
          return target[property as keyof TranscriptArrivalItem];
        },
      }),
  );
  return { items: wrapped, reads: () => reads };
}

function keys(set: ReadonlySet<string>) {
  return [...set].sort();
}

describe("TranscriptArrivalTracker", () => {
  test("the first build seeds without animating", () => {
    const tracker = new TranscriptArrivalTracker();
    expect(tracker.reconcile([block("a"), block("b"), block("c")]).size).toBe(
      0,
    );
  });

  test("a tail block appended by a new list arrives once", () => {
    const tracker = new TranscriptArrivalTracker();
    const opened = [block("a"), block("b"), block("c")];
    tracker.reconcile(opened);
    const appended = [...opened, block("d")];
    expect(keys(tracker.reconcile(appended))).toEqual(["d"]);
    // A copy with the same keys (another build) is not another arrival.
    expect(tracker.reconcile([...appended]).size).toBe(0);
  });

  test("re-rendering the same list does no reconciliation work", () => {
    const tracker = new TranscriptArrivalTracker();
    tracker.reconcile([block("a"), block("b")]);
    const { items, reads } = counted([block("a"), block("b"), block("c")]);
    expect(keys(tracker.reconcile(items))).toEqual(["c"]);
    const afterReconcile = reads();
    expect(afterReconcile).toBeGreaterThan(0);
    // Scroll, remeasure, and resize renders reuse the list.
    for (let render = 0; render < 5; render++)
      expect(tracker.reconcile(items).size).toBe(0);
    expect(reads()).toBe(afterReconcile);
  });

  test("a row virtualized out and back in over the same list does not replay", () => {
    const tracker = new TranscriptArrivalTracker();
    tracker.reconcile([block("a")]);
    const list = [block("a"), block("b")];
    // The reconciling render consumes the entrance. Every later render of
    // the same list, whether or not `b` was in the window, renders it plain.
    expect(keys(tracker.reconcile(list))).toEqual(["b"]);
    expect(tracker.reconcile(list).size).toBe(0);
    expect(tracker.reconcile(list).size).toBe(0);
  });

  test("ingests new entry ids under an existing key, so a regrouped block is not an arrival", () => {
    const tracker = new TranscriptArrivalTracker();
    tracker.reconcile([block("turn", "e1")]);
    // A live turn absorbs a step under its mounted key: same keys, new id.
    expect(tracker.reconcile([block("turn", "e1", "e2")]).size).toBe(0);
    // The outline later splits that step into its own tail block.
    expect(
      tracker.reconcile([block("turn", "e1"), block("range:e2", "e2")]).size,
    ).toBe(0);
    // A genuinely new step still arrives.
    expect(
      keys(
        tracker.reconcile([
          block("turn", "e1"),
          block("range:e2", "e2"),
          block("range:e3", "e3"),
        ]),
      ),
    ).toEqual(["range:e3"]);
  });

  test("a durable block over its optimistic alias is reconciliation", () => {
    const tracker = new TranscriptArrivalTracker();
    tracker.reconcile([block("older"), block("outbox-p", "outbox-p")]);
    expect(
      tracker.reconcile([
        block("older"),
        {
          key: "range:durable-p",
          entryIds: ["durable-p"],
          arrivalAliases: ["outbox-p"],
        },
      ]).size,
    ).toBe(0);
  });

  test("hydrated slices never animate even at the tail", () => {
    const tracker = new TranscriptArrivalTracker();
    tracker.reconcile([block("a")]);
    expect(
      tracker.reconcile([
        block("a"),
        { key: "range:h", entryIds: ["h"], animateArrival: false },
      ]).size,
    ).toBe(0);
  });

  test("a history prepend never animates and still ingests its ids", () => {
    const tracker = new TranscriptArrivalTracker();
    tracker.reconcile([block("c"), block("d"), block("e")]);
    const prepended = [
      block("a"),
      block("b"),
      block("c"),
      block("d"),
      block("e"),
    ];
    expect(tracker.reconcile(prepended).size).toBe(0);
    // A later tail block carrying a prepended id was already painted.
    expect(tracker.reconcile([...prepended, block("range:a", "a")]).size).toBe(
      0,
    );
  });

  test("a remounted adapter seeds from the current list", () => {
    const list = [block("a"), block("b"), block("c"), block("d")];
    const first = new TranscriptArrivalTracker();
    first.reconcile(list.slice(0, 3));
    expect(keys(first.reconcile(list))).toEqual(["d"]);
    const remounted = new TranscriptArrivalTracker();
    expect(remounted.reconcile(list).size).toBe(0);
  });

  test("only the tail window can arrive", () => {
    const tracker = new TranscriptArrivalTracker();
    tracker.reconcile([block("a"), block("b")]);
    // Blocks inserted deeper than the window are history, not arrivals.
    expect(
      keys(
        tracker.reconcile([
          block("a"),
          block("x"),
          block("b"),
          block("c"),
          block("d"),
          block("e"),
        ]),
      ),
    ).toEqual(["c", "d", "e"]);
  });

  test("the tail slice decides the same keys as the full key list", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 200; round++) {
      const length = Math.floor(random() * 8);
      const all = Array.from(
        { length },
        (_, index) => `k${Math.floor(random() * 6)}-${index % 2}`,
      );
      const previous = new Set(all.filter(() => random() < 0.5));
      expect(
        newTailBlockKeys(previous, all.slice(-TAIL_ARRIVAL_WINDOW)),
      ).toEqual(newTailBlockKeys(previous, all));
    }
  });
});
