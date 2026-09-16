import { useEffect, useState } from "react";
import { createFrameRateMeter } from "../lib/frame-rate";

/** Keep sampling and the once-per-second render isolated from the app shell. */
export function FrontendFpsCounter() {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    const meter = createFrameRateMeter();
    let frame = 0;
    const tick = (at: number) => {
      const next = meter.frame(at);
      if (next !== null) setFps(next);
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      meter.reset();
      setFps(null);
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return (
    <span
      aria-label="Frontend FPS"
      className="inline-flex w-6 shrink-0 flex-col items-center text-meta leading-tight tabular-nums text-dim"
    >
      <span>{fps ?? "–"}</span>
      <span className="text-faint">FPS</span>
    </span>
  );
}
