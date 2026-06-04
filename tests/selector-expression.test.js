const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundPath = path.join(__dirname, "..", "src", "background.js");
const backgroundSource = fs.readFileSync(backgroundPath, "utf8");

class FakeElement {
  constructor(tagName, attrs = {}, text = "") {
    this.tagName = String(tagName).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.ownText = text;
    this.value = attrs.value || "";
    this.isContentEditable = false;
    this.clicked = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    const root = this.getRoot();
    if (root && typeof root.__notifyMutation === "function") {
      root.__notifyMutation({ type: "childList", target: this, addedNodes: children });
    }
    return this;
  }

  get id() {
    return this.attrs.id || "";
  }

  get className() {
    return this.attrs.class || "";
  }

  get textContent() {
    return [this.ownText, ...this.children.map((child) => child.textContent)].filter(Boolean).join("");
  }

  set textContent(value) {
    this.ownText = String(value ?? "");
    const root = this.getRoot();
    if (root && typeof root.__notifyMutation === "function") {
      root.__notifyMutation({ type: "characterData", target: this });
    }
  }

  get innerText() {
    return this.textContent;
  }

  set innerText(value) {
    this.ownText = String(value ?? "");
  }

  getAttribute(name) {
    return this.attrs[name] || null;
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  matches(selector) {
    const item = String(selector || "").trim();
    if (!item) return false;
    if (item === "*") return true;
    if (item.startsWith("#")) return this.id === item.slice(1);
    if (item.startsWith(".")) return this.className.split(/\s+/).includes(item.slice(1));
    return this.tagName.toLowerCase() === item.toLowerCase();
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  compareDocumentPosition(other) {
    const all = this.getRoot().querySelectorAll("*");
    const a = all.indexOf(this);
    const b = all.indexOf(other);
    if (a > b) return Node.DOCUMENT_POSITION_PRECEDING;
    if (a < b) return Node.DOCUMENT_POSITION_FOLLOWING;
    return 0;
  }

  getRoot() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node.ownerDocument || node;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0 };
  }

  scrollIntoView() {}
  focus() {}
  click() { this.clicked = true; }
}

class FakeDocument {
  constructor(body) {
    this.__observers = new Set();
    this.body = body;
    this.documentElement = new FakeElement("html").append(body);
    this.documentElement.ownerDocument = this;
  }

  querySelectorAll(selector) {
    const item = String(selector || "").trim();
    if (item === "*") {
      const all = [];
      const visit = (node) => {
        all.push(node);
        node.children.forEach(visit);
      };
      visit(this.documentElement);
      return all;
    }

    const results = [];
    if (this.documentElement.matches(selector)) results.push(this.documentElement);
    results.push(...this.documentElement.querySelectorAll(selector));
    return results;
  }

  __notifyMutation(record) {
    for (const observer of this.__observers) {
      observer.__notify(record);
    }
  }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.document = null;
    this.active = false;
  }

  observe(target) {
    const root = typeof target?.getRoot === "function" ? target.getRoot() : target?.ownerDocument || target;
    this.document = root instanceof FakeDocument ? root : global.document;
    this.active = true;
    this.document.__observers.add(this);
  }

  disconnect() {
    if (this.document) this.document.__observers.delete(this);
    this.active = false;
    this.document = null;
  }

  __notify(record) {
    if (!this.active) return;
    setTimeout(() => this.callback([record], this), 0);
  }
}

global.Node = { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 };
global.Element = FakeElement;
global.Document = FakeDocument;
global.MutationObserver = FakeMutationObserver;
global.window = { innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1, scrollX: 0, scrollY: 0 };

function createChromeMock() {
  const addListener = () => {};
  return {
    tabs: { onRemoved: { addListener }, query: async () => [], get: async () => ({}) },
    runtime: { onStartup: { addListener }, onMessage: { addListener }, lastError: null },
    debugger: { onDetach: { addListener }, onEvent: { addListener }, attach: async () => {}, sendCommand: async () => ({}) },
    storage: { local: {}, sync: {} },
  };
}

