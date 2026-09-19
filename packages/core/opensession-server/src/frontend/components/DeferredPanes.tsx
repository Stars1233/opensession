import React from "react";
import { deferred } from "./deferred";

/*
 * The route panes AppContent mounts, each loaded the first time it is opened
 * instead of at boot. Everything but onboarding shares one chunk (panes.ts):
 * a chunk per pane multiplied the shared chunks the entry preloads (17 became
 * 91), and once a person opens one pane the rest are a click away, so they
 * fetch together and cache once. Onboarding is its own chunk: it is seen once
 * per install and never again.
 */
export const FirstMile = deferred(() =>
  import("./FirstMile").then((m) => m.FirstMile),
);

type Panes = typeof import("./panes");

function pane<K extends keyof Panes>(name: K): Panes[K] {
  // SAFETY: every export of panes.ts is a function component, so each one
  // accepts `never` as its props; the loader only forwards whatever props the
  // caller passed.
  const Pane = deferred<never>(() =>
    import("./panes").then((m) => m[name] as React.ComponentType<never>),
  );
  // SAFETY: Deferred renders m[name] with the props it receives unchanged, so
  // it takes exactly the props of Panes[K]; call sites type-check against the
  // real component.
  return Pane as Panes[K];
}

export const Analytics = pane("Analytics");
export const Archived = pane("Archived");
export const Automations = pane("Automations");
export const CatchUpDeck = pane("CatchUpDeck");
export const Databases = pane("Databases");
export const Feed = pane("Feed");
export const Goals = pane("Goals");
export const Issues = pane("Issues");
export const Prs = pane("Prs");
export const Reports = pane("Reports");
export const Reviews = pane("Reviews");
export const Security = pane("Security");
export const SupportInbox = pane("SupportInbox");
export const SupportPreview = pane("SupportPreview");
export const SupportTinder = pane("SupportTinder");
export const Tasks = pane("Tasks");
export const WorkspacePane = pane("WorkspacePane");
