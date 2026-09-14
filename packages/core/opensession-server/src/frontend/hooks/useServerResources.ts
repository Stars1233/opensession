import { useEffect, useState } from "react";
import {
  RESOURCE_SAMPLE_MS,
  serverResourcesSchema,
  type ServerResources,
} from "../../shared/server-resources";
import { request } from "../lib/api/request";

type ResourceState =
  | { kind: "loading" }
  | { kind: "ready"; data: ServerResources }
  | { kind: "unavailable" };

export function useServerResources() {
  const [state, setState] = useState<ResourceState>({ kind: "loading" });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: AbortController | null = null;
    async function poll() {
      if (stopped || document.hidden || pending) return;
      const controller = new AbortController();
      pending = controller;
      try {
        const data = serverResourcesSchema.parse(
          await request<unknown>("/system/resources", {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(8_000),
            ]),
            label: "Server metrics unavailable",
          }),
        );
        if (!controller.signal.aborted) setState({ kind: "ready", data });
      } catch {
        if (!controller.signal.aborted) setState({ kind: "unavailable" });
      }
      pending = null;
      if (!stopped && !document.hidden)
        timer = setTimeout(poll, RESOURCE_SAMPLE_MS);
    }
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) pending?.abort();
      else {
        // Do not present the pre-background snapshot as a live reading.
        setState({ kind: "loading" });
        void poll();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      pending?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return state;
}
