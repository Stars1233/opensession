import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  applyCredentialRegistrationFrame,
  credentialRegistrationFor,
  subscribeCredentialRegistration,
} from "./credential-registration-store";

const request = {
  id: "r1",
  service: "acme-prod",
  host: "api.example.test",
  owner: "Alex",
  requestedAt: 1,
  expiresAt: 2,
};
let calls: string[] = [];
let reply = { request, canAnswer: true };
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  calls = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0]) => {
        calls.push(String(url));
        return Response.json(reply);
      },
      { preconnect() {} },
    ),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
});
const tick = () => new Promise((r) => setTimeout(r, 0));

test("loads once per viewer, follows frames, and survives a resubscribe", async () => {
  let notified = 0;
  const off = subscribeCredentialRegistration("s1", () => notified++);
  await tick();
  expect(calls).toHaveLength(1);
  expect(credentialRegistrationFor("s1")).toEqual({ request, canAnswer: true });

  // A render that swaps the subscribe function must not refetch.
  off();
  const off2 = subscribeCredentialRegistration("s1", () => notified++);
  await tick();
  expect(calls).toHaveLength(1);

  applyCredentialRegistrationFrame({
    type: "credential_registration_resolved",
    sessionId: "s1",
    requestId: "r1",
    status: "registered",
  });
  expect(credentialRegistrationFor("s1")).toBeNull();

  reply = { request: { ...request, id: "r2" }, canAnswer: false };
  applyCredentialRegistrationFrame({
    type: "credential_registration_request",
    sessionId: "s1",
    credentialRequest: { ...request, id: "r2" },
  });
  await tick();
  expect(calls).toHaveLength(2);
  expect(credentialRegistrationFor("s1")?.canAnswer).toBe(false);
  expect(notified).toBeGreaterThan(1);

  off2();
  await tick();
  expect(credentialRegistrationFor("s1")).toBeNull();
  // Frames for sessions nobody watches are ignored.
  applyCredentialRegistrationFrame({
    type: "credential_registration_request",
    sessionId: "s1",
    credentialRequest: request,
  });
  expect(calls).toHaveLength(2);
});
