/**
 * The note a fence gets when its renderer will not load.
 *
 * The heavy renderers (mermaid, vega, the artifact frame, the slides deck)
 * are content-hashed chunks a fence `import()`s on first use. A tab opened
 * before a frontend promotion still asks for the chunk names its own bundle
 * was built with, and once the server has retired that release the import
 * rejects. The fence used to stay plain code with no word about why, which
 * reads as a diagram that does not parse rather than a page that is behind.
 * This says which, under the fence, with the refresh that fixes it, and asks
 * the version poll to look now so the app's own update nudge (UpdatePill)
 * shows at the same moment instead of on its next tick.
 *
 * Built as DOM for the same reason the blocks are: the body is an innerHTML
 * string, so there is no element for React to own. The fence itself is left
 * where it is for shiki, the way any declined upgrade leaves it.
 */

import type { FenceUpgradeContext } from "./fence-upgraders";
import { recheckFrontendVersion } from "./frontend-version";

const NOTE_CLASS = "md-fence-stale";
/** The copy control's wrapper (lib/code-copy.ts), around a fence whose
 *  block keeps its controls. Named here so the note lands under the whole
 *  block rather than between the code and its buttons. */
const CODE_WRAP_SELECTOR = ".md-code-wrap";

/**
 * Put the note under `pre`. The upgrader then returns false as for any
 * declined upgrade; the fence is untouched. Safe to call from a superseded
 * pass: it checks `alive` itself.
 *
 * `renderer` names what did not arrive, capitalised as the sentence's
 * subject: "The diagram renderer".
 */
export function noteFenceLoadFailure(
  { pre, root, alive }: Pick<FenceUpgradeContext, "pre" | "root" | "alive">,
  renderer: string,
): void {
  if (!alive() || !root.contains(pre)) return;
  const block = pre.closest(CODE_WRAP_SELECTOR) ?? pre;
  // A theme flip resets the body and runs the pass again; a second pass over
  // an un-reset body must not stack a second note.
  if (block.nextElementSibling?.classList.contains(NOTE_CLASS)) return;
  const note = document.createElement("div");
  note.className = NOTE_CLASS;
  note.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = `${renderer} didn't load. Refresh to update.`;
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = `${NOTE_CLASS}-refresh`;
  refresh.textContent = "Refresh";
  refresh.addEventListener("click", () => location.reload());
  note.append(text, refresh);
  block.after(note);
  void recheckFrontendVersion();
}
