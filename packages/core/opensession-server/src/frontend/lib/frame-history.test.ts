import { expect, test } from "bun:test";
import {
  canStepFrame,
  frameEntered,
  frameLoaded,
  frameReturned,
  frameStepped,
  freshFrameHistory,
} from "./frame-history";

test("each page the frame loads is a step back", () => {
  let history = frameLoaded(frameLoaded(freshFrameHistory(3), 4), 5);
  expect(history.back).toBe(2);
  expect(canStepFrame(history, 1)).toBe(false);
  history = frameStepped(history, -1, 5);
  expect([history.back, history.forward]).toEqual([1, 1]);
  // The load Back caused is not a new page.
  history = frameLoaded(history, 5);
  expect([history.back, history.forward]).toEqual([1, 1]);
});

test("a new page after going back drops what was ahead", () => {
  const stepped = frameStepped(frameLoaded(freshFrameHistory(1), 2), -1, 2);
  const history = frameLoaded(frameLoaded(stepped, 2), 2);
  expect([history.back, history.forward]).toEqual([1, 0]);
});

test("a step with no load ends once focus goes back into the frame", () => {
  const stepped = frameStepped(frameLoaded(freshFrameHistory(1), 2), -1, 2);
  const history = frameLoaded(frameEntered(stepped), 2);
  expect([history.back, history.forward]).toEqual([1, 0]);
});

test("entries a single-page app pushed count once focus returns", () => {
  const history = frameReturned(freshFrameHistory(4), 6);
  expect([history.back, history.forward, history.length]).toEqual([2, 0, 6]);
  expect(frameReturned(history, 6)).toBe(history);
});

test("pushes after going back count the forward entries they dropped", () => {
  const history = { back: 2, forward: 2, stepping: false, length: 5 };
  // Two pushes drop the two entries ahead: the length is unchanged.
  expect(frameReturned(history, 5)).toBe(history);
  // Three pushes: one more entry than before.
  expect(frameReturned(history, 6)).toMatchObject({ back: 5, forward: 0 });
});

test("a step with nowhere to go changes nothing", () => {
  const history = freshFrameHistory(1);
  expect(frameStepped(history, -1, 1)).toBe(history);
  expect(frameStepped(history, 1, 1)).toBe(history);
});

test("entries the app pushed after the frame's end its history", () => {
  const history = frameLoaded(freshFrameHistory(2), 3);
  expect(frameStepped(history, -1, 4)).toEqual(freshFrameHistory(4));
});
