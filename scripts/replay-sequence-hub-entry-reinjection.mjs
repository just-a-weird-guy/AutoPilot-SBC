import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const rootDir = process.cwd();
const bridgePath = path.resolve(rootDir, "page/ea-data-bridge.js");

const readSource = async () => fs.readFile(bridgePath, "utf8");

const findStatementEnd = (source, startIndex) => {
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    const prev = source[index - 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === "*" && char === "/") inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (char === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (char === '"' && prev !== "\\") inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (char === "`" && prev !== "\\") inTemplate = false;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "`") {
      inTemplate = true;
      continue;
    }

    if (char === "(") depthParen += 1;
    else if (char === ")") depthParen -= 1;
    else if (char === "{") depthBrace += 1;
    else if (char === "}") depthBrace -= 1;
    else if (char === "[") depthBracket += 1;
    else if (char === "]") depthBracket -= 1;
    else if (
      char === ";" &&
      depthParen === 0 &&
      depthBrace === 0 &&
      depthBracket === 0
    ) {
      return index + 1;
    }
  }

  throw new Error(`Could not find statement end from index ${startIndex}`);
};

const extractConstStatement = (source, name) => {
  const marker = `const ${name} =`;
  const startIndex = source.indexOf(marker);
  if (startIndex === -1) return null;
  const endIndex = findStatementEnd(source, startIndex);
  return source.slice(startIndex, endIndex);
};

const extractStatement = (source, name) => extractConstStatement(source, name);

class FakeElement {
  constructor({ matchesSelectors = [], querySelectorHits = false } = {}) {
    this.matchesSelectors = new Set(matchesSelectors);
    this.querySelectorHits = querySelectorHits;
  }

  matches(selector) {
    return selector
      .split(",")
      .map((part) => part.trim())
      .some((part) => this.matchesSelectors.has(part));
  }

  querySelector() {
    return this.querySelectorHits ? new FakeElement() : null;
  }
}

class FakeHTMLElement extends FakeElement {}

class FakeMutationObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.observeCalls = [];
    this.disconnectCalls = 0;
    FakeMutationObserver.instances.push(this);
  }

  observe(target, options) {
    this.observeCalls.push({ target, options });
  }

  disconnect() {
    this.disconnectCalls += 1;
  }
}

const createHarness = (source) => {
  const ensureSequenceHubEntryCalls = [];
  const documentBody = new FakeHTMLElement();
  const context = vm.createContext({
    console,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    MutationObserver: FakeMutationObserver,
    readNumeric: (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    },
    document: { body: documentBody },
    sequenceEntryDocumentObserver: null,
    sequenceEntryDocumentObserverStarted: false,
    sequenceEntryReflowTimer: null,
    currentSbcHubView: null,
    ensureSequenceHubEntry: (view) => {
      ensureSequenceHubEntryCalls.push(view ?? null);
      return true;
    },
    clearTimeout: () => {},
    setTimeout: (callback) => {
      callback();
      return 1;
    },
  });

  for (const name of [
    "nodeTouchesSbcHub",
    "scheduleSequenceHubEntryReflow",
    "ensureSequenceEntryDocumentObserver",
  ]) {
    const statement = extractStatement(source, name);
    if (!statement) {
      throw new Error(`Missing required statement: ${name}`);
    }
    vm.runInContext(`${statement}\nthis.${name} = ${name};`, context, {
      filename: "ea-data-bridge.js",
    });
  }

  return { context, ensureSequenceHubEntryCalls, documentBody };
};

const main = async () => {
  const source = await readSource();
  assert.equal(
    source.includes("const ensureSequenceEntryDocumentObserver = () =>"),
    true,
    "sequence hub reinjection should include a document-level observer for hub transitions",
  );
  assert.equal(
    source.includes("scheduleSequenceHubEntryReflow(null, 0);"),
    true,
    "hub document observer should trigger immediate reinjection when hub DOM returns",
  );

  const { context, ensureSequenceHubEntryCalls, documentBody } =
    createHarness(source);
  const { nodeTouchesSbcHub, ensureSequenceEntryDocumentObserver } = context;

  assert.equal(
    nodeTouchesSbcHub(
      new FakeElement({ matchesSelectors: [".ut-sbc-hub-view"] }),
    ),
    true,
    "hub root nodes should be recognized by the document observer",
  );
  assert.equal(
    nodeTouchesSbcHub(new FakeElement({ querySelectorHits: true })),
    true,
    "hub descendants should be recognized by the document observer",
  );
  assert.equal(
    nodeTouchesSbcHub(new FakeElement()),
    false,
    "unrelated nodes should not trigger hub reinjection",
  );

  ensureSequenceEntryDocumentObserver();
  assert.equal(
    FakeMutationObserver.instances.length,
    1,
    "document observer should be created once",
  );
  assert.equal(
    FakeMutationObserver.instances[0].observeCalls.length,
    1,
    "document observer should watch body mutations for hub reinjection",
  );
  assert.equal(
    FakeMutationObserver.instances[0].observeCalls[0].target,
    documentBody,
    "document observer should attach to document.body",
  );
  assert.equal(
    FakeMutationObserver.instances[0].observeCalls[0].options.childList,
    true,
    "document observer should watch child list mutations",
  );
  assert.equal(
    FakeMutationObserver.instances[0].observeCalls[0].options.subtree,
    true,
    "document observer should watch subtree mutations",
  );

  FakeMutationObserver.instances[0].callback([
    { type: "childList", addedNodes: [new FakeElement()], removedNodes: [] },
  ]);
  assert.equal(
    ensureSequenceHubEntryCalls.length,
    0,
    "non-hub mutations should not trigger reinjection",
  );

  FakeMutationObserver.instances[0].callback([
    {
      type: "childList",
      addedNodes: [new FakeElement({ matchesSelectors: [".ut-sbc-hub-view"] })],
      removedNodes: [],
    },
  ]);
  assert.deepEqual(
    ensureSequenceHubEntryCalls,
    [null],
    "hub mutations should trigger a reinjection attempt even without an active hub view reference",
  );

  ensureSequenceEntryDocumentObserver();
  assert.equal(
    FakeMutationObserver.instances.length,
    1,
    "document observer setup should stay idempotent",
  );

  console.log("sequence hub entry reinjection replay: ok");
};

await main();
