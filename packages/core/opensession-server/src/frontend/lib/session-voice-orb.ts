/**
 * The session voice orb: a small luminous sphere whose surface and light react
 * to the two directions of a call. The microphone deforms and lights the rim,
 * the speaker brightens and swells the core. Both read real levels the
 * parent's WebAudio analysis writes into a shared ref every frame; at silence
 * the orb drifts slowly and does nothing that could be mistaken for speech.
 *
 * Rendering is one fragment shader on a low-power WebGL context, drawn into a
 * 40 to 64px canvas at device pixels. When WebGL is unavailable a restrained
 * Canvas 2D painter draws the same three layers (body, core, rim) without the
 * procedural surface. Everything that is not React lives here; the component
 * only mounts the canvas and hands it to `startSessionVoiceOrb`.
 */

/** Normalized 0..1 energy for each direction of the call. */
export interface SessionVoiceOrbLevels {
  /** Microphone energy: what the person is saying. */
  input: number;
  /** Speaker energy: what the call is saying back. */
  output: number;
}

/**
 * The ref the parent updates from its analyser and the orb reads every frame.
 * Structural on purpose so a `useRef<SessionVoiceOrbLevels>()` result fits
 * without a cast, whatever React calls its ref type this year.
 */
export interface SessionVoiceOrbLevelsRef {
  current: SessionVoiceOrbLevels;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Fast attack so a syllable lands on the frame it starts. */
export const ORB_ATTACK_MS = 45;
/** Slower release so the surface settles instead of flickering. */
export const ORB_RELEASE_MS = 190;
/** The live/resting crossfade: a pause fades the orb down rather than snapping. */
export const ORB_ACTIVE_ATTACK_MS = 160;
export const ORB_ACTIVE_RELEASE_MS = 320;

/**
 * Move `current` toward `target` with an asymmetric, frame-rate independent
 * exponential follower: rises at `attackMs`, falls at `releaseMs`. `dtMs` is
 * the time since the previous frame; a tab that was hidden hands in a large dt
 * and simply lands on the target.
 */
export function followLevel(
  current: number,
  target: number,
  dtMs: number,
  attackMs = ORB_ATTACK_MS,
  releaseMs = ORB_RELEASE_MS,
): number {
  const goal = clamp01(target);
  const from = clamp01(current);
  if (!(dtMs > 0)) return from;
  const tau = goal > from ? attackMs : releaseMs;
  const k = 1 - Math.exp(-dtMs / tau);
  const next = from + (goal - from) * k;
  // Snap the tail so a decaying orb reaches rest and the loop can stop.
  return Math.abs(next - goal) < 0.001 ? goal : next;
}

/** Below this both smoothed levels count as silent. */
export const ORB_SILENT = 0.004;

/** Linear sRGB-ish 0..1 triple, what the shader and the fallback gradients eat. */
export type OrbRgb = readonly [number, number, number];

export interface OrbColor {
  /** The resolved CSS color, for Canvas 2D strokes. */
  css: string;
  rgb: OrbRgb;
}

export interface OrbPalette {
  /** Microphone: the rim light. Foreground ink. */
  input: OrbColor;
  /** Speaker: the core and the fluid body. The accent. */
  output: OrbColor;
  /** The resting sphere. */
  dim: OrbColor;
}

const ORB_PALETTE_TOKENS: Record<keyof OrbPalette, string> = {
  input: "--text",
  output: "--accent",
  dim: "--text-dim",
};

/**
 * Parse a computed CSS color into 0..1 components. Computed styles come back
 * as `rgb(...)`, `rgba(...)`, or, for a `color-mix()` token, `color(srgb ...)`;
 * anything else (which a computed value should never be) parses to null.
 */
export function parseCssColor(value: string): OrbRgb | null {
  const match = /^(rgba?|color)\(\s*(srgb\s+)?([^)]*)\)$/i.exec(value.trim());
  if (!match) return null;
  const [, fn, space, body] = match;
  if (fn.toLowerCase() === "color" && !space) return null;
  const parts = body
    .split(/[\s,/]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const scale = space ? 1 : 1 / 255;
  return [
    clamp01(parts[0] * scale),
    clamp01(parts[1] * scale),
    clamp01(parts[2] * scale),
  ];
}

/**
 * Read a color the browser can compute but `parseCssColor` cannot read, by
 * painting it into a one-pixel 2D canvas. Null when the color is invalid or
 * fully transparent, or when no 2D canvas is available.
 */
export function probeCanvasColor(doc: Document, css: string): OrbRgb | null {
  const canvas = doc.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (!a) return null;
  return [r / 255, g / 255, b / 255];
}

/**
 * Resolve theme tokens to concrete colors through a probe element.
 * `getPropertyValue` would hand back the token stream (`var(--text)`, a
 * `color-mix(...)`) rather than a color; the computed `color` of an element
 * painted with it is always resolved. A token that resolves to no usable
 * color reads as null; the orb never invents ink of its own.
 */
export function readThemeColors(
  tokens: readonly string[],
  root: HTMLElement = document.documentElement,
): Array<OrbColor | null> {
  const doc = root.ownerDocument;
  const probe = doc.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;width:0;height:0";
  root.appendChild(probe);
  try {
    return tokens.map((token) => {
      probe.style.color = `var(${token})`;
      const css = getComputedStyle(probe).color;
      const rgb = parseCssColor(css) ?? probeCanvasColor(doc, css);
      return rgb ? { css, rgb } : null;
    });
  } finally {
    probe.remove();
  }
}

/** The theme's three inks, or null when they cannot be resolved here. */
export function resolveOrbPalette(root?: HTMLElement): OrbPalette | null {
  const [input, output, dim] = readThemeColors(
    [
      ORB_PALETTE_TOKENS.input,
      ORB_PALETTE_TOKENS.output,
      ORB_PALETTE_TOKENS.dim,
    ],
    root,
  );
  return input && output && dim ? { input, output, dim } : null;
}

/** Everything a frame needs, derived once per frame from the smoothed levels. */
export interface OrbFrame {
  /** Canvas size in CSS pixels (the orb is square). */
  size: number;
  /** Device pixel ratio the backing store was allocated at. */
  dpr: number;
  input: number;
  output: number;
  /** 0 resting .. 1 live, smoothed, so a pause fades the orb down. */
  active: number;
  /** Procedural phase in seconds. Held still under reduced motion. */
  time: number;
  palette: OrbPalette;
}

export interface OrbRenderer {
  readonly kind: "webgl" | "canvas2d";
  draw(frame: OrbFrame): void;
  dispose(): void;
}

const VERTEX_SHADER = `attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

/**
 * The orb, in one pass. Coordinates are -1..1 across the canvas; the resting
 * sphere sits at radius 0.68, leaving headroom for the swell and halo.
 *
 * Layers, each with its own alpha so the same shader reads as a luminous body
 * on a dark theme and a solid ink one on a light theme:
 *   resting sphere  dim ink, lit from the upper left, with a fresnel edge
 *   fluid body      accent, a drifting value-noise field, brighter with output
 *   core            accent, a gaussian that grows and brightens with output
 *   rim             ink, fresnel and a thin edge line that sharpen with input
 *   halo            outside the surface, breathes with input and output
 * `u_active` fades every live layer so a pause settles to the resting sphere.
 */
export const ORB_FRAGMENT_SHADER = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform float u_in;
uniform float u_out;
uniform float u_active;
uniform vec3 u_cin;
uniform vec3 u_cout;
uniform vec3 u_cdim;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    v += amp * vnoise(p);
    p = p * 2.1 + vec2(3.7, 1.3);
    amp *= 0.5;
  }
  return v;
}

void main() {
  float px = 2.0 / min(u_res.x, u_res.y);
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) * px;
  float r = length(uv);
  float ang = atan(uv.y, uv.x);
  vec2 ring = vec2(cos(ang), sin(ang));
  float t = u_time;
  float act = u_active;

  // Surface: slow organic drift, lifted and sharpened by the microphone.
  float surf = fbm(ring * (1.4 + 1.2 * u_in) + vec2(t * 0.35, -t * 0.27)) - 0.44;
  float ripple = sin(ang * 6.0 - t * 5.0) * 0.5 + sin(ang * 4.0 + t * 3.3) * 0.5;
  float rad = 0.68 + act * (0.05 * surf * (0.7 + 1.6 * u_in) + 0.03 * ripple * u_in
    + 0.08 * u_in + 0.04 * u_out + 0.012 * sin(t * 1.1));
  float d = r - rad;
  float inner = 1.0 - smoothstep(-px, px, d);

  // Sphere shading for the resting body, plus a fresnel edge.
  float q = clamp(r / rad, 0.0, 1.0);
  float h = sqrt(1.0 - q * q);
  vec3 n = normalize(vec3(uv, h * rad));
  vec3 light = normalize(vec3(-0.45, 0.65, 0.6));
  float lit = 0.5 + 0.5 * dot(n, light);
  float fres = pow(1.0 - h, 2.2);
  float spec = pow(max(dot(n, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 28.0);

  // Interior: a fluid drift in the accent, brightening with the speaker.
  float flow = fbm(uv * (2.4 + 1.5 * u_out) + vec2(t * 0.22, t * 0.18) + surf * 0.6);
  float core = exp(-r * r / (0.05 + 0.18 * u_out)) * (0.2 + 0.55 * u_out) * (0.7 + 0.5 * flow);

  // Resting sphere: shaded glass in the dim ink with a glint in the foreground.
  vec3 col = u_cdim;
  float alpha = inner * (0.08 + 0.26 * lit + 0.22 * fres);
  col = mix(col, u_cin, spec * 0.5);
  alpha += inner * spec * 0.22;

  float fluidA = act * inner * (0.10 + 0.32 * flow) * (0.6 + 0.4 * u_out) * (0.7 + 0.3 * lit);
  col = mix(col, u_cout, clamp(fluidA * 3.0, 0.0, 1.0));
  alpha += fluidA;

  float coreA = act * inner * core;
  col = mix(col, u_cout, coreA);
  alpha += coreA;

  float edge = 1.0 - smoothstep(0.0, px * 2.0 + 0.03 * u_in, abs(d));
  float rimA = act * inner * (fres * (0.2 + 0.7 * u_in) + edge * (0.1 + 0.55 * u_in));
  col = mix(col, u_cin, clamp(rimA * 1.6, 0.0, 1.0));
  alpha += rimA;

  float halo = exp(-max(d, 0.0) * (12.0 - 5.0 * u_in)) * (1.0 - inner) * act
    * (0.05 + 0.4 * u_in + 0.15 * u_out);
  col = mix(col, mix(u_cout, u_cin, u_in), halo);
  alpha += halo;

  alpha = clamp(alpha, 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const GL_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: "low-power",
};

/** A compiled program and its uniform locations; rebuilt after a context loss. */
interface OrbProgram {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  res: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  input: WebGLUniformLocation | null;
  output: WebGLUniformLocation | null;
  active: WebGLUniformLocation | null;
  cin: WebGLUniformLocation | null;
  cout: WebGLUniformLocation | null;
  cdim: WebGLUniformLocation | null;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (
    !gl.getShaderParameter(shader, gl.COMPILE_STATUS) &&
    !gl.isContextLost()
  ) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function buildOrbProgram(gl: WebGLRenderingContext): OrbProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, ORB_FRAGMENT_SHADER);
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  if (!vertex || !fragment || !program || !buffer) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // The shaders are owned by the program once linked; drop our handles.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    gl.deleteProgram(program);
    gl.deleteBuffer(buffer);
    return null;
  }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // One triangle that covers clip space; the fragment shader does the rest.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const pos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
  const u = (name: string) => gl.getUniformLocation(program, name);
  return {
    program,
    buffer,
    res: u("u_res"),
    time: u("u_time"),
    input: u("u_in"),
    output: u("u_out"),
    active: u("u_active"),
    cin: u("u_cin"),
    cout: u("u_cout"),
    cdim: u("u_cdim"),
  };
}

/** What the renderers need from a canvas; a test can stub just this. */
export type OrbCanvas = Pick<
  HTMLCanvasElement,
  "width" | "height" | "getContext" | "addEventListener" | "removeEventListener"
>;

/** How a renderer obtains its context; injectable so tests can withhold WebGL. */
export interface OrbContexts {
  webgl(canvas: OrbCanvas): WebGLRenderingContext | null;
  canvas2d(canvas: OrbCanvas): OrbPaintContext | null;
}

export const browserOrbContexts: OrbContexts = {
  webgl: (canvas) => canvas.getContext("webgl", GL_ATTRIBUTES),
  canvas2d: (canvas) => canvas.getContext("2d"),
};

function createWebglOrbRenderer(
  canvas: OrbCanvas,
  contexts: OrbContexts,
): OrbRenderer | null {
  const gl = contexts.webgl(canvas);
  if (!gl) return null;
  let program = buildOrbProgram(gl);
  if (!program) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  }
  const onLost = (event: Event) => {
    // Without preventDefault the browser never fires the restore event.
    event.preventDefault();
    program = null;
  };
  const onRestored = () => {
    program = buildOrbProgram(gl);
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return {
    kind: "webgl",
    draw(frame) {
      if (!program || gl.isContextLost()) return;
      const w = canvas.width;
      const h = canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (frame.size <= 0) return;
      gl.uniform2f(program.res, w, h);
      gl.uniform1f(program.time, frame.time);
      gl.uniform1f(program.input, clamp01(frame.input));
      gl.uniform1f(program.output, clamp01(frame.output));
      gl.uniform1f(program.active, clamp01(frame.active));
      const { input, output, dim } = frame.palette;
      gl.uniform3f(program.cin, input.rgb[0], input.rgb[1], input.rgb[2]);
      gl.uniform3f(program.cout, output.rgb[0], output.rgb[1], output.rgb[2]);
      gl.uniform3f(program.cdim, dim.rgb[0], dim.rgb[1], dim.rgb[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (program && !gl.isContextLost()) {
        gl.deleteBuffer(program.buffer);
        gl.deleteProgram(program.program);
      }
      program = null;
      // Keep the canvas context reusable: React restarts the renderer when
      // active changes for pause/resume. The owner releases the context once
      // the canvas itself leaves the document.
    },
  };
}

/** The slice of a 2D context the fallback paints with; a test can stub just this. */
export type OrbPaintContext = Pick<
  CanvasRenderingContext2D,
  | "globalAlpha"
  | "strokeStyle"
  | "fillStyle"
  | "lineWidth"
  | "setTransform"
  | "clearRect"
  | "beginPath"
  | "arc"
  | "stroke"
  | "fill"
  | "createRadialGradient"
>;

const TAU = Math.PI * 2;

function rgba([r, g, b]: OrbRgb, alpha: number): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/**
 * The Canvas 2D fallback: the same three layers as the shader, without the
 * procedural surface. A lit resting sphere in the dim ink, an accent core that
 * grows with the speaker, and a rim in the foreground ink that firms up with
 * the microphone. Nothing here moves on its own.
 */
export function drawSessionVoiceOrbFallback(
  ctx: OrbPaintContext,
  frame: OrbFrame,
): void {
  const { size, dpr, palette } = frame;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (size <= 0) return;
  const act = clamp01(frame.active);
  const input = clamp01(frame.input);
  const output = clamp01(frame.output);
  const c = size / 2;
  const rad = size * 0.34 * (1 + act * (0.1 * input + 0.05 * output));

  const body = ctx.createRadialGradient(
    c - rad * 0.35,
    c - rad * 0.4,
    rad * 0.1,
    c,
    c,
    rad,
  );
  body.addColorStop(0, rgba(palette.dim.rgb, 0.36));
  body.addColorStop(1, rgba(palette.dim.rgb, 0.16));
  ctx.globalAlpha = 1;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(c, c, rad, 0, TAU);
  ctx.fill();

  if (act > 0) {
    const core = ctx.createRadialGradient(
      c,
      c,
      0,
      c,
      c,
      rad * (0.45 + 0.55 * output),
    );
    core.addColorStop(0, rgba(palette.output.rgb, 0.9));
    core.addColorStop(1, rgba(palette.output.rgb, 0));
    ctx.globalAlpha = act * (0.45 + 0.55 * output);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(c, c, rad, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = act * (0.22 + 0.78 * input);
    ctx.strokeStyle = palette.input.css;
    ctx.lineWidth = Math.max(1, size * 0.02 * (1 + input));
    ctx.beginPath();
    ctx.arc(c, c, rad, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function createCanvas2dOrbRenderer(
  canvas: OrbCanvas,
  contexts: OrbContexts,
): OrbRenderer | null {
  const ctx = contexts.canvas2d(canvas);
  if (!ctx) return null;
  return {
    kind: "canvas2d",
    draw: (frame) => drawSessionVoiceOrbFallback(ctx, frame),
    dispose: () => {},
  };
}

/** WebGL when the browser offers it, the 2D painter otherwise. */
export function createOrbRenderer(
  canvas: OrbCanvas,
  contexts: OrbContexts = browserOrbContexts,
): OrbRenderer | null {
  return (
    createWebglOrbRenderer(canvas, contexts) ??
    createCanvas2dOrbRenderer(canvas, contexts)
  );
}

export interface SessionVoiceOrbOptions {
  active: boolean;
}

/** Cap so a 3x phone display does not allocate a 4x backing store for a 48px orb. */
const MAX_DPR = 3;
const REST: SessionVoiceOrbLevels = { input: 0, output: 0 };

/**
 * Own the canvas: pick a renderer, size the backing store to the element at
 * device pixels, resolve the theme palette (and again when the theme
 * attributes change), follow `prefers-reduced-motion`, and run a bounded
 * requestAnimationFrame loop that pauses while the document is hidden and
 * stops once the orb is inactive and has faded to rest. Returns the teardown.
 */
export function startSessionVoiceOrb(
  canvas: HTMLCanvasElement,
  levels: SessionVoiceOrbLevelsRef,
  options: SessionVoiceOrbOptions,
): () => void {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView ?? window;
  // No resolvable theme ink means nothing to paint with; stay dark rather
  // than guess a color.
  const initialPalette = resolveOrbPalette(doc.documentElement);
  if (!initialPalette) return () => {};
  const renderer = createOrbRenderer(canvas);
  if (!renderer) return () => {};
  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)");

  let palette = initialPalette;
  let reducedMotion = reduced.matches;
  let size = 0;
  let dpr = 0;
  let input = 0;
  let output = 0;
  let activeMix = 0;
  let phase = 0;
  let frameId = 0;
  let lastTick = 0;
  let stopped = false;

  const fitBackingStore = () => {
    const rect = canvas.getBoundingClientRect();
    const cssSize = Math.max(0, Math.min(rect.width, rect.height));
    const nextDpr = Math.min(MAX_DPR, Math.max(1, win.devicePixelRatio || 1));
    if (cssSize === size && nextDpr === dpr) return;
    size = cssSize;
    dpr = nextDpr;
    const px = Math.max(1, Math.round(cssSize * dpr));
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
  };

  const settled = () =>
    !options.active &&
    activeMix === 0 &&
    input <= ORB_SILENT &&
    output <= ORB_SILENT;

  const tick = (now: number) => {
    frameId = 0;
    if (stopped) return;
    const dt = lastTick ? Math.min(now - lastTick, 250) : 16;
    lastTick = now;
    const target = options.active ? levels.current : REST;
    input = followLevel(input, target.input, dt);
    output = followLevel(output, target.output, dt);
    activeMix = followLevel(
      activeMix,
      options.active ? 1 : 0,
      dt,
      ORB_ACTIVE_ATTACK_MS,
      ORB_ACTIVE_RELEASE_MS,
    );
    // The surface drifts slowly at silence and flows faster with energy.
    // Reduced motion holds the phase, so only the levels move the orb.
    if (!reducedMotion)
      phase += (dt / 1000) * (0.4 + 1.6 * Math.max(input, output));
    fitBackingStore();
    renderer.draw({
      size,
      dpr,
      input,
      output,
      active: activeMix,
      time: phase,
      palette,
    });
    // Keep going while there is anything to show or decay; a still, resting
    // orb costs nothing until something wakes it.
    if (!settled()) schedule();
  };

  const schedule = () => {
    if (stopped || frameId || doc.visibilityState === "hidden") return;
    frameId = win.requestAnimationFrame(tick);
  };

  const wake = () => {
    lastTick = 0;
    schedule();
  };

  const onVisibility = () => {
    if (doc.visibilityState === "hidden") {
      if (frameId) win.cancelAnimationFrame(frameId);
      frameId = 0;
    } else {
      wake();
    }
  };
  const onReducedMotion = (event: MediaQueryListEvent) => {
    reducedMotion = event.matches;
    wake();
  };

  const resize =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          fitBackingStore();
          wake();
        });
  resize?.observe(canvas);

  const theme =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          palette = resolveOrbPalette(doc.documentElement) ?? palette;
          wake();
        });
  theme?.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-accent", "class", "style"],
  });

  doc.addEventListener("visibilitychange", onVisibility);
  reduced.addEventListener("change", onReducedMotion);
  wake();

  return () => {
    stopped = true;
    if (frameId) win.cancelAnimationFrame(frameId);
    frameId = 0;
    resize?.disconnect();
    theme?.disconnect();
    doc.removeEventListener("visibilitychange", onVisibility);
    reduced.removeEventListener("change", onReducedMotion);
    renderer.dispose();
    if (!canvas.isConnected && renderer.kind === "webgl")
      canvas
        .getContext("webgl")
        ?.getExtension("WEBGL_lose_context")
        ?.loseContext();
  };
}
