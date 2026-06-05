const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundPath = path.join(__dirname, "..", "src", "background.js");
const backgroundSource = fs.readFileSync(backgroundPath, "utf8");

class FakeElement {
  constructor(tagName, attrs = {}, text = "") {
    this.nodeType = Node.ELEMENT_NODE;
    this.tagName = String(tagName).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.ownText = text;
    this.nodeValue = null;
    this.value = attrs.value || "";
    this.type = attrs.type || "";
    this.checked = Boolean(attrs.checked);
    this.label = attrs.label || "";
    this.options = [];
    this.selectedOptions = [];
    this.labels = [];
    this.isContentEditable = false;
    this.clicked = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
      if (this.tagName === "SELECT" && child.tagName === "OPTION") {
        this.options.push(child);
        if (child.attrs.selected) this.selectedOptions.push(child);
      }
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
    const childText = this.children.map((child) => child.textContent).filter(Boolean);
    return [this.ownText, ...childText].filter(Boolean).join(this.ownText || childText.length > 1 ? " " : "");
  }

  set textContent(value) {
    this.ownText = String(value ?? "");
    const root = this.getRoot();
    if (root && typeof root.__notifyMutation === "function") {
      root.__notifyMutation({ type: "characterData", target: this });
    }
  }

  get childNodes() {
    const nodes = [];
    if (this.ownText) nodes.push(new FakeText(this.ownText, this));
    nodes.push(...this.children);
    return nodes;
  }

  get innerText() {
    const childText = this.children.map((child) => child.innerText).filter(Boolean);
    return [this.ownText, ...childText].filter(Boolean).join(this.ownText || childText.length > 1 ? " " : "");
  }

  set innerText(value) {
    this.ownText = String(value ?? "");
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
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
    if (item.includes(",")) return item.split(",").some((part) => this.matches(part));
    const idMatch = item.match(/^([a-zA-Z][\w-]*)?#([\w-]+)$/);
    if (idMatch) {
      const tagPart = idMatch[1] || "";
      const idPart = idMatch[2];
      return (!tagPart || this.tagName.toLowerCase() === tagPart.toLowerCase()) && this.id === idPart;
    }
    if (item.startsWith("#")) return this.id === item.slice(1);
    if (item.startsWith(".")) return this.className.split(/\s+/).includes(item.slice(1));
    const [tagPart, idPart] = item.split("#");
    if (idPart !== undefined) {
      return (!tagPart || this.tagName.toLowerCase() === tagPart.toLowerCase()) && this.id === idPart;
    }
    const [classTagPart, classPart] = item.split(".");
    if (classPart !== undefined) {
      return (!classTagPart || this.tagName.toLowerCase() === classTagPart.toLowerCase()) && this.className.split(/\s+/).includes(classPart);
    }
    return this.tagName.toLowerCase() === item.toLowerCase();
  }

  querySelectorAll(selector) {
    const results = [];
    const selectors = String(selector || "").split(",").map((item) => item.trim()).filter(Boolean);
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((item) => child.matches(item))) results.push(child);
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
    if (this.ownerDocument) return this.ownerDocument;
    let node = this;
    while (node.parentElement) {
      node = node.parentElement;
      if (node.ownerDocument) return node.ownerDocument;
    }
    return node;
  }

  setOwnerDocument(document) {
    this.ownerDocument = document;
    for (const child of this.children) child.setOwnerDocument?.(document);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0 };
  }

  scrollIntoView() {}
  focus() {}
  click() { this.clicked = true; }
}

class FakeText {
  constructor(value, parentElement) {
    this.nodeType = Node.TEXT_NODE;
    this.nodeValue = String(value ?? "");
    this.textContent = this.nodeValue;
    this.parentElement = parentElement;
  }
}

