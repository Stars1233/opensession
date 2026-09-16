import { expect, test } from "bun:test";
import { agentIdentity, agentMarble } from "./agent-identity";

test("identities are deterministic across historical and current session IDs", () => {
  for (const id of [
    "os-00000000-0000-7000-8000-000000000001",
    "bks-demo-pr",
    "legacy-session",
  ]) {
    expect(agentIdentity(id)).toEqual(agentIdentity(id));
    expect(agentIdentity(id).name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(agentMarble(agentIdentity(id).seed)[0]!.color).toContain(
      "var(--chart-",
    );
    expect(JSON.stringify(agentMarble(agentIdentity(id).seed))).not.toContain(
      id,
    );
  }
  // Ordered vocabularies and hash domains are a compatibility contract.
  expect(agentIdentity("bks-demo-pr")).toMatchSnapshot();
});

test("uses the full identifier and distributes thousands of agents", () => {
  const names = new Set<string>();
  const avatars = new Set<string>();
  for (let i = 0; i < 10000; i++) {
    const identity = agentIdentity(`os-00000000-0000-7000-8000-${i}`);
    names.add(identity.name);
    avatars.add(JSON.stringify(agentMarble(identity.seed)));
  }
  expect(names.size).toBeGreaterThan(9950);
  expect(avatars.size).toBeGreaterThan(1000);
});
