export const SIDEBAR_ITEM_KEY_ATTRIBUTE = "data-sidebar-item-key";

interface SidebarItemElement {
  getAttribute(name: string): string | null;
}

/**
 * Pick the next rendered sidebar item, falling back to the previous item when
 * the current item is last. Repeated copies of the current item are skipped.
 */
export function nextRenderedSidebarItem<T extends SidebarItemElement>(
  items: readonly T[],
  current: T | null,
  currentKey: string,
): T | null {
  let index = current ? items.indexOf(current) : -1;
  if (index < 0) {
    index = items.findIndex(
      (item) => item.getAttribute(SIDEBAR_ITEM_KEY_ATTRIBUTE) === currentKey,
    );
  }
  if (index < 0) return null;

  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i].getAttribute(SIDEBAR_ITEM_KEY_ATTRIBUTE) !== currentKey)
      return items[i];
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i].getAttribute(SIDEBAR_ITEM_KEY_ATTRIBUTE) !== currentKey)
      return items[i];
  }
  return null;
}