class FakeDocument {
  constructor(body) {
    this.nodeType = Node.DOCUMENT_NODE;
    this.__observers = new Set();
    this.title = "";
    this.body = body;
    this.documentElement = new FakeElement("html").append(body);
    this.documentElement.setOwnerDocument(this);
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

  getElementById(id) {
    return this.querySelectorAll("*").find((node) => node.id === id) || null;
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

global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 };
global.Element = FakeElement;
global.Document = FakeDocument;
global.MutationObserver = FakeMutationObserver;
function fakeGetComputedStyle(el) {
  const styleText = String(el?.attrs?.style || "").toLowerCase();
  const isHiddenInput = el?.tagName === "INPUT" && String(el?.type || el?.attrs?.type || "").toLowerCase() === "hidden";
  return {
    display: /display\s*:\s*none/.test(styleText) || isHiddenInput ? "none" : "block",
    visibility: /visibility\s*:\s*hidden/.test(styleText) ? "hidden" : "visible",
    contentVisibility: /content-visibility\s*:\s*hidden/.test(styleText) ? "hidden" : "visible",
  };
}
global.window = { innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1, scrollX: 0, scrollY: 0, getComputedStyle: fakeGetComputedStyle };

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
vm.runInContext(`${backgroundSource}\nObject.assign(globalThis, { hasElementTarget, buildFindAndActExpression, buildGetElementCoordinatesExpression, buildWaitForElementExpression, buildGetPageTextExpression });`, sandbox);

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
    getComputedStyle: fakeGetComputedStyle,
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

  setDocument(new FakeElement("body").append(
    new FakeElement("h1", {}, "Main heading"),
    new FakeElement("p", {}, "Body copy"),
    new FakeElement("input", { type: "password", value: "secret-pass" }),
    new FakeElement("input", { type: "hidden", value: "hidden-token" }),
    new FakeElement("input", { placeholder: "Search placeholder" }),
    new FakeElement("textarea", { value: "textarea note" }),
    new FakeElement("img", { alt: "Image alt", title: "Image title", "aria-label": "Image aria", "aria-placeholder": "Image placeholder" }),
  ));
  global.document.title = "Page title";
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ timeoutMs: 1000 }));
  assert.equal(result.ok, true, "getPageText should collect default page text");
  assert.match(result.text, /Page title/, "getPageText should include document.title by default");
  assert.match(result.text, /Main heading/, "getPageText should include DOM text");
  assert.match(result.text, /Body copy/, "getPageText should include paragraph text");
  assert.match(result.text, /secret-pass/, "getPageText should include password input value");
  assert.match(result.text, /hidden-token/, "getPageText should include hidden input value");
  assert.match(result.text, /Search placeholder/, "getPageText should include input placeholder text");
  assert.match(result.text, /textarea note/, "getPageText should include textarea value");
  assert.match(result.text, /Image alt/, "getPageText should include image alt text");
  assert.match(result.text, /Image title/, "getPageText should include image title text");
  assert.match(result.text, /Image aria/, "getPageText should include image aria-label text");
  assert.match(result.text, /Image placeholder/, "getPageText should include image placeholder text");
  assert.equal(result.truncated, false, "getPageText should not truncate without timeout");
  assert.equal(result.timeout, false, "getPageText should not mark timeout without deadline exhaustion");
  assert.ok(result.sourceCounts.title >= 1, "getPageText sourceCounts should use title key");
  assert.ok(result.sourceCounts.textNode >= 2, "getPageText sourceCounts should use textNode key");
  assert.ok(result.sourceCounts.formValue >= 3, "getPageText sourceCounts should use formValue key");
  assert.ok(result.sourceCounts.imageAlt >= 1, "getPageText sourceCounts should use imageAlt key");
  assert.ok(result.sourceCounts.attributeText >= 3, "getPageText sourceCounts should use attributeText key");
  assert.ok(result.sourceCounts.placeholder >= 1, "getPageText sourceCounts should use placeholder key");

  setDocument(new FakeElement("body").append(
    new FakeElement("p", { title: "属性" }, "内容"),
    new FakeElement("span"),
    new FakeElement("img", { alt: "图片", title: "提示" }),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, timeoutMs: 1000 }));
  assert.equal(result.text, "内容\n属性\n\n图片 提示", "getPageText should output content before attributes and separate matching nodes with blank lines");

  setDocument(new FakeElement("body").append(
    new FakeElement("p", { title: "属性", "data-title": "额外标题", class: "card" }, "第一行\n第二行"),
    new FakeElement("div"),
    new FakeElement("p", { "data-title": "仅属性" }),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, extraAttributes: ["data-title", "class"], timeoutMs: 1000 }));
  assert.equal(result.text, "第一行\n第二行\n属性 额外标题 card\n\n仅属性", "getPageText should preserve textContent-like newlines and append extra attributes after content");
  assert.ok(result.sourceCounts.extraAttribute >= 2, "getPageText sourceCounts should count extraAttributes");

  setDocument(new FakeElement("body").append(
    new FakeElement("p", { title: "混合属性" }).append(
      new FakeText("A", null),
      new FakeElement("span", {}, "B"),
      new FakeText("C", null),
    ),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, timeoutMs: 1000 }));
  assert.equal(result.text, "ABC\n混合属性", "getPageText should keep inline mixed text/child content together before attributes");

  setDocument(new FakeElement("body").append(
    new FakeElement("p", {}, "第一行").append(new FakeElement("br"), new FakeText("第二行", null)),
    new FakeElement("p", {}, "下一段"),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, timeoutMs: 1000 }));
  assert.equal(result.text, "第一行\n第二行\n\n下一段", "getPageText should convert br to a line break and separate block paragraphs");

  setDocument(new FakeElement("body").append(
    new FakeElement("p", { hidden: "" }, "Hidden attr text"),
    new FakeElement("p", { "aria-hidden": "true" }, "Aria hidden text"),
    new FakeElement("p", { inert: "" }, "Inert text"),
    new FakeElement("p", { style: "display:none" }, "Display none text"),
    new FakeElement("p", { style: "visibility:hidden" }, "Visibility hidden text"),
    new FakeElement("input", { type: "hidden", value: "hidden-input-kept" }),
    new FakeElement("input", { type: "hidden", hidden: "", value: "explicit-hidden-input-skipped" }),
    new FakeElement("p", {}, "Visible text"),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, timeoutMs: 1000 }));
  assert.match(result.text, /Hidden attr text|Aria hidden text|Inert text|Display none text|Visibility hidden text/, "getPageText should include hidden elements by default");
  assert.match(result.text, /hidden-input-kept/, "getPageText should keep input[type=hidden] value by default");
  assert.match(result.text, /explicit-hidden-input-skipped/, "getPageText should include explicitly hidden input by default");
  assert.match(result.text, /Visible text/, "getPageText should keep visible text");

  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, filterVisibility: true, timeoutMs: 1000 }));
  assert.doesNotMatch(result.text, /Hidden attr text|Aria hidden text|Inert text|Display none text|Visibility hidden text/, "getPageText should skip hidden elements when filterVisibility is enabled");
  assert.match(result.text, /hidden-input-kept/, "getPageText should keep input[type=hidden] value when only UA display none applies");
  assert.doesNotMatch(result.text, /explicit-hidden-input-skipped/, "getPageText should skip input[type=hidden] when hidden attribute is set and filterVisibility is enabled");

  setDocument(new FakeElement("body").append(
    new FakeElement("p", {}).append(new FakeText("A", null), new FakeElement("span", { hidden: "" }, "B"), new FakeText("C", null)),
    new FakeElement("p", {}).append(new FakeText("D", null), new FakeElement("span", { "aria-hidden": "true" }, "E"), new FakeText("F", null)),
    new FakeElement("p", {}).append(new FakeText("G", null), new FakeElement("span", { inert: "" }, "H"), new FakeText("I", null)),
    new FakeElement("p", {}).append(new FakeText("J", null), new FakeElement("span", { style: "display:none" }, "K"), new FakeText("L", null)),
    new FakeElement("p", {}).append(new FakeText("M", null), new FakeElement("span", { style: "visibility:hidden" }, "N"), new FakeText("O", null)),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, timeoutMs: 1000 }));
  assert.equal(result.text, "ABC\n\nDEF\n\nGHI\n\nJKL\n\nMNO", "getPageText should include hidden inline children by default");

  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, visibilityMode: "visible", timeoutMs: 1000 }));
  assert.equal(result.text, "AC\n\nDF\n\nGI\n\nJL\n\nMO", "getPageText should skip hidden inline children when visibilityMode is visible");

  setDocument(new FakeElement("body").append(
    new FakeElement("div", { hidden: "" }).append(new FakeElement("p", { id: "hiddenchild" }, "Hidden ancestor child")),
    new FakeElement("p", {}, "Visible sibling"),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, selector: "#hiddenchild", filterVisibility: true, timeoutMs: 1000 }));
  assert.equal(result.text, "", "getPageText should skip selector target when an ancestor is hidden and filterVisibility is enabled");

  setDocument(new FakeElement("body").append(
    new FakeElement("span", { id: "hidden-description", hidden: "" }, "Hidden referenced text"),
    new FakeElement("button", { "aria-describedby": "hidden-description" }, "Visible button"),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, filterVisibility: true, timeoutMs: 1000 }));
  assert.match(result.text, /Visible button/, "getPageText should keep visible element text when referenced text is hidden");
  assert.doesNotMatch(result.text, /Hidden referenced text/, "getPageText should skip hidden aria referenced text when filterVisibility is enabled");

  setDocument(new FakeElement("body").append(
    new FakeElement("span", { id: "hidden-title", hidden: "" }, "Hidden labelledby text"),
    new FakeElement("button", { "aria-labelledby": "hidden-title" }, "Visible labelled button"),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, filterVisibility: true, timeoutMs: 1000 }));
  assert.match(result.text, /Visible labelled button/, "getPageText should keep visible element text when labelledby text is hidden");
  assert.doesNotMatch(result.text, /Hidden labelledby text/, "getPageText should skip hidden aria-labelledby text when filterVisibility is enabled");

  const hiddenLabel = new FakeElement("label", { hidden: "" }, "Hidden associated label");
  const labelledInput = new FakeElement("input", { value: "Visible input" });
  labelledInput.labels = [hiddenLabel];
  setDocument(new FakeElement("body").append(hiddenLabel, labelledInput));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, filterVisibility: true, timeoutMs: 1000 }));
  assert.match(result.text, /Visible input/, "getPageText should keep input value when associated label is hidden");
  assert.doesNotMatch(result.text, /Hidden associated label/, "getPageText should skip hidden associated labels when filterVisibility is enabled");

  const ancestorHiddenLabel = new FakeElement("label", {}, "Ancestor hidden label");
  const ancestorLabelledInput = new FakeElement("input", { value: "Ancestor label input" });
  ancestorLabelledInput.labels = [ancestorHiddenLabel];
  setDocument(new FakeElement("body").append(new FakeElement("div", { hidden: "" }).append(ancestorHiddenLabel), ancestorLabelledInput));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, visibilityMode: "visible", timeoutMs: 1000 }));
  assert.match(result.text, /Ancestor label input/, "getPageText should keep input value when associated label ancestor is hidden");
  assert.doesNotMatch(result.text, /Ancestor hidden label/, "getPageText should skip labels with hidden ancestors when filterVisibility is enabled");

  setDocument(new FakeElement("body").append(
    new FakeElement("div", {}, "Block"),
    new FakeElement("span", { id: "inlineroot" }).append(new FakeElement("span", {}, "A"), new FakeElement("span", {}, "B"), new FakeElement("span", {}, "C")),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, selector: "#inlineroot", timeoutMs: 1000 }));
  assert.equal(result.text, "ABC", "getPageText should merge a pure inline selector root into one content block");

  setDocument(new FakeElement("body").append(new FakeElement("p", { title: "默认属性", "data-title": "额外属性" }, "内容")));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, includeAttributeText: false, extraAttributes: ["data-title"], timeoutMs: 1000 }));
  assert.equal(result.text, "内容\n额外属性", "getPageText should allow extraAttributes even when default attributes are disabled");

  setDocument(new FakeElement("body").append(
    new FakeElement("div", { "aria-label": "获取优惠" }).append(
      new FakeElement("p", {}, "Builder Cape"),
      new FakeElement("p", {}, "访问 请点击此处。 了解详情。"),
      new FakeElement("input", { value: "TP9M4-794R4-33P9M-G7J9K-MCP9Z" }),
      new FakeElement("button", { "aria-label": "兑换按钮" }).append(new FakeElement("div", {}, "兑换")),
      new FakeElement("p", {}, "优惠截止日期：2026年6月22日。"),
    ),
  ));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ includeTitle: false, timeoutMs: 1000 }));
  assert.doesNotMatch(result.text, /兑换优惠截止日期/, "getPageText should not flatten button and following deadline text together");
  assert.ok(
    result.text.indexOf("兑换按钮") < result.text.lastIndexOf("兑换") && result.text.lastIndexOf("兑换") < result.text.indexOf("优惠截止日期：2026年6月22日。"),
    "getPageText should keep redeem button before the deadline in DOM order"
  );

  assert.throws(
    () => sandbox.buildGetPageTextExpression({ extraAttributes: "data-title" }),
    /extraAttributes must be an array/,
    "getPageText should reject non-array extraAttributes"
  );

  const defaultPageTextExpression = sandbox.buildGetPageTextExpression({});
  assert.match(defaultPageTextExpression, /"timeoutMs":10000/, "getPageText default timeoutMs should be embedded as 10000");

  setDocument(new FakeElement("body").append(new FakeElement("p", {}, "Long page text that exceeds artificial limits")));
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ maxChars: 1, maxNodes: 1, timeoutMs: 1000 }));
  assert.equal(result.ok, true, "getPageText should ignore unsupported maxChars/maxNodes inputs");
  assert.match(result.text, /Long page text that exceeds artificial limits/, "getPageText should not truncate when maxChars/maxNodes are passed");
  assert.equal(result.truncated, false, "unsupported maxChars/maxNodes should not set truncated");

  setDocument(new FakeElement("body").append(
    new FakeElement("section", { id: "outside" }, "Outside only"),
    new FakeElement("section", { id: "inside" }).append(new FakeElement("span", { id: "needle", title: "Needle" }), new FakeElement("p", {}, "SelectorText scoped copy")),
  ));
  global.document.title = "SelectorText scoped title";
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ selectorText: { AND: ["Needle"], final: "Needle" }, timeoutMs: 1000 }));
  assert.equal(result.ok, true, "getPageText selectorText-only should find a range");
  assert.match(result.text, /Needle/, "selectorText-only range should include matched text");
  assert.ok(result.textCandidates >= 1, "selectorText-only range should report text candidate scope");
  assert.match(result.text, /SelectorText scoped title/, "selectorText-only range should still include document.title by default");

  setDocument(new FakeElement("body").append(
    new FakeElement("section", { id: "final-scope" }).append(new FakeElement("span", { class: "marker" }, "Marker"), new FakeElement("p", { class: "final" }, "Final scoped text"), new FakeElement("p", {}, "Container sibling text")),
    new FakeElement("p", { class: "final" }, "Outside final text"),
  ));
  global.document.title = "Final scoped title";
  result = await evaluateExpression(sandbox.buildGetPageTextExpression({ selector: { AND: ["#final-scope", ".marker"], final: ".final" }, timeoutMs: 1000 }));
  assert.equal(result.ok, true, "getPageText selector.final should find final range");
  assert.match(result.text, /Final scoped text/, "selector.final range should include final target text");
  assert.equal(result.candidates, 1, "selector.final range should report final candidate count");
  assert.match(result.text, /Final scoped title/, "selector.final range should still include document.title by default");

  const pageTextExpression = sandbox.buildGetPageTextExpression({ selector: { AND: ["span#target-marker", "p#target-details"] }, selectorText: { AND: ["Target marker"], final: "Target details" }, timeoutMs: 1000 });
  assert.match(pageTextExpression, /"selector":\{"AND":\["span#target-marker","p#target-details"\]\}/, "getPageText payload should preserve selector object");
  assert.match(pageTextExpression, /"selectorText":\{"AND":\["Target marker"\],"final":"Target details"\}/, "getPageText payload should preserve selectorText object");
  setDocument(new FakeElement("body").append(
    new FakeElement("section", { id: "outside-card", "aria-label": "outside-region" }).append(new FakeElement("span", {}, "Other marker"), new FakeElement("p", {}, "Outside copy")),
    new FakeElement("section", { id: "target-card" }).append(new FakeElement("span", { id: "target-marker" }, "Target marker"), new FakeElement("p", { id: "target-details" }, "Target details"), new FakeElement("p", {}, "Scoped only")),
  ));
  global.document.title = "Scoped title";
  result = await evaluateExpression(pageTextExpression);
  assert.equal(result.ok, true, "getPageText should find selector + selectorText object target");
  assert.equal(result.candidates, 1, "getPageText should report selector candidate count");
  assert.ok(result.textCandidates >= 1, "getPageText should report scoped selectorText candidate count");
  assert.match(result.text, /Target marker/, "getPageText should include text from located range");
  assert.match(result.text, /Target details/, "getPageText should include final selectorText content in located range");
  assert.match(result.text, /Scoped only/, "getPageText should include sibling text in located range");
  assert.match(result.text, /Scoped title/, "getPageText scoped range should include document.title by default");
  assert.doesNotMatch(result.text, /outside-region/, "getPageText should not include attributes outside located range");

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
