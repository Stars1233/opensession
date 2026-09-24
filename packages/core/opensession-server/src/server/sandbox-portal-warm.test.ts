import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { portalWarmRoutes, portalWarmScript } from "./sandbox-portal-warm";

const scratch = mkdtempSync(join(tmpdir(), "portal-warm-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("portal warm routes", () => {
  test("uses the repository's declared routes, deduplicated", () => {
    expect(
      portalWarmRoutes(
        JSON.stringify({
          warmRoutes: ["/videos", "/video/warmup/edit", "/videos", 3],
        }),
      ),
    ).toEqual(["/videos", "/video/warmup/edit"]);
  });

  test("falls back to the Portal's default path, then /", () => {
    expect(portalWarmRoutes(null, "/videos?direct=true")).toEqual([
      "/videos?direct=true",
    ]);
    expect(portalWarmRoutes("not json")).toEqual(["/"]);
    expect(portalWarmRoutes(JSON.stringify({ warmRoutes: [] }))).toEqual([]);
  });

  test("refuses anything that is not a plain path", () => {
    expect(
      portalWarmRoutes(
        JSON.stringify({
          warmRoutes: ["http://evil.test/", "/a b", "/$(id)", "videos", "/ok"],
        }),
      ),
    ).toEqual(["/ok"]);
  });
});

describe("portal warm script", () => {
  test("requests each route with the Portal's Host, then the page's assets", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        seen.push(`${request.headers.get("host")} ${url.pathname}`);
        if (url.pathname === "/videos")
          return new Response(
            `<script src="/_next/static/chunks/a.js"></script><link href="/_next/static/chunks/b.css"><script src='/_next/static/chunks/a.js'></script>`,
            { headers: { "content-type": "text/html" } },
          );
        return new Response("ok");
      },
    });
    try {
      const logPath = join(scratch, "warm.log");
      const script = portalWarmScript({
        port: server.port!,
        host: "portal.example.test:21000",
        routes: ["/videos", "/video/warmup/edit"],
        logPath,
      });
      const run = Bun.spawn(["bash", "-c", script]);
      expect(await run.exited).toBe(0);
      const log = readFileSync(logPath, "utf8");
      expect(log).toContain("/videos 200");
      expect(log).toContain("/video/warmup/edit 200");
      expect(log.trim().endsWith("done")).toBe(true);
      expect(
        seen.every((line) => line.startsWith("portal.example.test:21000 ")),
      ).toBe(true);
      const paths = seen.map((line) => line.split(" ")[1]);
      expect(paths[0]).toBe("/videos");
      expect(
        paths.filter((p) => p === "/_next/static/chunks/a.js"),
      ).toHaveLength(1);
      expect(paths).toContain("/_next/static/chunks/b.css");
      expect(paths.at(-1)).toBe("/video/warmup/edit");
    } finally {
      server.stop(true);
    }
  });

  test("skips when the app is not listening, a finished warm-up is on record, or one is running", async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hits += 1;
        return new Response("ok");
      },
    });
    const run = async (script: string) =>
      await Bun.spawn(["bash", "-c", script]).exited;
    try {
      const logPath = join(scratch, "skip.log");
      const opts = { host: "h.example.test:1", routes: ["/a"], logPath };
      // Nothing listens on this port: no log, no requests.
      const idle = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      });
      const deadPort = idle.port!;
      idle.stop(true);
      expect(await run(portalWarmScript({ ...opts, port: deadPort }))).toBe(0);
      expect(existsSync(logPath)).toBe(false);
      // A finished warm-up is left alone on a rebuild...
      writeFileSync(logPath, "/a 200 0.1s\ndone\n");
      expect(
        await run(
          portalWarmScript({ ...opts, port: server.port!, skipIfWarm: true }),
        ),
      ).toBe(0);
      expect(hits).toBe(0);
      // ...and so is a Portal another warm-up is already working on.
      mkdirSync(`${logPath}.lock`);
      expect(await run(portalWarmScript({ ...opts, port: server.port! }))).toBe(
        0,
      );
      expect(hits).toBe(0);
      rmSync(`${logPath}.lock`, { recursive: true });
      // A fresh start warms again and releases the lock.
      expect(await run(portalWarmScript({ ...opts, port: server.port! }))).toBe(
        0,
      );
      expect(hits).toBe(1);
      expect(existsSync(`${logPath}.lock`)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
