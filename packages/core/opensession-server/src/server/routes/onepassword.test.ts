import { expect, test } from "bun:test";
import { handleOnePasswordRoutes } from "./onepassword";
import { onePasswordRequests } from "../onepassword-requests";
import type { RouteContext } from "./context";

function context(
  path: string,
  authUser: RouteContext["authUser"],
  body?: unknown,
): RouteContext {
  const url = new URL(path, "https://os.example.com");
  return {
    path: url.pathname,
    url,
    publicPrefix: "",
    authUser,
    req: new Request(
      url,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    ),
  };
}
const alice = { login: "alice", name: "Alice" };

test("Mac approval requires a real verified identity, never machine auth or a name picker", async () => {
  for (const auth of [null, undefined, { ...alice, automation: true }]) {
    const result = await handleOnePasswordRoutes(
      context("/api/onepassword/pending?sessionId=x", auth),
    );
    expect(result!.status).toBe(401);
    expect(result!.headers.get("cache-control")).toBe("no-store");
  }
});

test("routes scope intent, claim once, and reject secret-bearing results", async () => {
  const session = crypto.randomUUID();
  const r = onePasswordRequests.request(session, "alice", {
    account: "my.1password.com",
    reference: "op://Work/API/token",
    purpose: "Test",
    url: "https://api.example.com/me",
    method: "GET",
    injection: "bearer",
  });
  const pending = `/api/onepassword/pending?sessionId=${session}`;
  expect(
    await (await handleOnePasswordRoutes(
      context(pending, { login: "bob", name: "Bob" }),
    ))!.json(),
  ).toEqual({ request: null });
  const own = await (await handleOnePasswordRoutes(
    context(pending, alice),
  ))!.json();
  expect(own.request.id).toBe(r.id);
  const claimRoute = `/api/onepassword/${r.id}/claim`;
  const crossSite = context(claimRoute, alice, {});
  crossSite.req.headers.set("origin", "https://evil.example.com");
  expect((await handleOnePasswordRoutes(crossSite))!.status).toBe(403);
  const claim = await (await handleOnePasswordRoutes(
    context(claimRoute, alice, {}),
  ))!.json();
  expect(
    (await handleOnePasswordRoutes(context(claimRoute, alice, {})))!.status,
  ).toBe(409);
  const complete = `/api/onepassword/${r.id}/complete`;
  expect(
    (await handleOnePasswordRoutes(
      context(complete, alice, {
        claim: claim.claim,
        outcome: { status: "failed", error: "SECRET" },
      }),
    ))!.status,
  ).toBe(400);
  expect(
    (await handleOnePasswordRoutes(
      context(complete, alice, {
        claim: claim.claim,
        outcome: { status: "completed", httpStatus: 204 },
      }),
    ))!.status,
  ).toBe(200);
  expect(onePasswordRequests.status(r.id, session, "alice")!.httpStatus).toBe(
    204,
  );
});
