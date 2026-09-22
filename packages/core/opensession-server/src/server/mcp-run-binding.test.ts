import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { createMcpRuntime, type McpRuntime } from "./mcp-runtime";
import { createPiMcpBridge } from "./pi-mcp-bridge";
import { toolsCacheKey, writeCachedTools } from "./mcp-tools-cache";
import {
  dispatchRunRpc,
  registerInteractiveMcpBuilder,
  registerRunToken,
  unregisterRunToken,
} from "./run-rpc";

let dir: string;
let rpc: ReturnType<typeof Bun.serve>;
let runtime: McpRuntime | undefined;
let token: string;
let previousState: string | undefined;
let previousCache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-run-binding-"));
  previousState = process.env.OPENSESSION_STATE_DIR;
  previousCache = process.env.OPENSESSION_MCP_TOOLS_CACHE;
  process.env.OPENSESSION_STATE_DIR = dir;
  process.env.OPENSESSION_MCP_TOOLS_CACHE = "1";
  token = crypto.randomUUID();
  registerRunToken(token, { sessionId: "restricted-run" });
  rpc = Bun.serve({
    unix: join(dir, "rpc.sock"),
    async fetch(req) {
      const dispatched = await dispatchRunRpc(
        new URL(req.url).pathname,
        await req.json(),
      );
      return dispatched.kind === "immediate"
        ? Response.json(dispatched.body, { status: dispatched.status })
        : Response.json(await dispatched.done);
    },
  });
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  rpc.stop(true);
  unregisterRunToken(token);
  registerInteractiveMcpBuilder(() => ({}));
  if (previousState === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousState;
  if (previousCache === undefined)
    delete process.env.OPENSESSION_MCP_TOOLS_CACHE;
  else process.env.OPENSESSION_MCP_TOOLS_CACHE = previousCache;
  rmSync(dir, { recursive: true, force: true });
});

async function bridgeWithStaleCatalog() {
  const proxy = {
    command: process.execPath,
    args: [join(import.meta.dir, "../runner-host/mcp-proxy.ts")],
    env: {
      OPENSESSION_RPC_SOCKET: join(dir, "rpc.sock"),
      OPENSESSION_MCP_SERVER: "opensession-sessions",
    },
  };
  // Previous versions shared this token-independent cache across runs with
  // different server bindings and different shapes of the same server.
  writeCachedTools("opensession-sessions", toolsCacheKey(proxy), [
    {
      name: "create_session",
      description: "Create a visible session",
      inputSchema: { type: "object", properties: {} },
    },
  ]);
  runtime = await createMcpRuntime({
    mcpServers: [],
    deniedToolIds: new Set(["opensession-sessions_cancel_task"]),
    legacyProxyMcp: {
      configs: {
        "opensession-sessions": {
          ...proxy,
          env: { ...proxy.env, OPENSESSION_RPC_TOKEN: token },
        },
      },
    },
    callTimeoutMs: 5_000,
  });
  const bridge = await createPiMcpBridge(runtime);
  const search = bridge.discoveryTools.find(
    (tool) => tool.name === "mcp_search",
  )!;
  const call = bridge.discoveryTools.find((tool) => tool.name === "mcp_call")!;
  return {
    search: (query: string) =>
      search.execute("search", { query }, undefined, undefined, {} as any),
    call: (name: string) =>
      call.execute(
        "call",
        { name, arguments: {} },
        undefined,
        undefined,
        {} as any,
      ),
  };
}

test("unbound proxy tools are absent from search and direct calls name the server and binding reason", async () => {
  registerInteractiveMcpBuilder(() => ({}));
  const bridge = await bridgeWithStaleCatalog();
  const searched = await bridge.search("create visible session");
  expect(searched.content).toEqual([
    {
      type: "text",
      text: expect.stringContaining("No permitted MCP tools matched"),
    },
  ]);
  await expect(
    bridge.call("opensession-sessions_create_session"),
  ).rejects.toThrow(
    /MCP server "opensession-sessions" is not available.*not bound/,
  );
  // A caller bypassing discovery reaches the same authoritative RPC check.
  expect(
    await dispatchRunRpc("/mcp/call", {
      token,
      server: "opensession-sessions",
      tool: "create_session",
      args: {},
    }),
  ).toMatchObject({
    kind: "immediate",
    status: 404,
    body: {
      error: expect.stringMatching(
        /MCP server "opensession-sessions" is not available.*MCP policy/,
      ),
    },
  });
  await expect(bridge.call("unbound-server_echo")).rejects.toThrow(
    'MCP server "unbound-server" is not available in this session: not bound for this run.',
  );
});

test("a scoped proxy lists only this run's tools, ignoring an unrestricted cached catalog", async () => {
  registerInteractiveMcpBuilder(() => ({
    "opensession-sessions": createSdkMcpServer({
      name: "opensession-sessions",
      tools: [
        tool("task_status", "Read task status", {}, async () => ({
          content: [{ type: "text", text: "idle" }],
        })),
        tool("cancel_task", "Cancel task", {}, async () => ({ content: [] })),
      ],
    }),
  }));
  const bridge = await bridgeWithStaleCatalog();
  const searched = JSON.stringify((await bridge.search("session")).content);
  expect(searched).toContain("opensession-sessions_task_status");
  expect(searched).not.toContain("create_session");
  expect(searched).not.toContain("cancel_task");
  expect(
    (await bridge.call("opensession-sessions_task_status")).content,
  ).toEqual([{ type: "text", text: "idle" }]);
  await expect(
    bridge.call("opensession-sessions_create_session"),
  ).rejects.toThrow(
    'MCP tool "create_session" not found on server "opensession-sessions".',
  );
  await expect(bridge.call("opensession-sessions_cancel_task")).rejects.toThrow(
    "not permitted by this run's tool policy",
  );
});
