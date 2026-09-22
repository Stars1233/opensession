/**
 * A Tella share link, in any of the forms Tella hands out: the pretty link
 * (`/video/<slug>-<id>`), the share page (`/video/<id>/view`) and the embed
 * URL (`/video/<id>/embed`). Every one of them answers as a player at
 * `/video/<segment>/embed`, which is what the transcript frames in place of
 * a bare link (markdown.ts). Only the embed form keeps its query: those are
 * player options someone copied from Tella's embed code, while a view or
 * pretty link's query is share-page state the player has no use for.
 */
const TELLA_HOSTS = new Set(["tella.tv", "www.tella.tv"]);
const TELLA_VIDEO_PATH =
  /^\/video\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/(view|embed))?\/?$/;

export interface TellaVideoEmbed {
  /** The path segment naming the video: one per video, whatever the form. */
  id: string;
  /** The player page, to be framed. */
  src: string;
  /** The link as written minus its scheme: what a caption reads. */
  label: string;
}

export function tellaVideoEmbed(href: string): TellaVideoEmbed | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !TELLA_HOSTS.has(url.hostname)) return null;
  const match = TELLA_VIDEO_PATH.exec(url.pathname);
  if (!match) return null;
  const query = match[2] === "embed" ? url.search : "";
  return {
    id: match[1],
    src: `https://www.tella.tv/video/${match[1]}/embed${query}`,
    label: `${url.host}${url.pathname}`,
  };
}
