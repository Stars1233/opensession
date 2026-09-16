import type { ServerWebSocket } from "bun";
import type { IdbSimulator, SimulatorInput } from "./idb";
import { jpegFrames } from "./mjpeg";
import {
  simulatorKeyCodes,
  viewerCommandSchema,
  type ViewerInput,
  type ViewerState,
} from "./protocol";

type ViewerSocket = ServerWebSocket<{
  pending: number;
  ackFrames: boolean;
  awaitingFrameAck: boolean;
  lastSentFrameVersion: number;
}>;

type QueuedInput = {
  ws: ViewerSocket;
  input: SimulatorInput;
  gesture?: Gesture;
  release: boolean;
  counted: boolean;
};

type Gesture = {
  owner: ViewerSocket;
  lastX: number;
  lastY: number;
  downRunning: boolean;
  downDelivered: boolean;
  releaseRequested: boolean;
  releaseQueued: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
};

export function simulatorInput(
  input: ViewerInput,
  dimensions: { width: number; height: number },
): SimulatorInput {
  const x = (value: number) =>
    Math.min(
      dimensions.width - 1,
      Math.max(0, Math.round(value * dimensions.width)),
    );
  const y = (value: number) =>
    Math.min(
      dimensions.height - 1,
      Math.max(0, Math.round(value * dimensions.height)),
    );
  switch (input.type) {
    case "touch":
      return {
        kind: "touch",
        phase: input.phase,
        x: x(input.x),
        y: y(input.y),
      };
    case "tap":
      return { kind: "tap", x: x(input.x), y: y(input.y) };
    case "swipe":
      return {
        kind: "swipe",
        x: x(input.x),
        y: y(input.y),
        endX: x(input.endX),
        endY: y(input.endY),
        duration: input.duration,
      };
    case "text":
      return { kind: "text", text: input.text };
    case "home":
      return { kind: "button", button: "HOME" };
    case "key":
      return { kind: "key", key: simulatorKeyCodes[input.key] };
  }
}

/** The Portal proxy supplies authentication. The helper binds only loopback,
 * accepts only its Portal origin, and gates WebSockets with a same-origin token. */
