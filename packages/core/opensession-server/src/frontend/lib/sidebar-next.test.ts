import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_ITEM_KEY_ATTRIBUTE,
  nextRenderedSidebarItem,
} from "./sidebar-next";

function item(key?: string) {
  return {
    key,
    getAttribute(name: string) {
      return name === SIDEBAR_ITEM_KEY_ATTRIBUTE ? (key ?? null) : null;
    },
  };
}

describe("nextRenderedSidebarItem", () => {
  test("uses rendered order", () => {
    const current = item("workspace:current");
    const next = item("workspace:next");
    const later = item("workspace:later");

    expect(
      nextRenderedSidebarItem(
        [current, next, later],
        current,
        "workspace:current",
      ),
    ).toBe(next);
  });

  test("skips another rendered copy of the archived item", () => {
    const current = item("workspace:current");
    const duplicate = item("workspace:current");
    const next = item("workspace:next");

    expect(
      nextRenderedSidebarItem(
        [current, duplicate, next],
        current,
        "workspace:current",
      ),
    ).toBe(next);
  });

  test("falls back to the previous item at the end", () => {
    const previous = item("workspace:previous");
    const current = item("workspace:current");

    expect(
      nextRenderedSidebarItem(
        [previous, current],
        current,
        "workspace:current",
      ),
    ).toBe(previous);
  });

  test("finds the current item by key when its element is unavailable", () => {
    const current = item("session:current");
    const next = item();

    expect(
      nextRenderedSidebarItem([current, next], null, "session:current"),
    ).toBe(next);
  });
});
