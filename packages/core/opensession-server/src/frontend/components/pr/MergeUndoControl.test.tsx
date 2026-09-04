import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MergeUndoControl } from "./MergeUndoControl";

test("renders one icon-only undo button", () => {
  const html = renderToStaticMarkup(
    <MergeUndoControl onUndo={() => undefined} />,
  );
  expect(html).toContain('aria-label="Undo merge"');
  expect(html).not.toContain("PR merged");
  expect(html.match(/<button/g)).toHaveLength(1);
});
