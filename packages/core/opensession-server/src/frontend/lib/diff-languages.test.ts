import { expect, test } from "bun:test";
import {
  getFiletypeFromFileName,
  getSharedHighlighter,
  resolveLanguage,
} from "@pierre/diffs";
import { ensureDiffLanguages } from "./diff-languages";

test("review diffs highlight ReScript sources", async () => {
  ensureDiffLanguages();
  ensureDiffLanguages();
  expect(getFiletypeFromFileName("src/App.res")).toBe("rescript");
  expect(getFiletypeFromFileName("src/App.resi")).toBe("rescript");

  await resolveLanguage("rescript");
  const highlighter = await getSharedHighlighter({
    themes: ["github-dark-default"],
    langs: ["rescript"],
  });
  const tokens = highlighter.codeToTokensBase("let answer = 42", {
    lang: "rescript",
    theme: "github-dark-default",
  });
  const colors = new Set(tokens.flat().map((token) => token.color));
  expect(colors.size).toBeGreaterThan(1);
});