export function startSimulatorViewer(options: {
  port: number;
  origin: string;
  assets: ReadonlyMap<string, Blob>;
  openSimulator: () => Promise<IdbSimulator>;
  /** Testable idle deadline. Production closes a device after ten minutes without a viewer. */
  idleMs?: number;
  /** A lost pointer-up cannot hold touch ownership indefinitely. */
  gestureIdleMs?: number;
}) {
  const origin = new URL(options.origin).origin;
  const token = crypto.randomUUID();
  const sockets = new Set<ViewerSocket>();
  let state: ViewerState = { phase: "starting" };
  let simulator: IdbSimulator | undefined;
  let closing = false;
  let lastFrame: Uint8Array | undefined;
  let lastFrameVersion = 0;
  let stopVideo: (() => Promise<void>) | undefined;
  let videoTransition = Promise.resolve();
  const inputQueue: QueuedInput[] = [];
  let inputDrain: Promise<void> | undefined;
  let pending = 0;
  const gestures: Gesture[] = [];
  let deviceClose: Promise<void> | undefined;
  function closeDevice(): Promise<void> {
    return simulator ? (deviceClose ??= simulator.close()) : Promise.resolve();
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function armIdle() {
    clearTimeout(idleTimer);
    if (!closing && sockets.size === 0)
      idleTimer = setTimeout(
        () => {
          void stop().catch((error) =>
            console.error("Simulator cleanup failed", error),
          );
        },
        options.idleMs ?? 10 * 60_000,
      );
  }

  function send(ws: ViewerSocket, value: unknown) {
    if (ws.readyState === 1) ws.send(JSON.stringify(value));
  }
  function sendFrame(ws: ViewerSocket) {
    if (!lastFrame || ws.readyState !== 1) return;
    if (ws.data.ackFrames) {
      if (
        ws.data.awaitingFrameAck ||
        ws.data.lastSentFrameVersion >= lastFrameVersion
      )
        return;
      ws.send(lastFrame);
      ws.data.awaitingFrameAck = true;
      ws.data.lastSentFrameVersion = lastFrameVersion;
      return;
    }
    if (ws.getBufferedAmount() < 256 * 1024) ws.send(lastFrame);
  }
  function setState(next: ViewerState) {
    state = next;
    for (const ws of sockets) send(ws, { type: "state", state });
  }
  function fail(error: unknown) {
    setState({
      phase: "error",
      message:
        error instanceof Error ? error.message : "Simulator connection failed",
    });
    syncVideo();
  }
  function syncVideo() {
    videoTransition = videoTransition
      .then(async () => {
        const shouldStream =
          !closing && sockets.size > 0 && state.phase === "ready" && simulator;
        if (!shouldStream) {
          await stopVideo?.();
          stopVideo = undefined;
          lastFrame = undefined;
          if (state.phase === "error") await closeDevice();
          return;
        }
        if (stopVideo) return;
        const frames = jpegFrames((frame) => {
          lastFrame = frame;
          lastFrameVersion++;
          // Ack-capable viewers have at most one frame in flight and receive
          // the newest global frame after acknowledging it. Legacy viewers
          // retain the bounded Bun-buffer behavior.
          for (const ws of sockets) sendFrame(ws);
        });
        stopVideo = await shouldStream.startVideo((chunk) => {
          try {
            frames(chunk);
          } catch (error) {
            fail(error);
          }
        }, fail);
      })
      .catch(async (error) => {
        const message =
          error instanceof Error ? error.message : "Simulator stream failed";
        setState({ phase: "error", message });
        const stop = stopVideo;
        stopVideo = undefined;
        await stop?.().catch(() => {});
        // Do not chain syncVideo from inside its own transition. Release the
        // device here even if viewers remain connected to the error screen.
        await closeDevice().catch((cause) => {
          setState({
            phase: "error",
            message: `${message}. Cleanup failed: ${cause instanceof Error ? cause.message : "restart this Portal"}`,
          });
        });
      });
  }

  function busy(ws: ViewerSocket) {
    send(ws, {
      type: "input-error",
      message: "Simulator is busy. Try again.",
    });
  }

  function finishQueued(command: QueuedInput) {
    if (!command.counted) return;
    command.ws.data.pending--;
    pending--;
  }

  function discardQueued(predicate: (command: QueuedInput) => boolean) {
    for (let index = inputQueue.length - 1; index >= 0; index--) {
      const command = inputQueue[index];
      if (!command || !predicate(command)) continue;
      inputQueue.splice(index, 1);
      finishQueued(command);
    }
  }

  function finishGesture(active: Gesture) {
    const index = gestures.indexOf(active);
    if (index === -1) return;
    clearTimeout(active.idleTimer);
    gestures.splice(index, 1);
    const next = gestures[0];
    if (index === 0 && next && !next.releaseRequested) armGestureIdle(next);
  }

  function enqueueInput(command: QueuedInput) {
    if (command.counted) {
      command.ws.data.pending++;
      pending++;
    }
    inputQueue.push(command);
    drainInputs();
  }

  function enqueueRelease(
    active: Gesture,
    input: SimulatorInput = {
      kind: "touch",
      phase: "up",
      x: active.lastX,
      y: active.lastY,
    },
    counted = false,
  ) {
    if (active.releaseQueued || !gestures.includes(active)) return;
    active.releaseRequested = true;
    active.releaseQueued = true;
    clearTimeout(active.idleTimer);
    enqueueInput({
      ws: active.owner,
      input,
      gesture: active,
      release: true,
      counted,
    });
  }

  function abandonGesture(active: Gesture) {
    if (!gestures.includes(active)) return;
    active.releaseRequested = true;
    clearTimeout(active.idleTimer);
    discardQueued((command) => command.gesture === active && !command.release);
    if (!active.downDelivered && !active.downRunning) {
      discardQueued((command) => command.gesture === active && command.release);
      finishGesture(active);
      return;
    }
    enqueueRelease(active);
  }

  function armGestureIdle(active: Gesture) {
    clearTimeout(active.idleTimer);
    active.idleTimer = setTimeout(() => {
      if (gestures[0] !== active) return;
      send(active.owner, {
        type: "input-error",
        message: "Touch gesture timed out.",
      });
      abandonGesture(active);
    }, options.gestureIdleMs ?? 5_000);
  }

  function drainInputs() {
    if (inputDrain) return;
    inputDrain = (async () => {
      while (inputQueue.length > 0) {
        const command = inputQueue.shift();
        if (!command) continue;
        const active = command.gesture;
        const isDown =
          command.input.kind === "touch" && command.input.phase === "down";
        const isMove =
          command.input.kind === "touch" && command.input.phase === "move";
        if (isDown && active?.owner === command.ws) active.downRunning = true;
        try {
          if (
            !command.release &&
            (closing || state.phase !== "ready" || command.ws.readyState !== 1)
          ) {
            if (isDown && active) finishGesture(active);
            continue;
          }
          const target = simulator;
          if (!target) {
            if (isDown && active) finishGesture(active);
            continue;
          }
          await target.input(command.input);
          if (isDown && active && gestures.includes(active)) {
            active.downDelivered = true;
            if (active.releaseRequested && !active.releaseQueued)
              enqueueRelease(active);
          }
        } catch (error) {
          send(command.ws, {
            type: "input-error",
            message:
              error instanceof Error ? error.message : "Simulator input failed",
          });
          if (command.release) {
            // The native finger may still be down. Fail admission before
            // dropping ownership; device cleanup now owns the final release.
            fail(error);
            discardQueued(() => true);
            for (const gesture of gestures.toReversed()) finishGesture(gesture);
          } else if (isDown && active) {
            // A lost acknowledgement does not prove the finger stayed up.
            // Discard pending movement, but still attempt a matching release.
            discardQueued((queued) => queued.gesture === active);
            active.releaseQueued = false;
            enqueueRelease(active);
          } else if (isMove && active && gestures.includes(active)) {
            abandonGesture(active);
          }
        } finally {
          if (isDown && active) {
            active.downRunning = false;
            if (
              gestures.includes(active) &&
              active.downDelivered &&
              active.releaseRequested &&
              !active.releaseQueued
            )
              enqueueRelease(active);
          }
          if (command.release && active) finishGesture(active);
          finishQueued(command);
        }
      }
    })().finally(() => {
      inputDrain = undefined;
      if (inputQueue.length > 0) drainInputs();
    });
  }

  const server = Bun.serve<ViewerSocket["data"]>({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 60,
    fetch(request, server) {
      const url = new URL(request.url);
      const allowedHost =
        url.host === new URL(origin).host ||
        url.host === `127.0.0.1:${server.port}`;
      if (!allowedHost)
        return new Response("Invalid viewer host", { status: 403 });
      if (request.method !== "GET")
        return new Response("Method not allowed", { status: 405 });
      if (url.pathname === "/socket") {
        if (
          request.headers.get("origin") !== origin ||
          url.searchParams.get("token") !== token
        )
          return new Response("Viewer authorization required", { status: 403 });
        if (sockets.size >= 4 || closing)
          return new Response("Viewer capacity reached", { status: 503 });
        return server.upgrade(request, {
          data: {
            pending: 0,
            ackFrames: url.searchParams.get("frames") === "ack",
            awaitingFrameAck: false,
            lastSentFrameVersion: 0,
          },
        })
          ? undefined
          : new Response("WebSocket required", { status: 400 });
      }
      const headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'",
      };
      if (url.pathname === "/api/bootstrap")
        return Response.json({ token, state }, { headers });
      const file = options.assets.get(url.pathname);
      return file
        ? new Response(file, { headers })
        : new Response("Not found", { status: 404, headers });
    },
    websocket: {
      maxPayloadLength: 8_192,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        clearTimeout(idleTimer);
        if (closing || sockets.size >= 4) {
          ws.close(1013, "Viewer capacity reached");
          return;
        }
        sockets.add(ws);
        send(ws, { type: "state", state });
        sendFrame(ws);
        syncVideo();
      },
      message(ws, message) {
        if (typeof message !== "string")
          return ws.close(1003, "Text commands only");
        let json: unknown;
        try {
          json = JSON.parse(message);
        } catch {
          return ws.close(1008, "Invalid command");
        }
        const parsed = viewerCommandSchema.safeParse(json);
        if (!parsed.success) return ws.close(1008, "Invalid command");
        if (parsed.data.type === "frame-ack") {
          if (!ws.data.ackFrames)
            return ws.close(1008, "Frame acknowledgements not enabled");
          ws.data.awaitingFrameAck = false;
          sendFrame(ws);
          return;
        }
        const target = simulator;
        if (!target || state.phase !== "ready" || closing)
          return send(ws, {
            type: "input-error",
            message: "Simulator is not ready",
          });

        const input = parsed.data;
        if (gestures[0] && gestures[0].owner !== ws)
          return send(ws, {
            type: "input-error",
            message: "Another viewer is controlling the simulator.",
          });

        if (input.type === "touch") {
          const mapped = simulatorInput(input, target.dimensions);
          if (mapped.kind !== "touch") return;
          if (input.phase === "down") {
            const previous = gestures.at(-1);
            if (previous && !previous.releaseRequested)
              return send(ws, {
                type: "input-error",
                message: "A touch gesture is already active.",
              });
            if (ws.data.pending >= 4 || pending >= 16) return busy(ws);
            const active: Gesture = {
              owner: ws,
              lastX: mapped.x,
              lastY: mapped.y,
              downRunning: false,
              downDelivered: false,
              releaseRequested: false,
              releaseQueued: false,
            };
            gestures.push(active);
            if (gestures[0] === active) armGestureIdle(active);
            enqueueInput({
              ws,
              input: mapped,
              gesture: active,
              release: false,
              counted: true,
            });
            return;
          }
          const active = gestures.at(-1);
          if (!active || active.owner !== ws || active.releaseRequested)
            return send(ws, {
              type: "input-error",
              message: "No active touch gesture.",
            });
          active.lastX = mapped.x;
          active.lastY = mapped.y;
          if (gestures[0] === active) armGestureIdle(active);
          if (input.phase === "up") {
            enqueueRelease(active, mapped, true);
            return;
          }
          const queuedMove = inputQueue.findLast(
            (command) =>
              command.gesture === active &&
              command.input.kind === "touch" &&
              command.input.phase === "move",
          );
          if (queuedMove) {
            queuedMove.input = mapped;
            return;
          }
          if (ws.data.pending >= 4 || pending >= 16) return busy(ws);
          enqueueInput({
            ws,
            input: mapped,
            gesture: active,
            release: false,
            counted: true,
          });
          return;
        }

        if (gestures.some((active) => !active.releaseRequested))
          return send(ws, {
            type: "input-error",
            message: "Finish the touch gesture first.",
          });
        if (ws.data.pending >= 4 || pending >= 16) return busy(ws);
        enqueueInput({
          ws,
          input: simulatorInput(input, target.dimensions),
          release: false,
          counted: true,
        });
      },
      close(ws) {
        sockets.delete(ws);
        for (const active of gestures.toReversed())
          if (active.owner === ws) abandonGesture(active);
        discardQueued((command) => command.ws === ws && !command.release);
        syncVideo();
        armIdle();
      },
    },
  });
  const ready = options
    .openSimulator()
    .then(async (device) => {
      simulator = device;
      if (closing) return;
      setState({
        phase: "ready",
        deviceName: device.deviceName,
        ...device.dimensions,
      });
      syncVideo();
    })
    .catch(fail);
  let stopped: Promise<void> | undefined;
  function stop() {
    return (stopped ??= (async () => {
      closing = true;
      clearTimeout(idleTimer);
      for (const active of gestures.toReversed()) abandonGesture(active);
      for (const ws of sockets) ws.close(1001, "Simulator Portal stopped");
      sockets.clear();
      await server.stop(true);
      await ready;
      syncVideo();
      await videoTransition;
      while (inputDrain) await inputDrain;
      await closeDevice();
    })());
  }
  armIdle();
  return { port: server.port, ready, stop };
}
