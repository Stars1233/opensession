import { describe, expect, test } from "bun:test";
import {
  applyDiffDefaults,
  applyViewedCollapse,
  EMPTY_DIFF_EXPANSION,
  pickDiffScrollAnchor,
  rememberDiffExpansion,
  rememberedDiffExpansion,
  setDiffFileOpen,
} from "./diff-expansion";

const file = (name: string, lines = 10) => ({ name, lines });

describe("diff expansion", () => {
  test("opens leading files once and keeps a reader's collapse across refreshes", () => {
    const first = applyDiffDefaults(
      EMPTY_DIFF_EXPANSION,
      [file("a.ts"), file("b.ts"), file("c.ts")],
      2,
    );
    expect([...first.open]).toEqual(["a.ts", "b.ts"]);

    const collapsed = setDiffFileOpen(first, "a.ts", false);
    // A polled patch reorders the files and adds one at the top.
    const refreshed = applyDiffDefaults(
      collapsed,
      [file("new.ts"), file("b.ts"), file("a.ts"), file("c.ts")],
      2,
    );
    expect(refreshed.open.has("a.ts")).toBe(false);
    expect(refreshed.open.has("b.ts")).toBe(true);
    expect(refreshed.open.has("new.ts")).toBe(true);
    expect(refreshed.open.has("c.ts")).toBe(false);
  });

  test("returns the same state when nothing is new", () => {
    const state = applyDiffDefaults(EMPTY_DIFF_EXPANSION, [file("a.ts")], 5);
    expect(applyDiffDefaults(state, [file("a.ts")], 5)).toBe(state);
  });

  test("collapses viewed files only once", () => {
    const state = applyDiffDefaults(
      EMPTY_DIFF_EXPANSION,
      [file("a.ts"), file("b.ts")],
      2,
    );
    const viewed = new Set(["a.ts"]);
    const collapsed = applyViewedCollapse(
      state,
      [file("a.ts"), file("b.ts")],
      viewed,
    );
    expect([...collapsed.open]).toEqual(["b.ts"]);
    const reopened = setDiffFileOpen(collapsed, "a.ts", true);
    expect(
      applyViewedCollapse(reopened, [file("a.ts"), file("b.ts")], viewed),
    ).toBe(reopened);
  });

  test("remembers state per key", () => {
    const state = setDiffFileOpen(EMPTY_DIFF_EXPANSION, "a.ts", true);
    rememberDiffExpansion("session\0repo", state);
    expect(rememberedDiffExpansion("session\0repo")).toBe(state);
    expect(rememberedDiffExpansion("other")).toBe(EMPTY_DIFF_EXPANSION);
    expect(rememberedDiffExpansion(undefined)).toBe(EMPTY_DIFF_EXPANSION);
  });

  test("anchors scroll to the file at the top edge", () => {
    const rows = [
      { path: "a.ts", top: -900 },
      { path: "b.ts", top: -120 },
      { path: "c.ts", top: 300 },
    ];
    expect(pickDiffScrollAnchor(rows, 50)).toEqual({
      path: "b.ts",
      offset: -170,
    });
    // Above the first file, keep the first as the anchor.
    expect(pickDiffScrollAnchor([{ path: "a.ts", top: 200 }], 50)).toEqual({
      path: "a.ts",
      offset: 150,
    });
    expect(pickDiffScrollAnchor([], 0)).toBeNull();
  });
});
