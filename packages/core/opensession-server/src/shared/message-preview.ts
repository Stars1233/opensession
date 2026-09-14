/** Long messages show this many characters before the expander. 24,000
 * covers every long interactive reply seen in a week of production (none of
 * the 38 assistant messages over 6 KB passed 24 KB) and most automation
 * prompts, at roughly 60ms of markdown parsing per bubble worst case. */
export const MESSAGE_PREVIEW_CHARS = 24_000;
/** Skip the expander when it would hide less than 20% of the message. */
export const MESSAGE_COLLAPSE_CHARS = MESSAGE_PREVIEW_CHARS / 0.8;
