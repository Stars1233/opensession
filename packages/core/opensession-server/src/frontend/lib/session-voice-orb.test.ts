import { describe, expect, test } from "bun:test";
import {
  ORB_ATTACK_MS,
  ORB_FRAGMENT_SHADER,
  ORB_RELEASE_MS,
  clamp01,
  createOrbRenderer,
  drawSessionVoiceOrbFallback,
  followLevel,
  parseCssColor,
  type OrbCanvas,
  type OrbFrame,
  type OrbPaintContext,
} from "./session-voice-orb";

describe("followLevel", () => {
  test("rises faster than it falls", () => {
    const up = followLevel(0, 1, 16);
    const down = 1 - followLevel(1, 0, 16);
    expect(up).toBeGreaterThan(down);
    expect(up).toBeCloseTo(1 - Math.exp(-16 / ORB_ATTACK_MS), 6);
    expect(down).toBeCloseTo(1 - Math.exp(-16 / ORB_RELEASE_MS), 6);
  });

  test("is frame-rate independent: two 8ms steps equal one 16ms step", () => {
    const twice = followLevel(followLevel(0.2, 0.9, 8), 0.9, 8);
    expect(twice).toBeCloseTo(followLevel(0.2, 0.9, 16), 9);
  });

  test("lands on the target after a long gap and snaps the tail to rest", () => {
    expect(followLevel(0.8, 0, 5000)).toBe(0);
    let level = 1;
    for (let i = 0; i < 200; i++) level = followLevel(level, 0, 16);
    expect(level).toBe(0);
  });

  test("clamps garbage and holds still without time", () => {
    expect(followLevel(0.4, Number.NaN, 16)).toBeLessThan(0.4);
    expect(followLevel(0.4, 7, 16)).toBeLessThanOrEqual(1);
    expect(followLevel(0.4, 0.9, 0)).toBe(0.4);
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("parseCssColor", () => {
  test("reads the computed color forms a theme token resolves to", () => {
    expect(parseCssColor("rgb(255, 0, 51)")).toEqual([1, 0, 0.2]);
    expect(parseCssColor("rgba(0, 255, 0, 0.16)")).toEqual([0, 1, 0]);
    expect(parseCssColor("rgb(255 255 0 / 0.5)")).toEqual([1, 1, 0]);
    expect(parseCssColor("color(srgb 0.25 0.5 1)")).toEqual([0.25, 0.5, 1]);
    expect(parseCssColor("color(srgb 0.25 0.5 1 / 0.12)")).toEqual([
      0.25, 0.5, 1,
    ]);
  });

  test("refuses anything that is not a resolved color", () => {
    expect(parseCssColor("var(--text)")).toBeNull();
    expect(parseCssColor("color-mix(in srgb, red 50%, blue)")).toBeNull();
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseCssColor("rgb(1, 2)")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
});

describe("fragment shader", () => {
  test("declares every uniform the renderer uploads", () => {
    for (const name of [
      "u_res",
      "u_time",
      "u_in",
      "u_out",
      "u_active",
      "u_cin",
      "u_cout",
      "u_cdim",
    ]) {
      expect(ORB_FRAGMENT_SHADER).toContain(
        `uniform ${name === "u_res" ? "vec2" : name.startsWith("u_c") ? "vec3" : "float"} ${name};`,
      );
    }
    expect(ORB_FRAGMENT_SHADER).toContain(
      "gl_FragColor = vec4(col * alpha, alpha)",
    );
  });
});

/** A canvas 2D context that records what was painted, and with what. */
function recordingContext() {
  const ops: string[] = [];
  const gradients: Array<{ radius: number; stops: string[] }> = [];
  const strokes: Array<{ style: string; alpha: number }> = [];
  const ctx: OrbPaintContext = {
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    setTransform: () => ops.push("setTransform"),
    clearRect: () => ops.push("clearRect"),
    beginPath: () => ops.push("beginPath"),
    arc: () => ops.push("arc"),
    createRadialGradient(_x0, _y0, _r0, _x1, _y1, r1) {
      const stops: string[] = [];
      gradients.push({ radius: r1, stops });
      return {
        addColorStop: (_offset: number, color: string) => stops.push(color),
      };
    },
    stroke() {
      ops.push("stroke");
      strokes.push({
        style: String(this.strokeStyle),
        alpha: this.globalAlpha,
      });
    },
    fill: () => ops.push("fill"),
  };
  return { ctx, ops, gradients, strokes };
}

const palette = {
  input: { css: "rgb(1, 1, 1)", rgb: [1 / 255, 1 / 255, 1 / 255] as const },
  output: { css: "rgb(2, 2, 2)", rgb: [2 / 255, 2 / 255, 2 / 255] as const },
  dim: { css: "rgb(3, 3, 3)", rgb: [3 / 255, 3 / 255, 3 / 255] as const },
};
const frame = (over: Partial<OrbFrame>): OrbFrame => ({
  size: 48,
  dpr: 2,
  input: 0,
  output: 0,
  active: 1,
  time: 0.5,
  palette,
  ...over,
});

describe("drawSessionVoiceOrbFallback", () => {
  test("resting paints one dim sphere and nothing live", () => {
    const { ops, gradients, strokes, ctx } = recordingContext();
    drawSessionVoiceOrbFallback(ctx, frame({ active: 0, input: 1, output: 1 }));
    expect(ops.filter((op) => op === "fill")).toHaveLength(1);
    expect(strokes).toHaveLength(0);
    expect(gradients).toHaveLength(1);
    expect(
      gradients[0].stops.every((stop) => stop.startsWith("rgba(3, 3, 3")),
    ).toBe(true);
  });

  test("the speaker grows the accent core and leaves the rim alone", () => {
    const quiet = recordingContext();
    drawSessionVoiceOrbFallback(quiet.ctx, frame({}));
    const loud = recordingContext();
    drawSessionVoiceOrbFallback(loud.ctx, frame({ output: 1 }));
    expect(loud.gradients[1].radius).toBeGreaterThan(quiet.gradients[1].radius);
    expect(loud.gradients[1].stops[0]).toStartWith("rgba(2, 2, 2");
    expect(loud.strokes[0].alpha).toBeCloseTo(quiet.strokes[0].alpha, 9);
  });

  test("the microphone firms the ink rim and leaves the core alone", () => {
    const quiet = recordingContext();
    drawSessionVoiceOrbFallback(quiet.ctx, frame({}));
    const loud = recordingContext();
    drawSessionVoiceOrbFallback(loud.ctx, frame({ input: 1 }));
    expect(loud.strokes[0].style).toBe(palette.input.css);
    expect(loud.strokes[0].alpha).toBeGreaterThan(quiet.strokes[0].alpha);
    expect(loud.ctx.lineWidth).toBeGreaterThan(quiet.ctx.lineWidth);
    // The whole orb swells with the mic; the core keeps its share of it.
    const share = (run: typeof quiet) =>
      run.gradients[1].radius / run.gradients[0].radius;
    expect(share(loud)).toBeCloseTo(share(quiet), 9);
  });

  test("resets alpha and skips painting an unmeasured canvas", () => {
    const { ctx } = recordingContext();
    drawSessionVoiceOrbFallback(ctx, frame({ input: 1, output: 1 }));
    expect(ctx.globalAlpha).toBe(1);
    const empty = recordingContext();
    drawSessionVoiceOrbFallback(empty.ctx, frame({ size: 0 }));
    expect(empty.ops).toEqual(["setTransform", "clearRect"]);
  });
});

describe("createOrbRenderer", () => {
  /** A canvas whose own contexts are never consulted; the probe decides. */
  const canvas: OrbCanvas = {
    width: 96,
    height: 96,
    getContext: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  test("falls back to the 2D painter when WebGL is unavailable", () => {
    const { ctx, ops } = recordingContext();
    const renderer = createOrbRenderer(canvas, {
      webgl: () => null,
      canvas2d: () => ctx,
    });
    expect(renderer?.kind).toBe("canvas2d");
    renderer?.draw(frame({}));
    expect(ops).toContain("fill");
    renderer?.dispose();
  });

  test("returns nothing when no context can be had", () => {
    expect(
      createOrbRenderer(canvas, { webgl: () => null, canvas2d: () => null }),
    ).toBeNull();
  });
});
