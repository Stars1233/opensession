import {
  connect as connectHttp2,
  type ClientHttp2Session,
  type ClientHttp2Stream,
} from "node:http2";
import { connect as connectSocket } from "node:net";

export type PersistentIdbInput = {
  send: (events: Uint8Array[]) => Promise<void>;
  touch: (phase: "down" | "move" | "up", x: number, y: number) => Promise<void>;
  screenshot: (options: {
    quality: number;
    scale: number;
  }) => Promise<Uint8Array>;
  close: () => Promise<void>;
};

const HID_PATH = "/idb.CompanionService/hid";
const SCREENSHOT_PATH = "/idb.CompanionService/screenshot";
const WRITE_TIMEOUT_MS = 2_000;
const RESPONSE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024 + 64;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const varint = (value: number): Uint8Array => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
};

const field = (number: number, value: Uint8Array): Uint8Array =>
  concat(varint((number << 3) | 2), varint(value.length), value);
const enumField = (number: number, value: number): Uint8Array =>
  concat(varint(number << 3), varint(value));
const doubleField = (number: number, value: number): Uint8Array => {
  const bytes = new Uint8Array(9);
  bytes[0] = (number << 3) | 1;
  new DataView(bytes.buffer).setFloat64(1, value, true);
  return bytes;
};

const point = (x: number, y: number): Uint8Array =>
  concat(doubleField(1, x), doubleField(2, y));

/** Encoders pinned to idb.proto's idb.HIDEvent schema. */
export const idbHidEvent = {
  touch(x: number, y: number, direction: "down" | "up"): Uint8Array {
    const touch = field(1, point(x, y));
    const action = field(1, touch);
    const press = concat(
      field(1, action),
      ...(direction === "up" ? [enumField(2, 1)] : []),
    );
    return field(1, press);
  },
  buttonHome(direction: "down" | "up"): Uint8Array {
    const button = enumField(1, 1);
    const action = field(2, button);
    const press = concat(
      field(1, action),
      ...(direction === "up" ? [enumField(2, 1)] : []),
    );
    return field(1, press);
  },
  key(keycode: number, direction: "down" | "up"): Uint8Array {
    const key = enumField(1, keycode);
    const action = field(3, key);
    const press = concat(
      field(1, action),
      ...(direction === "up" ? [enumField(2, 1)] : []),
    );
    return field(1, press);
  },
  swipe(
    x: number,
    y: number,
    endX: number,
    endY: number,
    duration: number,
  ): Uint8Array {
    const swipe = concat(
      field(1, point(x, y)),
      field(2, point(endX, endY)),
      doubleField(6, duration),
    );
    return field(2, swipe);
  },
};

const shiftedKey = 225;
const punctuationKeys = {
  "\n": [40, false],
  " ": [44, false],
  "-": [45, false],
  "=": [46, false],
  "[": [47, false],
  "]": [48, false],
  "\\": [49, false],
  ";": [51, false],
  "'": [52, false],
  "`": [53, false],
  ",": [54, false],
  ".": [55, false],
  "/": [56, false],
  "!": [30, true],
  "@": [31, true],
  "#": [32, true],
  $: [33, true],
  "%": [34, true],
  "^": [35, true],
  "&": [36, true],
  "*": [37, true],
  "(": [38, true],
  ")": [39, true],
  _: [45, true],
  "+": [46, true],
  "{": [47, true],
  "}": [48, true],
  "|": [49, true],
  ":": [51, true],
  '"': [52, true],
  "~": [53, true],
  "<": [54, true],
  ">": [55, true],
  "?": [56, true],
} satisfies Record<string, readonly [number, boolean]>;

export const idbTextEvents = (text: string): Uint8Array[] => {
  const events: Uint8Array[] = [];
  const press = (key: number) =>
    events.push(idbHidEvent.key(key, "down"), idbHidEvent.key(key, "up"));
  for (const character of text) {
    let key: number;
    let shifted = false;
    if (character >= "a" && character <= "z")
      key = character.charCodeAt(0) - 93;
    else if (character >= "A" && character <= "Z") {
      key = character.charCodeAt(0) - 61;
      shifted = true;
    } else if (character >= "1" && character <= "9")
      key = character.charCodeAt(0) - 19;
    else if (character === "0") key = 39;
    else {
      if (!Object.hasOwn(punctuationKeys, character)) {
        throw new Error(`No keycode found for ${character}`);
      }
      // SAFETY: Object.hasOwn proves this runtime string is a key of the table.
      [key, shifted] =
        punctuationKeys[character as keyof typeof punctuationKeys];
    }
    if (shifted) events.push(idbHidEvent.key(shiftedKey, "down"));
    press(key);
    if (shifted) events.push(idbHidEvent.key(shiftedKey, "up"));
  }
  return events;
};

const grpcFrame = (message: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(message.length + 5);
  new DataView(frame.buffer).setUint32(1, message.length, false);
  frame.set(message, 5);
  return frame;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

const write = async (
  stream: ClientHttp2Stream,
  message: Uint8Array,
): Promise<void> =>
  withTimeout(
    new Promise<void>((resolve, reject) => {
      stream.write(grpcFrame(message), (error) =>
        error ? reject(error) : resolve(),
      );
    }),
    WRITE_TIMEOUT_MS,
    "idb input write timed out",
  );

const readResponse = async (stream: ClientHttp2Stream): Promise<Uint8Array> => {
  let grpcStatus: string | undefined;
  let httpStatus = 0;
  const recordStatus = (
    headers: Record<string, string | string[] | number | undefined>,
  ) => {
    if (headers[":status"] !== undefined)
      httpStatus = Number(headers[":status"]);
    const status = headers["grpc-status"];
    grpcStatus = Array.isArray(status)
      ? status[0]
      : String(status ?? grpcStatus ?? "");
  };
  stream.on("response", recordStatus);
  stream.on("trailers", recordStatus);
  const chunks: Uint8Array[] = [];
  let received = 0;
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Uint8Array) => {
        received += chunk.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
          reject(new Error("idb RPC response exceeds the 4 MiB limit"));
          return;
        }
        chunks.push(chunk);
      });
      stream.once("end", resolve);
      stream.once("error", reject);
    }),
    RESPONSE_TIMEOUT_MS,
    "idb RPC acknowledgement timed out",
  );
  if (httpStatus !== 200)
    throw new Error(`idb RPC failed with HTTP status ${httpStatus}`);
  if (grpcStatus !== "0")
    throw new Error(
      `idb RPC failed with gRPC status ${grpcStatus || "missing"}`,
    );
  return concat(...chunks);
};

