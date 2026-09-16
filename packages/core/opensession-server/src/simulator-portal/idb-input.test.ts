import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type ServerHttp2Stream } from "node:http2";
import { rm } from "node:fs/promises";
import { createPersistentIdbInput, idbHidEvent } from "./idb-input";

const sockets: string[] = [];
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((path) => rm(path, { force: true })));
});

const frames = (chunks: Uint8Array[]): Uint8Array[] => {
  const bytes = Buffer.concat(chunks);
  const messages: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset + 1);
    messages.push(bytes.subarray(offset + 5, offset + 5 + length));
    offset += length + 5;
  }
  return messages;
};
const protobufBytes = (field: number, value: Uint8Array): Uint8Array =>
  Uint8Array.from([(field << 3) | 2, value.length, ...value]);
const grpcFrame = (message: Uint8Array): Uint8Array => {
  const result = new Uint8Array(message.length + 5);
  new DataView(result.buffer).setUint32(1, message.length, false);
  result.set(message, 5);
  return result;
};

const startServer = async (
  onStream: (
    stream: ServerHttp2Stream,
    path: string,
    messages: Uint8Array[],
  ) => void,
  onOpen?: (stream: ServerHttp2Stream, path: string) => void,
): Promise<{
  socketPath: string;
  close: () => Promise<void>;
  sessions: () => number;
}> => {
  const socketPath = `/tmp/idb-input-${crypto.randomUUID()}.sock`;
  sockets.push(socketPath);
  const server = createServer();
  let sessionCount = 0;
  server.on("session", () => (sessionCount += 1));
  server.on("stream", (stream, headers) => {
    // Rejection tests intentionally cancel requests before the response finishes.
    stream.on("error", () => undefined);
    const path = String(headers[":path"]);
    // SAFETY: createServer's stream event always provides a server stream.
    onOpen?.(stream as ServerHttp2Stream, path);
    const chunks: Uint8Array[] = [];
    stream.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    stream.on("end", () =>
      onStream(
        // SAFETY: createServer's stream event always provides a server stream.
        stream as ServerHttp2Stream,
        path,
        frames(chunks),
      ),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    sessions: () => sessionCount,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
const acknowledge = (
  stream: ServerHttp2Stream,
  message: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): void => {
  stream.respond({
    ":status": 200,
    "content-type": "application/grpc",
    "grpc-status": "0",
  });
  stream.end(grpcFrame(message));
};

describe("persistent idb transport", () => {
  test("matches the pinned idb 1.5.9 HID protobuf schema", () => {
    expect(Buffer.from(idbHidEvent.touch(10, 20, "down")).toString("hex")).toBe(
      "0a180a160a140a12090000000000002440110000000000003440",
    );
    expect(Buffer.from(idbHidEvent.touch(12, 22, "up")).toString("hex")).toBe(
      "0a1a0a160a140a120900000000000028401100000000000036401001",
    );
    expect(Buffer.from(idbHidEvent.key(40, "down")).toString("hex")).toBe(
      "0a060a041a020828",
    );
    expect(Buffer.from(idbHidEvent.buttonHome("up")).toString("hex")).toBe(
      "0a080a04120208011001",
    );
    expect(
      Buffer.from(idbHidEvent.swipe(1, 2, 3, 4, 0.5)).toString("hex"),
    ).toBe(
      "12310a1209000000000000f03f110000000000000040121209000000000000084011000000000000104031000000000000e03f",
    );
  });

  test("acknowledges down, move, and up on separate RPCs over one connection", async () => {
    const calls: Array<{ path: string; messages: Uint8Array[] }> = [];
    const server = await startServer((stream, path, messages) => {
      calls.push({ path, messages });
      acknowledge(stream);
    });
    const input = createPersistentIdbInput(server.socketPath);
    await input.touch("down", 10, 20);
    expect(calls).toHaveLength(1);
    await input.touch("move", 11, 21);
    expect(calls).toHaveLength(2);
    await input.touch("up", 12, 22);
    expect(calls).toEqual([
      {
        path: "/idb.CompanionService/hid",
        messages: [idbHidEvent.touch(10, 20, "down")],
      },
      {
        path: "/idb.CompanionService/hid",
        messages: [idbHidEvent.touch(11, 21, "down")],
      },
      {
        path: "/idb.CompanionService/hid",
        messages: [idbHidEvent.touch(12, 22, "up")],
      },
    ]);
    await input.send([idbHidEvent.key(40, "down"), idbHidEvent.key(40, "up")]);
    expect(calls).toHaveLength(4);
    expect(server.sessions()).toBe(1);
    await input.close();
    await server.close();
  });

  test("releases an active touch during cleanup and ignores an orphan up", async () => {
    const messages: Uint8Array[][] = [];
    const server = await startServer((stream, _path, requestMessages) => {
      messages.push(requestMessages);
      acknowledge(stream);
    });
    const input = createPersistentIdbInput(server.socketPath);
    await input.touch("up", 1, 2);
    await input.touch("down", 3, 4);
    await input.close();
    expect(messages).toEqual([
      [idbHidEvent.touch(3, 4, "down")],
      [idbHidEvent.touch(3, 4, "up")],
    ]);
    await server.close();
  });

  test("propagates an early companion rejection without an unhandled error", async () => {
    const reject = (stream: ServerHttp2Stream) => {
      stream.respond({
        ":status": 200,
        "content-type": "application/grpc",
        "grpc-status": "13",
      });
      stream.end();
    };
    const server = await startServer(() => undefined, reject);
    const input = createPersistentIdbInput(server.socketPath);
    await expect(input.touch("down", 1, 2)).rejects.toThrow("gRPC status 13");
    await input.close();
    await server.close();
  });

  test("attempts release when down was delivered but its acknowledgement failed", async () => {
    const rejected = new WeakSet<ServerHttp2Stream>();
    const accepted: Uint8Array[][] = [];
    let opened = 0;
    const server = await startServer(
      (stream, _path, messages) => {
        if (rejected.has(stream)) return;
        accepted.push(messages);
        acknowledge(stream);
      },
      (stream) => {
        opened += 1;
        if (opened !== 1) return;
        rejected.add(stream);
        stream.respond({
          ":status": 200,
          "content-type": "application/grpc",
          "grpc-status": "13",
        });
        stream.end();
      },
    );
    const input = createPersistentIdbInput(server.socketPath);
    await expect(input.touch("down", 7, 8)).rejects.toThrow("gRPC status 13");
    await input.close();
    expect(opened).toBe(2);
    expect(accepted).toEqual([[idbHidEvent.touch(7, 8, "up")]]);
    expect(server.sessions()).toBe(1);
    await server.close();
  });

  test("requires a successful HTTP response and explicit gRPC status", async () => {
    for (const status of [200, 503]) {
      const server = await startServer((stream) => {
        stream.respond({ ":status": status });
        stream.end();
      });
      const input = createPersistentIdbInput(server.socketPath);
      try {
        await expect(input.send([idbHidEvent.key(40, "down")])).rejects.toThrow(
          status === 200 ? "gRPC status missing" : "HTTP status 503",
        );
      } finally {
        await input.close();
        await server.close();
      }
    }
  });

  test("bounds responses before buffering a whole oversized image", async () => {
    const server = await startServer((stream) => {
      acknowledge(stream, new Uint8Array(4 * 1024 * 1024 + 65));
    });
    const input = createPersistentIdbInput(server.socketPath);
    try {
      await expect(
        input.screenshot({ quality: 0.5, scale: 0.5 }),
      ).rejects.toThrow("4 MiB limit");
    } finally {
      await input.close();
      await server.close();
    }
  });

  test("reports companions that ignore JPEG options instead of buffering PNG frames", async () => {
    const server = await startServer((stream) => {
      acknowledge(stream, protobufBytes(1, Uint8Array.from([137, 80, 78, 71])));
    });
    const input = createPersistentIdbInput(server.socketPath);
    try {
      await expect(
        input.screenshot({ quality: 0.5, scale: 0.5 }),
      ).rejects.toThrow("JPEG screenshot options");
    } finally {
      await input.close();
      await server.close();
    }
  });

  test("captures JPEG screenshots over the same private socket", async () => {
    const image = Uint8Array.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const paths: string[] = [];
    const server = await startServer((stream, path, messages) => {
      paths.push(path);
      expect(messages).toHaveLength(1);
      acknowledge(stream, protobufBytes(1, image));
    });
    const input = createPersistentIdbInput(server.socketPath);
    expect(await input.screenshot({ quality: 0.5, scale: 0.5 })).toEqual(image);
    expect(paths).toEqual(["/idb.CompanionService/screenshot"]);
    await input.close();
    await server.close();
  });
});
