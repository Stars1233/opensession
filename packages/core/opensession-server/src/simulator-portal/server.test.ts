import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { startSimulatorViewer, simulatorInput } from "./server";
import type { IdbSimulator, SimulatorInput } from "./idb";
import { jpegFrames } from "./mjpeg";
import { viewerInputSchema } from "./protocol";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await Bun.sleep(5);
  }
}

function fixture(
  overrides: Partial<IdbSimulator> = {},
  idleMs?: number,
  gestureIdleMs?: number,
) {
  const inputs: SimulatorInput[] = [];
  let starts = 0;
  let stops = 0;
  let closed = 0;
  let emit: (chunk: Uint8Array) => void = () => {};
  const device: IdbSimulator = {
    udid: "fixture",
    deviceName: "Test device",
    dimensions: { width: 400, height: 800 },
    density: 3,
    async input(command) {
      inputs.push(command);
    },
    async startVideo(onChunk) {
      starts++;
      emit = onChunk;
      return async () => {
        stops++;
      };
    },
    async close() {
      closed++;
    },
    ...overrides,
  };
  const origin = "https://simulator.example.test:9000";
  const viewer = startSimulatorViewer({
    port: 0,
    origin,
    assets: new Map([["/", new Blob(["Test viewer"], { type: "text/html" })]]),
    openSimulator: async () => device,
    idleMs,
    gestureIdleMs,
  });
  cleanup.push(() => viewer.stop());
  const base = `http://127.0.0.1:${viewer.port}`;
  async function connect(ackFrames = false) {
    const { token } = z
      .object({ token: z.string() })
      .parse(await (await fetch(`${base}/api/bootstrap`)).json());
    // Bun supports custom handshake headers; this checkout also includes DOM
    // types whose WebSocket constructor exposes only browser arguments.
    const client: unknown = Reflect.construct(WebSocket, [
      `${base.replace("http:", "ws:")}/socket?token=${token}${ackFrames ? "&frames=ack" : ""}`,
      { headers: { Origin: origin } } satisfies Bun.WebSocketOptions,
    ]);
    if (!(client instanceof WebSocket)) throw new Error("Expected a WebSocket");
    const ws = client;
    cleanup.push(() => ws.close());
    const messages: Array<string | Uint8Array> = [];
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) =>
      messages.push(
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data),
      ),
    );
    await until(() => ws.readyState === WebSocket.OPEN && messages.length > 0);
    return { ws, messages };
  }
  return {
    viewer,
    base,
    origin,
    inputs,
    connect,
    emit: (data: Uint8Array) => emit(data),
    counts: () => ({ starts, stops, closed }),
  };
}

test("JPEG stream handles chunk boundaries and concatenated frames without unbounded buffering", () => {
  const received: Uint8Array[] = [];
  const append = jpegFrames((frame) => received.push(frame));
  append(Buffer.from([0, 255]));
  append(Buffer.from([216, 1, 2, 255]));
  append(Buffer.from([217, 255, 216, 3, 255, 217]));
  expect(received.map((value) => [...value])).toEqual([
    [255, 216, 1, 2, 255, 217],
    [255, 216, 3, 255, 217],
  ]);
  expect(() =>
    append(
      Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(4 * 1024 * 1024)]),
    ),
  ).toThrow("4 MiB");
});

test("viewer commands are validated and mapped to logical points, never raw CLI arguments", () => {
  expect(
    simulatorInput({ type: "tap", x: 1, y: 0.5 }, { width: 400, height: 800 }),
  ).toEqual({ kind: "tap", x: 399, y: 400 });
  expect(
    simulatorInput(
      { type: "touch", phase: "move", x: 0.25, y: 0.75 },
      { width: 400, height: 800 },
    ),
  ).toEqual({ kind: "touch", phase: "move", x: 100, y: 600 });
  expect(
    simulatorInput(
      { type: "key", key: "Backspace" },
      { width: 400, height: 800 },
    ),
  ).toEqual({ kind: "key", key: 42 });
  for (const invalid of [
    { type: "tap", x: -1, y: 0 },
    { type: "tap", x: Infinity, y: 0 },
    { type: "swipe", x: 0, y: 0, endX: 1, endY: 1, duration: 60 },
    { type: "key", key: "; rm" },
    { type: "text", text: "x".repeat(1001) },
    { type: "home", udid: "another-device" },
  ])
    expect(viewerInputSchema.safeParse(invalid).success).toBe(false);
});

