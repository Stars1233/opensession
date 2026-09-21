import { describe, expect, test } from "bun:test";

import {
  describePlatform,
  formatViewportReadout,
  type ViewportSample,
} from "./viewport-readout";

const sample: ViewportSample = {
  platform: "iOS 27.0",
  standalone: true,
  innerWidth: 393,
  innerHeight: 852,
  screenWidth: 393,
  screenHeight: 852,
  rootHeight: "852px",
  viewportHeight: 790,
  viewportOffsetTop: 62,
  viewportPageTop: 62,
  viewportScale: 1,
  scrollY: 0,
  keyboard: false,
  focused: "body",
  hidden: false,
  scrollerTop: 4120,
  pan: {
    runs: 3,
    released: 0,
    reason: "rest",
    pan: 0,
    scrollY: 0,
    scale: 1,
    viewportEvents: 0,
    scrollerEvents: 9,
  },
};

describe("viewport readout", () => {
  test("names the iOS version from the user agent", () => {
    expect(
      describePlatform(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15",
        "iPhone",
      ),
    ).toBe("iOS 27.0");
    expect(describePlatform("Mozilla/5.0 (X11; Linux x86_64)", "Linux")).toBe(
      "Linux",
    );
  });

  test("one line per question the phone layout asks", () => {
    expect(formatViewportReadout(sample)).toEqual([
      "iOS 27.0 standalone",
      "win 393x852 screen 393x852 root 852px",
      "vv h790 top62 page62 scale1 scrollY 0",
      "kb closed focus body visible scroller 4120",
      "pan rest runs3 rel0 pan0 sy0 scale1 vv0 sc9",
    ]);
  });

  test("a client without a visual viewport or the bootstrap shows dashes", () => {
    const lines = formatViewportReadout({
      ...sample,
      standalone: false,
      rootHeight: "",
      viewportHeight: null,
      viewportOffsetTop: null,
      viewportPageTop: null,
      viewportScale: null,
      scrollerTop: null,
      pan: null,
    });
    expect(lines[0]).toBe("iOS 27.0 browser");
    expect(lines[1]).toEndWith("root auto");
    expect(lines[2]).toBe("vv h- top- page- scale- scrollY 0");
    expect(lines[3]).toEndWith("scroller -");
    expect(lines[4]).toBe("pan release not installed");
  });
});
