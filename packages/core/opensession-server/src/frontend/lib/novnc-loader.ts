/**
 * Load noVNC on demand, never with the app. Its browser module awaits at its
 * top level, and a static import put that in the app's own module graph,
 * where Bun's dev bundler ran its importers before the await settled and the
 * whole app crashed on boot. As its own async chunk it finishes evaluating
 * before anything reads it, and the app stops paying for a VNC client that
 * only the sandbox desktop uses.
 */
export function loadNoVnc(): Promise<typeof import("@novnc/novnc")> {
  return import("@novnc/novnc");
}
