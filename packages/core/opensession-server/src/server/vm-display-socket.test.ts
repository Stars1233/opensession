import { afterAll, describe, expect, test } from "bun:test";
import {
  vmDisplayClose,
  vmDisplayMessage,
  vmDisplayOpen,
  vmDisplayViewerCount,
} from "./vm-display";

/** A stand-in for a hosted provider's VNC WebSocket: greets with the RFB
 *  banner and the Authorization header it saw, then echoes every frame. */
const upstream = Bun.serve<{ auth: string | null }>({
  port: 0,
  fetch(req, server) {
    if (
      server.upgrade(req, { data: { auth: req.headers.get("authorization") } })
    )
      return undefined;
    return new Response("expected a websocket", { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.send(Buffer.from(`RFB 003.008\nauth=${ws.data.auth ?? ""}\n`));
    },
    message(ws, message) {
      ws.send(Buffer.concat([Buffer.from("echo:"), Buffer.from(message)]));
    },
  },
});

afterAll(() => {
  upstream.stop(true);
});

function viewer(connectionId: string) {
  const received: Buffer[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const ws = {
    data: {
      vmDisplay: {
        connectionId,
        sessionId: "bks-1",
        socket: {
          url: `ws://127.0.0.1:${upstream.port}/v1/sandboxes/sb-1/vnc/ws`,
          headers: { Authorization: "Bearer uc_live_test" },
        },
      },
    },
    send: (frame: Buffer) => received.push(Buffer.from(frame)),
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
  };
  return { ws, received, closes };
}

async function until(predicate: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

describe("hosted Mac VM display bridge", () => {
  test("relays bytes both ways over a socket the server opens, with the provider's auth", async () => {
    const { ws, received, closes } = viewer("conn-socket-1");
    expect(vmDisplayOpen(ws)).toBe(true);
    expect(vmDisplayViewerCount()).toBeGreaterThanOrEqual(1);
    // Sent before the upstream socket is open: queued, then flushed.
    expect(vmDisplayMessage(ws, Buffer.from("hello"))).toBe(true);
    await until(() => received.length >= 2);
    const text = Buffer.concat(received).toString();
    expect(text).toContain("RFB 003.008");
    expect(text).toContain("auth=Bearer uc_live_test");
    expect(text).toContain("echo:hello");
    // Text frames are not RFB and are dropped.
    expect(vmDisplayMessage(ws, "ping")).toBe(true);
    expect(vmDisplayMessage(ws, Buffer.from("again"))).toBe(true);
    await until(() =>
      Buffer.concat(received).toString().includes("echo:again"),
    );
    expect(closes).toEqual([]);
    expect(vmDisplayClose(ws)).toBe(true);
    await until(() => !vmDisplayViewerCount());
  });

  test("an upstream that refuses the socket closes the viewer", async () => {
    const { ws, closes } = viewer("conn-socket-2");
    ws.data.vmDisplay.socket.url = "ws://127.0.0.1:1/nowhere";
    expect(vmDisplayOpen(ws)).toBe(true);
    await until(() => closes.length > 0);
    expect(closes[0]?.code).toBe(1011);
  });
});
