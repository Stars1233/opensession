import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPreviewSurface } from "./SessionPreviewSurface";

const STAGING_URL = "https://preview.example.test/path?record=1";
const shareLink = () => {};

test("an embeddable staging deployment renders in a browser pane", () => {
  const html = renderToStaticMarkup(
    <SessionPreviewSurface
      surface={{
        kind: "staging",
        deployment: { status: "Building", embeddable: true },
        url: STAGING_URL,
        shareLink,
      }}
    />,
  );

  expect(html).toContain("Building…");
  expect(html).toContain('aria-label="Preview environment address"');
  expect(html).toContain(`value="${STAGING_URL.replace("&", "&amp;")}"`);
  expect(html).toContain(`src="${STAGING_URL.replace("&", "&amp;")}"`);
  expect(html).toContain(
    'allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write"',
  );
  expect(html).toContain('aria-label="Copy preview link"');
  expect(html).toContain('aria-label="Reload Preview environment"');
  expect(html).toContain(
    'aria-label="Open Preview environment in a new browser tab"',
  );
});

test("a non-embeddable deployment keeps the first-party fallback", () => {
  const html = renderToStaticMarkup(
    <SessionPreviewSurface
      surface={{
        kind: "staging",
        deployment: { status: "Ready" },
        url: STAGING_URL,
        shareLink,
      }}
    />,
  );

  expect(html).not.toContain("<iframe");
  expect(html).toContain("Test this PR on real infra");
  expect(html).toContain("Open staging");
  expect(html).toContain("Copy link");
  expect(html).toContain(`href="${STAGING_URL.replace("&", "&amp;")}"`);
});

test("a backgrounded preview stays mounted but hidden", () => {
  const surface = {
    kind: "staging",
    deployment: { status: "Ready", embeddable: true },
    url: STAGING_URL,
    shareLink,
  } as const;
  const shown = renderToStaticMarkup(
    <SessionPreviewSurface surface={surface} />,
  );
  const hidden = renderToStaticMarkup(
    <SessionPreviewSurface surface={surface} hidden />,
  );

  expect(shown.startsWith('<div class="contents">')).toBe(true);
  expect(hidden.startsWith('<div class="hidden">')).toBe(true);
  expect(hidden).toContain("<iframe");
});

test("SessionViewer keeps preview frames mounted across view-tab switches", async () => {
  const viewer = await Bun.file(
    new URL("../session-viewer/SessionViewerMainRegion.tsx", import.meta.url),
  ).text();
  const kept = viewer.slice(
    viewer.indexOf("{portalTarget && (openTabs.portal || showPortal) ? ("),
    viewer.indexOf("{/* Shells keep their PTYs alive"),
  );
  const portal = kept.indexOf('kind: "portal"');
  const staging = kept.indexOf('kind: "staging"');

  expect(kept).toContain("hidden={!showPortal}");
  expect(kept).toContain("stagingUrl && (openTabs.staging || showStaging)");
  expect(kept).toContain("hidden={!showStaging}");
  expect(portal).toBeGreaterThan(-1);
  expect(staging).toBeGreaterThan(portal);
  expect(kept).toContain("deployment: staging");
  expect(kept).toContain("url: stagingUrl");
  expect(kept).toContain("shareLink,");
});
