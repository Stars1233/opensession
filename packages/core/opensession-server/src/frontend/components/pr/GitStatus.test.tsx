import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrDetails } from "../../lib/types";
import { GitStatusRows } from "./GitStatus";

// SAFETY: GitStatusRows only reads the fields set here; the rest of
// PrDetails is irrelevant to the status row under test.
const pr = (over: Partial<PrDetails>) =>
  ({
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "Example",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    checks: [],
    ...over,
  }) as PrDetails;

const render = (details: PrDetails) =>
  renderToStaticMarkup(
    <GitStatusRows
      git={null}
      pr={details}
      sessionId="s1"
      onRefresh={() => {}}
      onMerge={() => {}}
      onMarkReady={() => {}}
    />,
  );

test("a draft PR offers Ready for review instead of Merge", () => {
  const html = render(pr({ isDraft: true }));
  expect(html).toContain("Ready for review");
  expect(html).not.toContain(">Merge<");
});

test("a ready PR offers Merge, not Ready for review", () => {
  const html = render(pr({ isDraft: false }));
  expect(html).toContain(">Merge<");
  expect(html).not.toContain("Ready for review");
});
