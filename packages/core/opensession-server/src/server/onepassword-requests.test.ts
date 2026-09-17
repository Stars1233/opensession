import { describe, expect, test } from "bun:test";
import {
  OnePasswordRequests,
  onePasswordRequestSchema,
} from "./onepassword-requests";

const intent = {
  account: "my.1password.com",
  reference: "op://Work/Service/token",
  purpose: "Check service authentication",
  url: "https://api.example.com/me",
  method: "GET",
  injection: "bearer",
};

describe("single-field 1Password requests", () => {
  test("requires exactly one field, never a vault, whole item, query, or wildcard", () => {
    for (const reference of [
      "op://Work",
      "op://Work/Service",
      "op://Work/Service/*",
      "op://Work/Service/token?attribute=type",
      "op://Work/Service/token/extra/more",
      "op://Work/Service/%2a",
      "op://Work/Service/token\nother",
    ]) {
      expect(
        onePasswordRequestSchema.safeParse({ ...intent, reference }).success,
      ).toBe(false);
    }
    for (const reference of [
      intent.reference,
      "op://Work/Service/section/token",
      "op://Work vault/Service API/token",
    ]) {
      expect(
        onePasswordRequestSchema.safeParse({ ...intent, reference }).success,
      ).toBe(true);
    }
    expect(
      onePasswordRequestSchema.safeParse({ ...intent, secret: "NEVER" })
        .success,
    ).toBe(false);
  });

  test("rejects unsafe intent before asking", () => {
    for (const url of [
      "not-a-url",
      "http://api.example.com",
      "https://u:p@api.example.com",
      "https://api.example.com:123/a",
      "https://api.example.com/#fragment",
    ]) {
      expect(
        onePasswordRequestSchema.safeParse({ ...intent, url }).success,
      ).toBe(false);
    }
    for (const extra of [
      { account: "--debug" },
      { method: "CONNECT" },
      { body: "x" },
      { injection: "cookie" },
      { purpose: "trusted\u202eevil" },
    ]) {
      expect(
        onePasswordRequestSchema.safeParse({ ...intent, ...extra }).success,
      ).toBe(false);
    }
  });

  test("binds metadata, claims and results to the session and verified login", () => {
    const requests = new OnePasswordRequests();
    const r = requests.request("session-a", "Alice", intent);
    expect(requests.status(r.id, "session-b", "alice")).toBeNull();
    expect(requests.status(r.id, "session-a", "bob")).toBeNull();
    expect(requests.pending("session-a", "bob")).toBeNull();
    expect(requests.claim(r.id, "bob")).toBeNull();
    const pending = requests.pending("session-a", "alice")!;
    pending.intent.url = "https://wrong.example.com";
    expect(requests.pending("session-a", "alice")!.intent.url).toBe(intent.url);
    const claim = requests.claim(r.id, "alice")!;
    expect(requests.claim(r.id, "alice")).toBeNull();
    expect(
      requests.finish(r.id, "bob", claim.claim, {
        status: "completed",
        httpStatus: 200,
      }),
    ).toBe(false);
    expect(
      requests.finish(r.id, "alice", "wrong", {
        status: "completed",
        httpStatus: 200,
      }),
    ).toBe(false);
    expect(
      requests.finish(r.id, "alice", claim.claim, {
        status: "completed",
        httpStatus: 200,
      }),
    ).toBe(true);
    expect(
      requests.finish(r.id, "alice", claim.claim, {
        status: "completed",
        httpStatus: 200,
      }),
    ).toBe(false);
    expect(requests.status(r.id, "session-a", "alice")).toEqual({
      id: r.id,
      status: "completed",
      httpStatus: 200,
      expiresAt: r.expiresAt,
    });
  });

  test("rejects all free-form output and never projects a claim into model results", () => {
    const requests = new OnePasswordRequests();
    const r = requests.request("session", "alice", intent);
    const { claim } = requests.claim(r.id, "alice")!;
    for (const outcome of [
      { status: "completed", httpStatus: 200, body: "SECRET" },
      { status: "completed", httpStatus: 200, headers: { secret: "SECRET" } },
      { status: "failed", error: "SECRET" },
      { status: "SECRET" },
      { status: "completed", httpStatus: "SECRET" },
    ])
      expect(requests.finish(r.id, "alice", claim, outcome)).toBe(false);
    expect(
      JSON.stringify(requests.status(r.id, "session", "alice")),
    ).not.toContain(claim);
    expect(requests.finish(r.id, "alice", claim, { status: "failed" })).toBe(
      true,
    );
    expect(requests.claim(r.id, "alice")).toBeNull();
  });

  test("expires, bounds pending asks, and loses all authority on restart", () => {
    let now = 1000;
    const requests = new OnePasswordRequests(() => now);
    const r = requests.request("session", "alice", intent);
    expect(() => requests.request("session", "alice", intent)).toThrow();
    now += 10 * 60_000;
    expect(requests.claim(r.id, "alice")).toBeNull();
    expect(requests.status(r.id, "session", "alice")).toBeNull();
    requests.request("session", "alice", intent);
    expect(new OnePasswordRequests().pending("session", "alice")).toBeNull();
  });
});