const sandbox = {
  chrome: createChromeMock(),
  console,
  URL,
  setTimeout,
  clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(`${backgroundSource}\nObject.assign(globalThis, { hasElementTarget, buildFindAndActExpression, buildGetElementCoordinatesExpression, buildWaitForElementExpression });`, sandbox);

function setDocument(body) {
  global.document = new FakeDocument(body);
}

function evaluateExpression(expression, options = {}) {
  return vm.runInNewContext(expression, {
    document: global.document,
    window: global.window,
    Element: FakeElement,
    Document: FakeDocument,
    Node: global.Node,
    Number,
    Array,
    Set,
    Map,
    String,
    Object,
    HTMLInputElement: FakeElement,
    HTMLSelectElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    Event: class Event {},
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MutationObserver: options.disableMutationObserver ? undefined : FakeMutationObserver,
  });
}

async function run() {
  assert.equal(sandbox.hasElementTarget({ AND: [] }, ""), true, "selector expression object should be recognized");
  assert.equal(sandbox.hasElementTarget("", { AND: ["Submit"] }), true, "selectorText expression object should be recognized");

  setDocument(new FakeElement("body").append(
    new FakeElement("button", { id: "one", class: "primary" }, "One"),
    new FakeElement("button", { id: "two", class: "secondary" }, "Two"),
  ));
  let result = await evaluateExpression(sandbox.buildWaitForElementExpression({ selector: ["#one", "#two"], selectorText: "" }));
  assert.equal(result.ok, true, "array selector OR compatibility should find an element");
  assert.equal(result.candidates, 2, "array selector should keep OR semantics");

  const shared = new FakeElement("section", { id: "shared" }).append(
    new FakeElement("span", { class: "left" }, "Left"),
    new FakeElement("span", { class: "right" }, "Right"),
  );
  setDocument(new FakeElement("body").append(new FakeElement("main").append(shared)));
  result = await evaluateExpression(sandbox.buildFindAndActExpression({ action: "click", selector: { AND: [".left", ".right"] }, selectorText: "", value: "", afterFoundMs: 0 }));
  assert.equal(result.ok, true, "selector.AND should return common smallest container");
  assert.equal(shared.clicked, true, "selector.AND should click the shared container");

  const inContainer = new FakeElement("button", { class: "final" }, "Inside");
  const outContainer = new FakeElement("button", { class: "final" }, "Outside");
  setDocument(new FakeElement("body").append(
    new FakeElement("section", { id: "box" }).append(
      new FakeElement("span", { class: "marker" }, "Marker"),
      new FakeElement("span", { class: "anchor" }, "Anchor"),
      inContainer,
    ),
    outContainer,
  ));
  result = await evaluateExpression(sandbox.buildFindAndActExpression({ action: "click", selector: { AND: [".marker", ".anchor"], final: ".final" }, selectorText: "", value: "", afterFoundMs: 0 }));
  assert.equal(result.ok, true, "selector.final should find inside scoped container");
  assert.equal(inContainer.clicked, true, "selector.final should be limited inside container");
  assert.equal(outContainer.clicked, false, "selector.final should not use outside matches");

  const finalText = new FakeElement("button", {}, "GoButton");
  const outsideText = new FakeElement("button", {}, "GoButton");
  const textSection = new FakeElement("section").append(new FakeElement("span", {}, "Alpha"), new FakeElement("span", {}, "Beta"), finalText);
  setDocument(new FakeElement("body").append(
    textSection,
    outsideText,
  ));
  result = await evaluateExpression(sandbox.buildFindAndActExpression({ action: "click", selector: "", selectorText: { AND: ["Alpha", "Beta"], final: "GoButton" }, value: "", afterFoundMs: 0 }));
  assert.equal(result.ok, true, "selectorText.AND+final should find final text");
  assert.equal(finalText.clicked, true, "selectorText.final should be scoped to AND container");
  assert.equal(outsideText.clicked, false, "selectorText.final should ignore outside text");

  const exactText = new FakeElement("button", { id: "exact" }, "Login");
  const containsText = new FakeElement("span", { id: "contains" }, "Login now");
  setDocument(new FakeElement("body").append(containsText, exactText));
  result = await evaluateExpression(sandbox.buildFindAndActExpression({ action: "click", selector: "", selectorText: "Login", value: "", afterFoundMs: 0 }));
  assert.equal(result.ok, true, "plain selectorText should keep text match ranking");
  assert.equal(exactText.clicked, true, "plain selectorText should prefer exact match over earlier contains match");
  assert.equal(containsText.clicked, false, "plain selectorText should not click earlier contains match when exact match exists");

  const scopedButton = new FakeElement("button", { class: "action" }, "Submit");
  const scopedCard = new FakeElement("section", { class: "card" }).append(new FakeElement("span", {}, "Item A"), scopedButton);
  const unscopedCard = new FakeElement("section", { class: "card" }).append(new FakeElement("span", {}, "Other"), new FakeElement("button", { class: "action" }, "Submit"));
  setDocument(new FakeElement("body").append(scopedCard));
  setDocument(new FakeElement("body").append(unscopedCard, scopedCard));
  result = await evaluateExpression(sandbox.buildFindAndActExpression({ action: "click", selector: ".card", selectorText: { AND: ["Item A"], final: "Submit" }, value: "", afterFoundMs: 0 }));
  assert.equal(result.ok, true, "selector + selectorText object should filter selector candidates");
  assert.equal(scopedCard.clicked, true, "selector + selectorText object should keep selector candidate as operation target");
  assert.equal(unscopedCard.clicked, false, "selectorText object should filter out selector candidates that do not match");
  assert.equal(scopedButton.clicked, false, "selectorText.final should not override selector target when selector is present");

  result = await evaluateExpression(sandbox.buildWaitForElementExpression({ selector: { AND: [] }, selectorText: "" }));
  assert.equal(result.ok, false, "empty selector.AND should fail");
  assert.match(result.error, /requires a non-empty array/, "empty selector.AND should report invalid expression");

  setDocument(new FakeElement("body"));
  result = await evaluateExpression(sandbox.buildWaitForElementExpression({ selector: "#missing", selectorText: "", intervalMs: 0, timeoutMs: 10 }));
  assert.equal(result.ok, false, "waitForElement should fail when selector does not appear before timeout");
  assert.equal(result.timeout, true, "waitForElement timeout failure should be marked as timeout");
  assert.equal(result.code, "NOT_FOUND", "waitForElement timeout failure should keep NOT_FOUND code");
  assert.ok(result.attempts >= 1, "waitForElement timeout failure should attempt at least once");

  const delayedBody = new FakeElement("body");
  setDocument(delayedBody);
  const delayedPromise = evaluateExpression(sandbox.buildWaitForElementExpression({ selector: "#delayed", selectorText: "", intervalMs: 0, timeoutMs: 1000 }));
  setTimeout(() => delayedBody.append(new FakeElement("button", { id: "delayed" }, "Delayed")), 20);
  result = await delayedPromise;
  assert.equal(result.ok, true, "waitForElement should resolve when MutationObserver sees a delayed element");
  assert.equal(result.candidates, 1, "delayed element should report candidate count");

  const fallbackBody = new FakeElement("body");
  setDocument(fallbackBody);
  const fallbackPromise = evaluateExpression(sandbox.buildWaitForElementExpression({ selector: "#fallback", selectorText: "", intervalMs: 10, timeoutMs: 1000 }), { disableMutationObserver: true });
  setTimeout(() => fallbackBody.append(new FakeElement("button", { id: "fallback" }, "Fallback")), 20);
  result = await fallbackPromise;
  assert.equal(result.ok, true, "waitForElement should resolve via interval fallback without MutationObserver");

  setDocument(new FakeElement("body"));
  result = await evaluateExpression(sandbox.buildWaitForElementExpression({ selector: "#never", selectorText: "", intervalMs: 0, timeoutMs: -1 }), { disableMutationObserver: true });
  assert.equal(result.ok, false, "waitForElement should reject unsupported infinite wait configuration");
  assert.equal(result.code, "UNSUPPORTED_WAIT_CONFIGURATION", "unsupported infinite wait should report configuration code");

  const coordinateExpression = sandbox.buildGetElementCoordinatesExpression({ selector: { OR: ["#one"] }, selectorText: { OR: ["One"] }, afterFoundMs: 0 });
  assert.match(coordinateExpression, /"selector":\{"OR":\["#one"\]\}/, "get coordinates payload should preserve selector object");
  assert.match(coordinateExpression, /"selectorText":\{"OR":\["One"\]\}/, "get coordinates payload should preserve selectorText object");
}

run()
  .then(() => console.log("selector-expression tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
