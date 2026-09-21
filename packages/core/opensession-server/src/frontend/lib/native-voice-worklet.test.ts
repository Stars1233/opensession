import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { NATIVE_VOICE_WORKLET } from "./native-voice-worklet";

interface Packet {
  type: string;
  samples?: Float32Array;
  epoch?: number;
}
interface InputPacket extends Packet {
  paused?: boolean;
}
interface Processor {
  port: {
    onmessage: (event: { data: InputPacket }) => void;
    postMessage: (data: Packet) => void;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
function setup() {
  const posted: Packet[] = [];
  let create: (() => Processor) | undefined;
  runInNewContext(NATIVE_VOICE_WORKLET, {
    Float32Array,
    AudioWorkletProcessor: class {
      port = { postMessage: (data: Packet) => posted.push(data) };
    },
    registerProcessor: (_name: string, Constructor: new () => Processor) => {
      create = () => new Constructor();
    },
  });
  const processor = create!();
  return {
    posted,
    send: (data: InputPacket) => processor.port.onmessage({ data }),
    render: (frames = 128, input?: Float32Array) => {
      const output = new Float32Array(frames);
      expect(processor.process(input ? [[input]] : [[]], [[output]])).toBe(
        true,
      );
      return output;
    },
  };
}

test("native microphone reaches WebRTC, not remote playback; underrun is silence", () => {
  const h = setup();
  h.send({ type: "mic", samples: new Float32Array([0.2, 0.4]), epoch: 0 });
  const output = h.render();
  expect(output[0]).toBeCloseTo(0.2);
  expect(output[1]).toBeCloseTo(0.4);
  expect(output.slice(2).every((value) => value === 0)).toBe(true);
  h.render(832, new Float32Array(832).fill(0.7));
  const packet = h.posted.find((item) => item.type === "playback")!;
  expect(packet.samples?.length).toBe(960);
  expect(packet.samples?.[0]).toBe(0);
  expect(packet.samples?.[128]).toBeCloseTo(0.7);
  expect(h.posted[0].type).toBe("mic-ack");
});

test("stalled renderer cannot queue unlimited playback; acknowledgements reopen flow", () => {
  const h = setup();
  for (let i = 0; i < 20; i++) h.render(960);
  expect(h.posted.length).toBe(4);
  h.send({ type: "playback-ack" });
  h.render(960);
  expect(h.posted.length).toBe(5);
});

test("microphone overflow drops oldest samples and retains a bounded live window", () => {
  const h = setup();
  h.send({ type: "mic", samples: new Float32Array(12000).fill(0.1), epoch: 0 });
  h.send({ type: "mic", samples: new Float32Array(12000).fill(0.8), epoch: 0 });
  expect(h.render(12000).every((value) => Math.abs(value - 0.8) < 0.001)).toBe(
    true,
  );
  expect(h.render().every((value) => value === 0)).toBe(true);
});

test("pause flushes microphone and partial playback, acknowledges dropped mic, and gates resume epochs", () => {
  const h = setup();
  h.send({ type: "mic", samples: new Float32Array(960).fill(0.4), epoch: 0 });
  h.render(128, new Float32Array(128).fill(0.9));
  h.send({ type: "state", paused: true, epoch: 1 });
  expect(h.render(960).every((value) => value === 0)).toBe(true);
  h.send({ type: "mic", samples: new Float32Array(960).fill(0.5), epoch: 1 });
  h.send({ type: "state", paused: false, epoch: 2 });
  h.send({ type: "mic", samples: new Float32Array(960).fill(0.6), epoch: 0 });
  expect(h.render(960).every((value) => value === 0)).toBe(true);
  expect(h.posted.filter((p) => p.type === "mic-ack").length).toBe(3);
  expect(
    h.posted.find((p) => p.type === "playback")?.samples?.every((v) => v === 0),
  ).toBe(true);
  expect(h.posted.find((p) => p.type === "playback")?.epoch).toBe(2);
});

test("barge-in flushes partial agent playback but preserves captured user speech", () => {
  const h = setup();
  h.send({ type: "mic", samples: new Float32Array(960).fill(0.4), epoch: 0 });
  h.render(128, new Float32Array(128).fill(0.9));
  h.send({ type: "state", paused: false, epoch: 1 });
  expect(h.render(832).every((value) => Math.abs(value - 0.4) < 0.001)).toBe(
    true,
  );
  h.render(128);
  const playback = h.posted.find((p) => p.type === "playback");
  expect(playback?.samples?.every((value) => value === 0)).toBe(true);
  expect(playback?.epoch).toBe(1);
});
