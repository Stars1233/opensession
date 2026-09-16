const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = readFileSync(path.join(__dirname, "server-picker.js"), "utf8");

async function fixture(overrides = {}) {
  const elements = new Map();
  for (const id of [
    "organization",
    "url",
    "host",
    "submit",
    "anyway",
    "status",
    "form",
    "cancel",
  ]) {
    elements.set(id, {
      value: "",
      textContent: "",
      hidden: false,
      disabled: false,
      options: [],
      listeners: {},
      addEventListener(type, callback) {
        this.listeners[type] = callback;
      },
      replaceChildren() {
        this.options = [];
      },
      add(option) {
        this.options.push(option);
      },
      focus() {},
    });
  }
  const calls = { switched: [], added: [], cancelled: 0 };
  const bridge = {
    list: async () => ({
      activeId: "one",
      accounts: [
        { id: "one", label: "Work", url: "https://work.example.test/" },
        { id: "two", label: "Personal", url: "https://personal.example.test/" },
      ],
    }),
    switch: (id) => calls.switched.push(id),
    add: async (...args) => {
      calls.added.push(args);
      return { ok: true };
    },
    ...overrides,
  };
  const context = vm.createContext({
    URL,
    Option: class {
      constructor(label, value) {
        this.label = label;
        this.value = value;
      }
    },
    document: { getElementById: (id) => elements.get(id) },
    window: {
      os1: {
        organizations: bridge,
        server: { cancel: () => calls.cancelled++ },
      },
      addEventListener() {},
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  return { context, calls, bridge, get: (id) => elements.get(id) };
}

describe("offline organization picker", () => {
  test("lists saved organizations and an explicit add option without probing", async () => {
    const { get, calls } = await fixture();
    expect(get("organization").options.map((option) => option.value)).toEqual([
      "one",
      "two",
      "",
    ]);
    expect(get("organization").options[2].label).toBe("Add organization…");
    expect(get("organization").value).toBe("one");
    expect(get("url").hidden).toBe(true);
    expect(get("host").textContent).toBe("work.example.test");
    expect(calls.added).toEqual([]);
    expect(calls.switched).toEqual([]);
  });

  test("switches by saved ID and stays usable after native recovery is dismissed", async () => {
    const { context, get, calls } = await fixture();
    get("organization").value = "two";
    context.selectOrganization();
    await context.connect(true);
    expect(calls.switched).toEqual(["two"]);
    expect(calls.added).toEqual([]);
    expect(get("submit").disabled).toBe(false);
    expect(get("url").hidden).toBe(true);
  });

  test("adding checks the new URL and offers add-anyway only after a reachability failure", async () => {
    const { context, get, calls, bridge } = await fixture();
    bridge.add = async (...args) => {
      calls.added.push(args);
      return args[1]
        ? {
            ok: false,
            error: "Server unavailable",
            canAddAnyway: true,
            url: "https://new.example.test/",
          }
        : { ok: true };
    };
    get("organization").value = "";
    context.selectOrganization();
    expect(get("url").hidden).toBe(false);
    expect(get("host").hidden).toBe(true);
    expect(get("submit").textContent).toBe("Add and connect");
    get("url").value = "new.example.test";
    await context.connect(true);
    expect(get("anyway").hidden).toBe(false);
    expect(get("url").value).toBe("https://new.example.test/");
    await context.connect(false);
    expect(calls.added).toEqual([
      ["new.example.test", true, true],
      ["https://new.example.test/", false, true],
    ]);
    expect(calls.switched).toEqual([]);
  });

  test("editing a failed address clears the stale add-anyway action", async () => {
    const { get } = await fixture();
    get("anyway").hidden = false;
    get("status").textContent = "Previous error";
    get("url").listeners.input();
    expect(get("anyway").hidden).toBe(true);
    expect(get("status").textContent).toBe("");
  });

  test("does not offer add-anyway for an existing organization or invalid address", async () => {
    const { context, get } = await fixture({
      add: async () => ({ ok: false, error: "Already added" }),
    });
    get("organization").value = "";
    context.selectOrganization();
    get("url").value = "work.example.test";
    await context.connect(true);
    expect(get("status").textContent).toBe("Already added");
    expect(get("anyway").hidden).toBe(true);
  });

  test("leaves cancellation available if the list cannot be loaded", async () => {
    const { get, calls } = await fixture({ list: async () => null });
    expect(get("status").textContent).toContain(
      "Couldn't read saved organizations",
    );
    get("cancel").listeners.click();
    expect(calls.cancelled).toBe(1);
    expect(calls.switched).toEqual([]);
  });
});