const readVarint = (bytes: Uint8Array, start: number): [number, number] => {
  let value = 0;
  let multiplier = 1;
  for (
    let offset = start;
    offset < bytes.length && offset < start + 10;
    offset += 1
  ) {
    const byte = bytes[offset] ?? 0;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return [value, offset + 1];
    multiplier *= 128;
  }
  throw new Error("idb returned an invalid protobuf varint");
};

const screenshotBytes = (response: Uint8Array): Uint8Array => {
  if (response.length < 5 || response[0] !== 0)
    throw new Error("idb returned an invalid gRPC screenshot frame");
  const length = new DataView(
    response.buffer,
    response.byteOffset,
    response.byteLength,
  ).getUint32(1, false);
  if (response.length !== 5 + length)
    throw new Error("idb returned an invalid gRPC screenshot length");
  const message = response.subarray(5, 5 + length);
  const [tag, valueStart] = readVarint(message, 0);
  if (tag !== 10)
    throw new Error("idb screenshot response did not contain image data");
  const [imageLength, imageStart] = readVarint(message, valueStart);
  if (imageStart + imageLength > message.length)
    throw new Error("idb returned truncated screenshot data");
  const image = message.slice(imageStart, imageStart + imageLength);
  if (
    image[0] !== 0xff ||
    image[1] !== 0xd8 ||
    image.at(-2) !== 0xff ||
    image.at(-1) !== 0xd9
  )
    throw new Error(
      "idb companion must support JPEG screenshot options (tested with idb 1.5.9)",
    );
  return image;
};

export const createPersistentIdbInput = (
  socketPath: string,
): PersistentIdbInput => {
  const session: ClientHttp2Session = connectHttp2("http://localhost", {
    createConnection: () => connectSocket(socketPath),
  });
  // Streams receive connection failures too. Keeping this listener prevents an
  // unhandled EventEmitter error while the operation reports its own failure.
  session.on("error", () => undefined);
  type Rpc = {
    stream: ClientHttp2Stream;
    response: Promise<Uint8Array>;
    earlyFailure: Promise<never>;
  };
  let activeTouch: { x: number; y: number } | undefined;
  let closed = false;

  const request = (path = HID_PATH): Rpc => {
    if (closed) throw new Error("idb transport is closed");
    const stream = session.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/grpc",
      te: "trailers",
    });
    // Install permanent response/error listeners before the first write so an
    // immediate companion rejection cannot become an unhandled stream error.
    const response = readResponse(stream);
    const earlyFailure = response.then<never>(() => {
      throw new Error("idb RPC ended before the request was complete");
    });
    // Mark rejection as observed while preserving it for the next operation.
    void earlyFailure.catch(() => undefined);
    return { stream, response, earlyFailure };
  };

  const send = async (events: Uint8Array[]): Promise<void> => {
    const rpc = request();
    try {
      for (const event of events) {
        await Promise.race([write(rpc.stream, event), rpc.earlyFailure]);
      }
      rpc.stream.end();
      await rpc.response;
    } catch (error) {
      rpc.stream.close();
      throw error;
    }
  };

  const releaseTouch = async (): Promise<void> => {
    const active = activeTouch;
    if (active === undefined) return;
    await send([idbHidEvent.touch(active.x, active.y, "up")]);
    if (activeTouch === active) activeTouch = undefined;
  };

  return {
    send,
    async touch(phase, x, y) {
      if (phase === "down") {
        await releaseTouch();
        activeTouch = { x, y };
        await send([idbHidEvent.touch(x, y, "down")]);
        return;
      }
      const active = activeTouch;
      if (active === undefined) {
        if (phase === "up") return;
        throw new Error("touch move requires an active touch");
      }
      if (phase === "move") {
        await send([idbHidEvent.touch(x, y, "down")]);
        active.x = x;
        active.y = y;
        return;
      }
      active.x = x;
      active.y = y;
      await releaseTouch();
    },
    async screenshot({ quality, scale }) {
      if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
        throw new Error("screenshot quality must be between 0 and 1");
      }
      if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
        throw new Error(
          "screenshot scale must be greater than 0 and at most 1",
        );
      }
      const rpc = request(SCREENSHOT_PATH);
      try {
        rpc.stream.end(
          grpcFrame(
            concat(
              enumField(1, 1),
              doubleField(2, quality),
              doubleField(4, scale),
            ),
          ),
        );
        return screenshotBytes(await rpc.response);
      } catch (error) {
        rpc.stream.close();
        throw error;
      }
    },
    async close() {
      if (closed) return;
      await releaseTouch().catch(() => undefined);
      closed = true;
      session.close();
      await withTimeout(
        new Promise<void>((resolve) => {
          if (session.closed || session.destroyed) resolve();
          else session.once("close", resolve);
        }),
        WRITE_TIMEOUT_MS,
        "idb input transport close timed out",
      ).catch(() => session.destroy());
    },
  };
};
