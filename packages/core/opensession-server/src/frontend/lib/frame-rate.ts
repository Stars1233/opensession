/** Measures browser animation-frame cadence, not React render counts. The
 * elapsed window includes stalls and supports displays faster than 60 Hz. */
export function createFrameRateMeter() {
  let start: number | null = null;
  let frames = 0;
  return {
    reset() {
      start = null;
      frames = 0;
    },
    frame(at: number): number | null {
      if (start === null || at <= start) {
        start = at;
        frames = 0;
        return null;
      }
      frames++;
      const elapsed = at - start;
      if (elapsed < 1_000) return null;
      const fps = Math.round((frames * 1_000) / elapsed);
      start = at;
      frames = 0;
      return fps;
    },
  };
}