test("helper rejects foreign hosts, cross-origin control, absent tokens, and mutation HTTP verbs", async () => {
  const { base, origin } = fixture();
  const bootstrap = await fetch(`${base}/api/bootstrap`);
  expect(bootstrap.headers.get("cache-control")).toBe("no-store");
  expect(bootstrap.headers.get("access-control-allow-origin")).toBeNull();
  const { token } = z
    .object({ token: z.string() })
    .parse(await bootstrap.json());
  expect(
    (await fetch(base, { headers: { Host: "attacker.example" } })).status,
  ).toBe(403);
  expect((await fetch(base, { method: "POST" })).status).toBe(405);
  expect(
    (
      await fetch(`${base}/socket?token=${token}`, {
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${base}/socket`, { headers: { Origin: origin } })).status,
  ).toBe(403);
});

test("real WebSocket transports frames/input, shares one stream, and stops capture with the last viewer", async () => {
  const f = fixture();
  const first = await f.connect();
  const second = await f.connect();
  await until(() => f.counts().starts === 1);
  f.emit(Buffer.from([255, 216, 7, 255, 217]));
  await until(
    () =>
      first.messages.some((value) => typeof value !== "string") &&
      second.messages.some((value) => typeof value !== "string"),
  );
  first.ws.send(JSON.stringify({ type: "tap", x: 0.25, y: 0.75 }));
  first.ws.send(JSON.stringify({ type: "text", text: "hello" }));
  await until(() => f.inputs.length === 2);
  expect(f.inputs).toEqual([
    { kind: "tap", x: 100, y: 600 },
    { kind: "text", text: "hello" },
  ]);
  first.ws.close();
  second.ws.close();
  await until(() => f.counts().stops === 1);
  expect(f.counts().closed).toBe(0);
  await f.viewer.stop();
  expect(f.counts().closed).toBe(1);
});

test("acknowledged video keeps one frame in flight and sends only the newest frame after ack", async () => {
  const f = fixture();
  const { ws, messages } = await f.connect(true);
  await until(() => f.counts().starts === 1);
  const frame = (value: number) => Buffer.from([255, 216, value, 255, 217]);
  f.emit(frame(1));
  f.emit(frame(2));
  f.emit(frame(3));
  await until(
    () =>
      messages.filter((message) => typeof message !== "string").length === 1,
  );
  expect(
    messages
      .filter((message) => typeof message !== "string")
      .map((message) => [...message]),
  ).toEqual([[255, 216, 1, 255, 217]]);

  ws.send(JSON.stringify({ type: "frame-ack" }));
  await until(
    () =>
      messages.filter((message) => typeof message !== "string").length === 2,
  );
  expect(
    messages
      .filter((message) => typeof message !== "string")
      .map((message) => [...message]),
  ).toEqual([
    [255, 216, 1, 255, 217],
    [255, 216, 3, 255, 217],
  ]);
});

test("touch bursts coalesce queued moves but preserve down, newest move, and up", async () => {
  const calls: SimulatorInput[] = [];
  const releases: Array<() => void> = [];
  const f = fixture({
    input(command) {
      calls.push(command);
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "touch", phase: "down", x: 0.1, y: 0.1 }));
  await until(() => calls.length === 1);
  for (let index = 1; index <= 40; index++)
    ws.send(
      JSON.stringify({
        type: "touch",
        phase: "move",
        x: index / 100,
        y: index / 100,
      }),
    );
  ws.send(JSON.stringify({ type: "touch", phase: "up", x: 0.9, y: 0.9 }));
  await Bun.sleep(20);
  expect(calls).toEqual([{ kind: "touch", phase: "down", x: 40, y: 80 }]);

  releases.shift()?.();
  await until(() => calls.length === 2);
  expect(calls[1]).toEqual({
    kind: "touch",
    phase: "move",
    x: 160,
    y: 320,
  });
  releases.shift()?.();
  await until(() => calls.length === 3);
  expect(calls[2]).toEqual({
    kind: "touch",
    phase: "up",
    x: 360,
    y: 720,
  });
  releases.shift()?.();
});

test("a same-owner gesture queues behind an in-flight up without losing its moves or release", async () => {
  const calls: SimulatorInput[] = [];
  const releases: Array<() => void> = [];
  const f = fixture({
    input(command) {
      calls.push(command);
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "touch", phase: "down", x: 0.1, y: 0.1 }));
  await until(() => calls.length === 1);
  releases.shift()?.();
  ws.send(JSON.stringify({ type: "touch", phase: "up", x: 0.1, y: 0.1 }));
  await until(() => calls.length === 2);

  ws.send(JSON.stringify({ type: "touch", phase: "down", x: 0.2, y: 0.2 }));
  ws.send(JSON.stringify({ type: "touch", phase: "move", x: 0.3, y: 0.3 }));
  ws.send(JSON.stringify({ type: "touch", phase: "move", x: 0.4, y: 0.4 }));
  ws.send(JSON.stringify({ type: "touch", phase: "up", x: 0.5, y: 0.5 }));
  await Bun.sleep(20);
  expect(
    calls.map((command) => command.kind === "touch" && command.phase),
  ).toEqual(["down", "up"]);

  releases.shift()?.();
  await until(() => calls.length === 3);
  releases.shift()?.();
  await until(() => calls.length === 4);
  releases.shift()?.();
  await until(() => calls.length === 5);
  expect(calls).toEqual([
    { kind: "touch", phase: "down", x: 40, y: 80 },
    { kind: "touch", phase: "up", x: 40, y: 80 },
    { kind: "touch", phase: "down", x: 80, y: 160 },
    { kind: "touch", phase: "move", x: 160, y: 320 },
    { kind: "touch", phase: "up", x: 200, y: 400 },
  ]);
  releases.shift()?.();
});

test("same-owner discrete input queues behind an accepted in-flight up", async () => {
  const calls: SimulatorInput[] = [];
  const releases: Array<() => void> = [];
  const f = fixture({
    input(command) {
      calls.push(command);
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "touch", phase: "down", x: 0.1, y: 0.1 }));
  await until(() => calls.length === 1);
  releases.shift()?.();
  ws.send(JSON.stringify({ type: "touch", phase: "up", x: 0.1, y: 0.1 }));
  await until(() => calls.length === 2);
  ws.send(JSON.stringify({ type: "text", text: "submitted" }));
  await Bun.sleep(20);
  expect(calls).toHaveLength(2);

  releases.shift()?.();
  await until(() => calls.length === 3);
  expect(calls).toEqual([
    { kind: "touch", phase: "down", x: 40, y: 80 },
    { kind: "touch", phase: "up", x: 40, y: 80 },
    { kind: "text", text: "submitted" },
  ]);
  releases.shift()?.();
});

test("disconnect releases a delivered touch and drops movement that was still queued", async () => {
  const calls: SimulatorInput[] = [];
  const releases: Array<() => void> = [];
  const f = fixture({
    input(command) {
      calls.push(command);
      return new Promise<void>((resolve) => releases.push(resolve));
    },
  });
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "touch", phase: "down", x: 0.2, y: 0.3 }));
  await until(() => calls.length === 1);
  ws.send(JSON.stringify({ type: "touch", phase: "move", x: 0.8, y: 0.7 }));
  ws.close();
  await until(() => ws.readyState === WebSocket.CLOSED);
  releases.shift()?.();
  await until(() => calls.length === 2);
  expect(calls).toEqual([
    { kind: "touch", phase: "down", x: 80, y: 240 },
    { kind: "touch", phase: "up", x: 320, y: 560 },
  ]);
  releases.shift()?.();
});

test("touch input errors release ownership with an up command", async () => {
  const calls: SimulatorInput[] = [];
  const f = fixture({
    async input(command) {
      calls.push(command);
      if (command.kind === "touch" && command.phase === "move")
        throw new Error("move failed");
    },
  });
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "touch", phase: "down", x: 0.2, y: 0.3 }));
  await until(() => calls.length === 1);
  ws.send(JSON.stringify({ type: "touch", phase: "move", x: 0.4, y: 0.5 }));
  await until(() => calls.length === 3);
  expect(
    calls.map((command) => command.kind === "touch" && command.phase),
  ).toEqual(["down", "move", "up"]);
});

test("a failed down acknowledgement still attempts release", async () => {
  const calls: SimulatorInput[] = [];
  const f = fixture({
    async input(command) {
      calls.push(command);
      if (command.kind === "touch" && command.phase === "down")
        throw new Error("down acknowledgement lost");
    },
  });
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "touch", phase: "down", x: 0.1, y: 0.1 }));
  await until(() => calls.length === 2);
  expect(calls).toEqual([
    { kind: "touch", phase: "down", x: 40, y: 80 },
    { kind: "touch", phase: "up", x: 40, y: 80 },
  ]);
});

test.each(["pointer-up", "disconnect", "timeout", "move-error", "down-error"])(
  "%s release failure closes the device before any further input can run",
  async (trigger) => {
    const calls: SimulatorInput[] = [];
    const release = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    let closeStarted = false;
    const f = fixture(
      {
        async input(command) {
          calls.push(command);
          if (command.kind !== "touch") return;
          if (command.phase === "up") return release.promise;
          if (`${command.phase}-error` === trigger)
            throw new Error(`${command.phase} acknowledgement failed`);
        },
        async close() {
          closeStarted = true;
          await closing.promise;
        },
      },
      undefined,
      trigger === "timeout" ? 20 : undefined,
    );
    cleanup.push(() => {
      release.resolve();
      closing.resolve();
    });
    const owner = await f.connect();
    const observer = await f.connect();
    owner.ws.send(
      JSON.stringify({ type: "touch", phase: "down", x: 0.1, y: 0.1 }),
    );
    await until(() => calls.length >= 1);
    if (trigger === "pointer-up")
      owner.ws.send(
        JSON.stringify({ type: "touch", phase: "up", x: 0.1, y: 0.1 }),
      );
    if (trigger === "disconnect") owner.ws.close();
    if (trigger === "move-error")
      owner.ws.send(
        JSON.stringify({ type: "touch", phase: "move", x: 0.2, y: 0.2 }),
      );
    await until(() =>
      calls.some(
        (command) => command.kind === "touch" && command.phase === "up",
      ),
    );

    if (trigger === "pointer-up") {
      // All are normally accepted behind an in-flight release. They must not
      // reach the companion if that release ultimately fails.
      owner.ws.send(JSON.stringify({ type: "text", text: "queued" }));
      owner.ws.send(
        JSON.stringify({ type: "touch", phase: "down", x: 0.3, y: 0.3 }),
      );
      owner.ws.send(
        JSON.stringify({ type: "touch", phase: "up", x: 0.3, y: 0.3 }),
      );
      // Same-socket ordering gives a deterministic barrier after those commands.
      owner.ws.send(JSON.stringify({ type: "home" }));
      await until(() =>
        owner.messages.some(
          (message) =>
            typeof message === "string" &&
            message.includes("Simulator is busy"),
        ),
      );
    }
    const delivered = [...calls];
    release.reject(new Error("up acknowledgement failed"));
    await until(() => closeStarted);
    await until(() =>
      observer.messages.some(
        (message) =>
          typeof message === "string" && message.includes('"phase":"error"'),
      ),
    );

    const commands = [
      { type: "text", text: "other viewer" },
      { type: "home" },
      { type: "key", key: "Enter" },
      { type: "tap", x: 0.5, y: 0.5 },
      { type: "swipe", x: 0.1, y: 0.1, endX: 0.9, endY: 0.9, duration: 0.2 },
      { type: "touch", phase: "down", x: 0.5, y: 0.5 },
    ];
    // Device cleanup is deliberately still blocked. Admission must already
    // be closed, not just become safe after shutdown eventually completes.
    for (const command of commands) observer.ws.send(JSON.stringify(command));
    await until(
      () =>
        observer.messages.filter(
          (message) =>
            typeof message === "string" &&
            message.includes("Simulator is not ready"),
        ).length === commands.length,
    );
    expect(calls).toEqual(delivered);
    closing.resolve();
  },
);

test("idle touch gestures are released after a bounded deadline", async () => {
  const f = fixture({}, undefined, 20);
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "touch", phase: "down", x: 0.2, y: 0.3 }));
  await until(() => f.inputs.length === 2);
  expect(f.inputs).toEqual([
    { kind: "touch", phase: "down", x: 80, y: 240 },
    { kind: "touch", phase: "up", x: 80, y: 240 },
  ]);
});

test("touch ownership refuses competing input until release", async () => {
  const f = fixture();
  const first = await f.connect();
  const second = await f.connect();
  first.ws.send(
    JSON.stringify({ type: "touch", phase: "down", x: 0.2, y: 0.3 }),
  );
  await until(() => f.inputs.length === 1);
  second.ws.send(JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }));
  await until(() =>
    second.messages.some(
      (message) =>
        typeof message === "string" &&
        JSON.parse(message).type === "input-error",
    ),
  );
  expect(f.inputs).toHaveLength(1);

  first.ws.send(JSON.stringify({ type: "touch", phase: "up", x: 0.2, y: 0.3 }));
  await until(() => f.inputs.length === 2);
  second.ws.send(JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }));
  await until(() => f.inputs.length === 3);
  expect(f.inputs[2]).toEqual({ kind: "tap", x: 200, y: 400 });
});

test("disconnect before a queued down is delivered does not synthesize a touch", async () => {
  let releaseTap: (() => void) | undefined;
  const calls: SimulatorInput[] = [];
  const f = fixture({
    input(command) {
      calls.push(command);
      if (command.kind !== "tap") return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseTap = resolve;
      });
    },
  });
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "tap", x: 0.1, y: 0.1 }));
  await until(() => calls.length === 1);
  ws.send(JSON.stringify({ type: "touch", phase: "down", x: 0.3, y: 0.4 }));
  ws.close();
  await until(() => ws.readyState === WebSocket.CLOSED);
  releaseTap?.();
  await Bun.sleep(20);
  expect(calls).toEqual([{ kind: "tap", x: 40, y: 80 }]);
});

test("invalid input closes the connection without controlling a simulator", async () => {
  const f = fixture();
  const { ws } = await f.connect();
  ws.send(JSON.stringify({ type: "tap", x: 2, y: 0 }));
  await until(() => ws.readyState === WebSocket.CLOSED);
  expect(f.inputs).toEqual([]);
});

test("setup failures remain visible in the Portal rather than pretending a device is ready", async () => {
  const viewer = startSimulatorViewer({
    port: 0,
    origin: "https://viewer.test",
    assets: new Map(),
    openSimulator: async () => {
      throw new Error("Xcode is missing");
    },
  });
  cleanup.push(() => viewer.stop());
  await viewer.ready;
  expect(
    await (await fetch(`http://127.0.0.1:${viewer.port}/api/bootstrap`)).json(),
  ).toMatchObject({ state: { phase: "error", message: "Xcode is missing" } });
});

test("a capture spawn failure releases the simulator even with an error viewer connected", async () => {
  const f = fixture({
    startVideo: async () => {
      throw new Error("idb capture spawn failed");
    },
  });
  await f.connect();
  await until(() => f.counts().closed === 1);
  expect(await (await fetch(`${f.base}/api/bootstrap`)).json()).toMatchObject({
    state: { phase: "error", message: "idb capture spawn failed" },
  });
  await f.viewer.stop();
  expect(f.counts().closed).toBe(1);
});

test("a failed capture stop still closes the device", async () => {
  const f = fixture({
    startVideo: async () => async () => {
      throw new Error("capture did not stop");
    },
  });
  const { ws } = await f.connect();
  ws.close();
  await until(() => f.counts().closed === 1);
  await f.viewer.stop();
  expect(f.counts().closed).toBe(1);
});

test("idle viewers release their device and listener", async () => {
  const f = fixture({}, 20);
  await until(() => f.counts().closed === 1);
  await f.viewer.stop();
  expect(f.counts().closed).toBe(1);
});
