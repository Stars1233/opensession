/**
 * Whether the router should keep the browser history at a single entry,
 * replacing it on every navigation instead of pushing.
 *
 * The iOS Home Screen web app has no browser chrome, so nothing but the app's
 * own back affordances (the chevron, the edge swipe) ever walks history. What
 * WebKit does keep is its history-navigation gesture: an edge swipe pulls the
 * whole view aside and reveals a snapshot of the previous entry. The app
 * cancels touches at the bezel to keep that gesture from starting, but the
 * cancel is a race against the main thread and misses touches that begin a
 * little inside the edge, and whenever it loses the reader sees a stale page
 * slide in under the pane drag. With one entry there is nothing to swipe back
 * to, so the native gesture never begins.
 *
 * Only `navigator.standalone` qualifies: it is true for the iOS Home Screen
 * app alone. Android installs keep a real stack for the system back button,
 * and browser tabs keep it for the browser's own back controls.
 */
export function keepsSingleHistoryEntry(nav: {
  standalone?: boolean;
}): boolean {
  return nav.standalone === true;
}
