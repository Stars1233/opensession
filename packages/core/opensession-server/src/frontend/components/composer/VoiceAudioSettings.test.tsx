import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceAudioSplitButton } from "./VoiceAudioSettings";

// `os1Shell()` reads `globalThis.window?.os1`. One process runs every test
// file, so whichever ran first may already have installed a window; add to
// it rather than replacing it, and take only our own key back out.
const testWindow = globalThis.window ?? {};
if (!globalThis.window) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: testWindow,
    writable: true,
  });
}
// SAFETY: the stub window is a plain object this file owns; `os1` is the
// only key read through it, and it is removed again after each test.
const shell = testWindow as { os1?: unknown };

function withBridge() {
  shell.os1 = {
    voiceAudio: {
      devices: () =>
        Promise.resolve({ inputs: [], outputs: [], advancedDucking: true }),
    },
  };
}

afterEach(() => {
  delete shell.os1;
});

const primary = (
  <button type="button" aria-label="Dictate">
    mic
  </button>
);

describe("VoiceAudioSplitButton", () => {
  test("hands the control back unchanged without the native bridge", () => {
    expect(
      renderToStaticMarkup(
        <VoiceAudioSplitButton mode="dictation">
          {primary}
        </VoiceAudioSplitButton>,
      ),
    ).toBe(renderToStaticMarkup(primary));
  });

  test("attaches a menu chevron beside the control on the Mac shell", () => {
    withBridge();
    const html = renderToStaticMarkup(
      <VoiceAudioSplitButton mode="dictation">{primary}</VoiceAudioSplitButton>,
    );
    // The primary keeps its own markup and comes first.
    expect(html).toContain('aria-label="Dictate"');
    expect(html.indexOf('aria-label="Dictate"')).toBeLessThan(
      html.indexOf('aria-label="Dictation audio options"'),
    );
    // The chevron is a menu trigger, not a dialog opener.
    expect(html).toMatch(
      /aria-label="Dictation audio options"[^>]*aria-haspopup="menu"|aria-haspopup="menu"[^>]*aria-label="Dictation audio options"/,
    );
    expect(html).not.toContain('aria-haspopup="dialog"');
  });

  test("names the handset's chevron for calls", () => {
    withBridge();
    const html = renderToStaticMarkup(
      <VoiceAudioSplitButton mode="conversation">
        {primary}
      </VoiceAudioSplitButton>,
    );
    expect(html).toContain('aria-label="Call audio options"');
  });

  test("greys the chevron with the primary", () => {
    withBridge();
    const html = renderToStaticMarkup(
      <VoiceAudioSplitButton mode="dictation" disabled>
        {primary}
      </VoiceAudioSplitButton>,
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Dictation audio options"/,
    );
    // The primary is the caller's, so it is not touched.
    expect(html).toContain('<button type="button" aria-label="Dictate">');
  });
});
