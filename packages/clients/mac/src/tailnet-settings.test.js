const { describe, expect, test } = require("bun:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = readFileSync(
  path.join(__dirname, "tailnet-settings.js"),
  "utf8",
);

async function fixture(overrides = {}) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        value: "",
        checked: false,
        textContent: "",
        hidden: false,
        disabled: false,
        listeners: {},
        options: [],
        addEventListener(event, callback) {
          this.listeners[event] = callback;
        },
        replaceChildren() {
          this.options = [];
        },
        add(option) {
          this.options.push(option);
        },
        focus() {
          this.focused = !this.disabled;
        },
      });
    return elements.get(id);
  };
  const calls = { saved: [], actions: [] };
  const bridge = {
    settings: async () => ({
      activeId: "one",
      accounts: [
        { id: "one", label: "Personal", profileId: null },
        { id: "two", label: "Work", profileId: "bbbb" },
      ],
      profiles: [
        { id: "aaaa", label: "Personal", selected: true },
        { id: "bbbb", label: "Work", selected: false },
      ],
      error: null,
    }),
    save: async (...args) => {
      calls.saved.push(args);
      return { ok: true };
    },
    action: async (action) => {
      calls.actions.push(action);
      return { ok: true };
    },
    ...overrides,
  };
  const context = vm.createContext({
    Option: class {
      constructor(label, value) {
        this.label = label;
        this.value = value;
      }
    },
    document: { getElementById: get, body: get("body") },
    window: {
      os1: { tailnet: bridge },
      addEventListener: (event, callback) =>
        get("window").addEventListener(event, callback),
    },
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  return { context, get, calls };
}

describe("tailnet settings", () => {
  test("saving a profile does not connect unless explicitly checked", async () => {
    const { context, get, calls } = await fixture();
    expect(get("connect-option").hidden).toBe(true);
    expect(get("organization").focused).toBe(true);
    get("profile").value = "bbbb";
    get("profile").listeners.change();
    expect(get("connect-option").hidden).toBe(false);
    expect(get("connect-now").checked).toBe(false);
    expect(get("save").textContent).toBe("Save");
    await context.persist();
    expect(calls.saved).toEqual([["one", "bbbb", false]]);
    expect(calls.actions).toEqual(["close"]);
  });

  test("connect now labels the primary action and leaves native connection sequencing in charge", async () => {
    const { context, get, calls } = await fixture();
    get("profile").value = "bbbb";
    get("profile").listeners.change();
    get("connect-now").checked = true;
    get("connect-now").listeners.change();
    expect(get("save").textContent).toBe("Save and connect");
    await context.persist();
    expect(calls.saved).toEqual([["one", "bbbb", true]]);
    expect(calls.actions).toEqual([]);
  });

  test("changing organizations or profiles resets the connect-now choice", async () => {
    const { get } = await fixture();
    get("connect-now").checked = true;
    get("organization").value = "two";
    get("organization").listeners.change();
    expect(get("profile").value).toBe("bbbb");
    expect(get("connect-now").checked).toBe(false);
    get("connect-now").checked = true;
    get("profile").value = "";
    get("profile").listeners.change();
    expect(get("connect-now").checked).toBe(false);
    expect(get("connect-option").hidden).toBe(true);
    expect(get("save").textContent).toBe("Save");
  });

  test("close, Escape and a full backdrop click dismiss without saving", async () => {
    const { get, calls } = await fixture();
    get("close").listeners.click();
    let prevented = false;
    get("window").listeners.keydown({
      key: "Escape",
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    const body = get("body");
    body.listeners.pointerdown({ target: body });
    body.listeners.click({ target: body });
    expect(calls.actions).toEqual(["close", "close", "close"]);
    expect(calls.saved).toEqual([]);
  });

  test("inside clicks, drags out of the card, and handled Escape do not dismiss", async () => {
    const { get, calls } = await fixture();
    const body = get("body");
    body.listeners.pointerdown({ target: get("form") });
    body.listeners.click({ target: body });
    body.listeners.pointerdown({ target: body });
    body.listeners.click({ target: get("form") });
    get("window").listeners.keydown({ key: "Escape", defaultPrevented: true });
    expect(calls.actions).toEqual([]);
  });

  test("a failed save keeps the modal open and restores its controls", async () => {
    const { context, get, calls } = await fixture({
      save: async () => ({ ok: false, error: "No changes saved." }),
    });
    await context.persist();
    expect(get("status").textContent).toBe("No changes saved.");
    expect(get("save").disabled).toBe(false);
    expect(calls.actions).toEqual([]);
  });
});
