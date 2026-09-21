// There is no DOM preload in this repo (see lib/shortcuts.test.ts), so
// `document.createElement` hands out stand-ins with the handful of members
// the note uses, and the body is a small tree of them. What is pinned: the
// note lands after the WHOLE block (outside the copy control's wrapper,
// never between the code and its buttons), a repeat pass does not stack a
// second one, a superseded pass adds nothing, and the version poll is asked
// to look right away.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { noteFenceLoadFailure } from "./fence-load-failure";

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  classList = {
    contains: (name: string) => this.className.split(" ").includes(name),
  };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get type() {
    return this.attributes.type ?? "";
  }
  set type(value: string) {
    this.attributes.type = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener() {}
  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  after(node: FakeElement) {
    const siblings = this.parent?.children;
    if (!siblings) throw new Error("after() on a detached node");
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
    node.parent = this.parent;
  }
  get nextElementSibling(): FakeElement | null {
    const siblings = this.parent?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  closest(selector: string): FakeElement | null {
    const name = selector.slice(1);
    for (let node: FakeElement | null = this; node; node = node.parent)
      if (node.classList.contains(name)) return node;
    return null;
  }
  contains(node: FakeElement): boolean {
    for (let cursor: FakeElement | null = node; cursor; cursor = cursor.parent)
      if (cursor === this) return true;
    return false;
  }
}

let healthProbes = 0;
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);

// The version probe is the one thing here that leaves the module: it goes
// through fetch (lib/health.ts), so counting calls to a stub pins that the
// note asked. It fails, as it would offline, and the probe swallows that.
beforeEach(() => {
  healthProbes = 0;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      hidden: false,
      createElement: (tag: string) => new FakeElement(tag),
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => {
      healthProbes++;
      return Promise.reject(new Error("offline in tests"));
    },
  });
});

function restore(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

afterEach(() => {
  restore("fetch", originalFetch);
  restore("document", originalDocument);
});

/** An element the way the module sees one; the stand-in is what runs. */
const element = (className = "") => {
  const node = document.createElement("div");
  node.className = className;
  return node;
};

const classNames = (node: Element) =>
  Array.from(node.children, (child) => child.className);

const ctx = (pre: HTMLElement, root: HTMLElement, alive = true) => ({
  pre,
  root,
  alive: () => alive,
});

describe("noteFenceLoadFailure", () => {
  test("puts a note with a refresh under the fence and probes the version", () => {
    const root = element("markdown");
    const pre = element();
    root.append(pre);
    noteFenceLoadFailure(ctx(pre, root), "The diagram renderer");
    expect(classNames(root)).toEqual(["", "md-fence-stale"]);
    const note = root.children[1]!;
    expect(note.getAttribute("role")).toBe("status");
    const [text, refresh] = Array.from(note.children);
    expect(text?.textContent).toBe(
      "The diagram renderer didn't load. Refresh to update.",
    );
    expect(refresh?.tagName).toBe("BUTTON");
    expect(refresh?.getAttribute("type")).toBe("button");
    expect(refresh?.textContent).toBe("Refresh");
    expect(healthProbes).toBe(1);
  });

  test("lands after the copy control's wrapper, not inside it", () => {
    const root = element("markdown");
    const wrap = element("md-code-wrap");
    const pre = element();
    const controls = element("md-code-controls");
    root.append(wrap);
    wrap.append(pre, controls);
    noteFenceLoadFailure(ctx(pre, root), "The artifact viewer");
    expect(Array.from(wrap.children)).toEqual([pre, controls]);
    expect(classNames(root)).toEqual(["md-code-wrap", "md-fence-stale"]);
  });

  test("does not stack a second note on a repeat pass", () => {
    const root = element("markdown");
    const pre = element();
    root.append(pre);
    noteFenceLoadFailure(ctx(pre, root), "The chart renderer");
    noteFenceLoadFailure(ctx(pre, root), "The chart renderer");
    expect(root.children).toHaveLength(2);
  });

  test("adds nothing for a superseded pass or a fence no longer in the body", () => {
    const root = element("markdown");
    const pre = element();
    root.append(pre);
    noteFenceLoadFailure(ctx(pre, root, false), "The slide deck");
    noteFenceLoadFailure(ctx(element(), root), "The slide deck");
    expect(Array.from(root.children)).toEqual([pre]);
    expect(healthProbes).toBe(0);
  });
});
