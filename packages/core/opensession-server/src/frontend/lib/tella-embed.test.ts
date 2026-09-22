import { describe, expect, it } from "bun:test";
import { tellaVideoEmbed } from "./tella-embed";

describe("tellaVideoEmbed", () => {
  const player = "https://www.tella.tv/video/my-demo-3592/embed";

  it("resolves every share form to the same player", () => {
    for (const href of [
      "https://www.tella.tv/video/my-demo-3592",
      "https://www.tella.tv/video/my-demo-3592/",
      "https://www.tella.tv/video/my-demo-3592/view",
      "https://www.tella.tv/video/my-demo-3592/view?utm_source=slack",
      "https://tella.tv/video/my-demo-3592/view",
      "https://www.tella.tv/video/my-demo-3592/embed",
    ]) {
      expect(tellaVideoEmbed(href)?.src).toBe(player);
    }
  });

  it("keeps the player options on an embed link", () => {
    expect(
      tellaVideoEmbed("https://www.tella.tv/video/my-demo-3592/embed?b=0&t=12")
        ?.src,
    ).toBe(`${player}?b=0&t=12`);
  });

  it("labels the link as written, minus the scheme", () => {
    expect(tellaVideoEmbed("https://tella.tv/video/my-demo-3592/view")).toEqual(
      {
        id: "my-demo-3592",
        src: player,
        label: "tella.tv/video/my-demo-3592/view",
      },
    );
  });

  it("ignores anything that is not a Tella video page", () => {
    for (const href of [
      "https://www.tella.tv/pricing",
      "https://www.tella.tv/video/",
      "https://www.tella.tv/video/my-demo-3592/edit",
      "https://www.tella.tv/video/my-demo-3592/view/extra",
      "https://www.tella.tv/video/../view",
      "http://www.tella.tv/video/my-demo-3592",
      "https://tella.tv.example/video/my-demo-3592",
      "https://example.com/video/my-demo-3592",
      "not a url",
    ]) {
      expect(tellaVideoEmbed(href)).toBeNull();
    }
  });
});
