// Exercise the real plugin orchestration through the bench Obsidian seam.
// UI/worker modules are inert here; taxonomy, memo keys and assembly are shipped code.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { TAbstractFile, TFile } from "./obsidian-stub.mjs";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(resolve(".concept-check-"));
let Plugin, IndexStore, RelatedNotesView, deserializeIndex;
try {
  const result = await build({
    stdin: { contents: 'export { default } from "./src/main.ts"; export { IndexStore } from "./src/index-store.ts"; export { RelatedNotesView } from "./src/view.ts"; export { deserializeIndex } from "./src/vector-math.ts";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "bench-host", setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "bench" }));
      builder.onLoad({ filter: /.*/, namespace: "bench" }, () => ({ contents: `
        export * from ${JSON.stringify(pathToFileURL(resolve("bench/obsidian-stub.mjs")).href)};
        export const editorLivePreviewField = {};
        export function setTooltip() {}
        export function getAllTags() { return []; }
      `, loader: "js" }));
      builder.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^virtual:/ }, () => ({ path: "empty", namespace: "virtual" }));
      builder.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({ contents: 'export default "";' }));
    }}],
  });
  const path = resolve(directory, "plugin.mjs");
  await writeFile(path, result.outputFiles[0].text);
  const module = await import(pathToFileURL(path).href);
  Plugin = module.default;
  IndexStore = module.IndexStore;
  RelatedNotesView = module.RelatedNotesView;
  deserializeIndex = module.deserializeIndex;
} finally {
  await rm(directory, { recursive: true, force: true });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeElement {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.text = options.text ?? "";
    this.attributes = { ...(options.attr ?? {}) };
    this.children = [];
    this.listeners = new Map();
    this.disabled = false;
  }
  createDiv(options) { return this.append(new FakeElement("div", options)); }
  createSpan(options) { return this.append(new FakeElement("span", options)); }
  createEl(tag, options) { return this.append(new FakeElement(tag, options)); }
  append(child) { this.children.push(child); return child; }
  setAttr(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) { this.listeners.get(type)?.({ stopPropagation() {} }); }
}

function elementsByTag(root, tag) {
  return [root, ...root.children.flatMap(child => elementsByTag(child, tag))].filter(element => element.tag === tag);
}
function fixture() {
  const plugin = new Plugin();
  plugin.settings = {
    conceptTaggingEnabled: true, conceptNamingMode: "local",
    conceptNamingEndpoint: "", conceptNamingModel: "", conceptNamingApiKey: "",
    conceptTagMinConfidence: 0, excludeFolders: "", excludeFoldersLinks: "",
    isolatedAreas: "", readerSuggestTags: true,
  };
  plugin.app = { vault: { getAbstractFileByPath: () => null } };
  plugin.store = {
    getProgress: () => ({ status: "ready" }),
    vaultMapInput: () => [],
    conceptTaxonomyInput: () => plugin.store.vaultMapInput(),
    conceptEligibilityKey: () => "",
    isConceptTagEligible: () => true,
    refreshConceptEligibility: () => false,
    renameFile: () => {},
    isExcluded: () => false,
    tagInventory: () => new Map(),
    conceptCarriedTags: path => [...plugin.store.tagInventory().values()]
      .flatMap(tag => tag.exactByNote.get(path) ?? []),
    conceptProposalsForNote: async (file, taxonomy) =>
      (await plugin.store.computeInsightsAsync(new Set(), taxonomy)).conceptProposals
        .filter(proposal => proposal.notePath === file.path),
    computeConceptProposalsAsync: async (taxonomy, onProgress) =>
      (await plugin.store.computeInsightsAsync(new Set(), taxonomy, onProgress)).conceptProposals,
  };
  return plugin;
}

function registeredConceptEventFixture(file) {
  const plugin = fixture();
  const vaultCallbacks = new Map();
  const metadataCallbacks = new Map();
  plugin.settings.modelChosen = true;
  plugin.settings.autoLinkSubsequent = false;
  plugin.settings.autoApplyConceptTags = false;
  plugin.app.workspace = { getActiveFile: () => file };
  plugin.app.vault.on = (name, callback) => { vaultCallbacks.set(name, callback); return {}; };
  plugin.app.vault.getMarkdownFiles = () => [file];
  plugin.app.metadataCache = {
    on: (name, callback) => { metadataCallbacks.set(name, callback); return {}; },
  };
  plugin.registerEvent = () => {};
  plugin.titleIndex = { markDirty() {} };
  plugin.debouncedUpdate = () => {};
  plugin.debouncedTitleRefresh = () => {};
  plugin.debouncedAutoLink = () => {};
  plugin.debouncedAutoApplyConceptTags = () => {};
  plugin.store.invalidateGraph = () => {};
  plugin.getView = () => null;
  plugin.registerConceptRefreshEvents();
  plugin.registerConceptRenameEvent();
  return {
    plugin,
    modify: (changedFile = file) => vaultCallbacks.get("modify")(changedFile),
    metadataChanged: (changedFile = file) => metadataCallbacks.get("changed")(changedFile),
    rename: (renamedFile, oldPath) => vaultCallbacks.get("rename")(renamedFile, oldPath),
  };
}

test("general folder scope normalizes lists without absorbing link-only exclusions", () => {
  const plugin = fixture();
  const originalKey = plugin.tagNamingKey();
  plugin.settings.excludeFolders = "Excluded///,\nOther/";
  plugin.settings.excludeFoldersLinks = "LinkOnly";
  assert.deepEqual(plugin.parseExcludeFolders(), ["Excluded", "Other"]);
  assert.equal(plugin.excludeFoldersKey(), "Excluded\nOther");
  assert.equal(plugin.parseExcludeFolders().includes("LinkOnly"), false);
  assert.notEqual(plugin.tagNamingKey(), originalKey, "scope changes invalidate taxonomy and proposal flights");
});

test("taxonomy scope keys include isolated-area settings and live eligible membership", () => {
  const plugin = fixture();
  let eligible = "notes/a.md";
  plugin.store.conceptEligibilityKey = () => eligible;
  const original = plugin.tagNamingKey();
  plugin.settings.isolatedAreas = "#Goa/Character";
  assert.notEqual(plugin.tagNamingKey(), original);
  const isolated = plugin.tagNamingKey();
  eligible = "notes/b.md";
  assert.notEqual(plugin.tagNamingKey(), isolated);
});

test("reader chip rechecks eligibility inside the frontmatter mutation callback", async () => {
  const plugin = fixture();
  const file = new TFile("notes/a.md", 1);
  const frontmatter = { tags: [] };
  let eligible = true;
  plugin.store.isConceptTagEligible = () => eligible;
  plugin.app.fileManager = {
    processFrontMatter: async (_file, mutate) => {
      eligible = false;
      mutate(frontmatter);
    },
  };
  assert.equal(await plugin.applyReaderSuggestedTag(file, "Alpha"), false);
  assert.deepEqual(frontmatter.tags, []);
});

test("inline writes recheck eligibility inside the delayed vault.process callback", async () => {
  const plugin = fixture();
  const file = new TFile("notes/a.md", 1);
  const entered = deferred();
  const release = deferred();
  let eligible = true;
  let written = null;
  plugin.app.vault = {
    getAbstractFileByPath: () => file,
    process: async (_file, mutate) => {
      entered.resolve();
      await release.promise;
      written = mutate();
    },
  };
  plugin.app.metadataCache = {};
  const pending = plugin.conceptInlineAccess().writeNoteContent("notes/a.md", "new body", () => eligible);
  await entered.promise;
  eligible = false;
  release.resolve();
  await assert.rejects(pending, /note-ineligible/);
  assert.equal(written, null);
});

test("reader candidates become empty immediately when the confidence floor rises, including during an old-floor flight", async () => {
  const plugin = fixture();
  const proposal = { kind: "taxonomy", notePath: "notes/a.md", tagPath: "Alpha", confidence: 0.5, evidence: "fixture" };
  plugin.settings.conceptTagMinConfidence = 0.4;
  plugin.currentTaxonomy = async () => ({ nodes: [], leafAssignment: new Map() });
  plugin.store.computeInsightsAsync = async () => ({ conceptProposals: [proposal] });
  await plugin.assembleTagProposals();
  const readerHost = plugin.readerHost();
  assert.deepEqual(readerHost.taxonomyCandidates("notes/a.md"), ["Alpha"]);

  await Promise.resolve();
  const entered = deferred();
  const release = deferred();
  let sweeps = 0;
  plugin.store.computeInsightsAsync = async () => {
    sweeps++;
    if (sweeps === 1) {
      entered.resolve();
      await release.promise;
    }
    return { conceptProposals: [proposal] };
  };
  const pending = plugin.assembleTagProposals();
  await entered.promise;
  plugin.settings.conceptTagMinConfidence = 0.6;
  assert.deepEqual(readerHost.taxonomyCandidates("notes/a.md"), []);
  release.resolve();
  assert.deepEqual(await pending, []);
  assert.equal(sweeps, 2, "the stale floor is discarded and recomputed once");
  assert.deepEqual(readerHost.taxonomyCandidates("notes/a.md"), []);
});

test("applying one of two concept suggestions preserves user tags and leaves its sibling pending", async () => {
  const plugin = fixture();
  const file = new TFile("notes/a.md", 1);
  const proposals = [
    { kind: "taxonomy", notePath: file.path, tagPath: "Alpha", confidence: 0.9, evidence: "alpha peers" },
    { kind: "taxonomy", notePath: file.path, tagPath: "Beta", confidence: 0.9, evidence: "beta peers" },
  ];
  let tags = ["UserChosen"];
  let ledgerText = null;
  plugin.currentTaxonomy = async () => ({ nodes: [], leafAssignment: new Map() });
  plugin.store.computeInsightsAsync = async () => ({ conceptProposals: proposals });
  plugin.store.tagInventory = () => new Map(tags.map(tag => [tag.toLowerCase(), {
    canonical: tag.toLowerCase(), notePaths: [file.path], exactByNote: new Map([[file.path, [tag]]]),
  }]));
  plugin.taggingCommandPort = () => ({
    frontmatter: {
      readNoteTags: async () => [...tags],
      writeNoteTags: async (_path, next, canMutate) => {
        if (canMutate?.() === false) throw new Error("ineligible");
        tags = [...next];
      },
    },
    ledgerStorage: {
      readLedgerText: async () => ledgerText,
      writeLedgerText: async (text, canMutate) => {
        if (canMutate?.() === false) throw new Error("ineligible");
        ledgerText = text;
      },
    },
    isNoteEligible: () => true,
    now: () => 1,
    ledgerRetentionDays: () => 0,
    taxonomyPreviewLines: async () => [],
  });

  assert.deepEqual((await plugin.tagPanelDataFor(file)).forNote.proposals.map(proposal => proposal.tagPath), ["Alpha", "Beta"]);
  await Promise.resolve();
  await plugin.applyConceptTagSuggestion(file, "Alpha");
  assert.deepEqual(tags, ["UserChosen", "Alpha"]);
  assert.deepEqual(JSON.parse(ledgerText).map(entry => entry.tagPath), ["Alpha"]);
  await Promise.resolve();
  assert.deepEqual((await plugin.tagPanelDataFor(file)).forNote.proposals.map(proposal => proposal.tagPath), ["Beta"]);
});

test("a concept chip re-resolves evidence and eligibility, and replacements stay in narrowed review", async () => {
  const plugin = fixture();
  const file = new TFile("notes/a.md", 1);
  let eligible = true;
  let proposals = [{ kind: "taxonomy", notePath: file.path, tagPath: "Alpha", confidence: 0.9, evidence: "peers" }];
  let writes = 0;
  let reviewed = null;
  plugin.currentTaxonomy = async () => ({ nodes: [], leafAssignment: new Map() });
  plugin.store.computeInsightsAsync = async () => ({ conceptProposals: proposals });
  plugin.store.isConceptTagEligible = () => eligible;
  plugin.taggingCommandPort = () => ({
    frontmatter: { readNoteTags: async () => [], writeNoteTags: async () => { writes++; } },
    ledgerStorage: { readLedgerText: async () => null, writeLedgerText: async () => { writes++; } },
    isNoteEligible: () => eligible,
    now: () => 1,
    ledgerRetentionDays: () => 0,
    taxonomyPreviewLines: async () => [],
  });
  plugin.openConceptTagReview = selected => { reviewed = selected; };

  proposals = [];
  await plugin.applyConceptTagSuggestion(file, "Alpha");
  assert.equal(writes, 0, "stale evidence never applies");

  proposals = [{ kind: "taxonomy", notePath: file.path, tagPath: "Alpha", confidence: 0.9, evidence: "peers" }];
  eligible = false;
  await plugin.applyConceptTagSuggestion(file, "Alpha");
  assert.equal(writes, 0, "blacklisted notes never apply");

  eligible = true;
  proposals = [
    { kind: "normalization", notePath: file.path, tagPath: "Alpha", replacesTag: "alpha-old", confidence: 0.9, evidence: "rename" },
    { kind: "taxonomy", notePath: file.path, tagPath: "Beta", confidence: 0.9, evidence: "sibling" },
  ];
  await plugin.applyConceptTagSuggestion(file, "Alpha");
  assert.deepEqual(reviewed.map(proposal => proposal.tagPath), ["Alpha"]);
  assert.equal(writes, 0, "a replacement opens review instead of silently mutating");
});

test("concept suggestion chips are native keyboard controls and suppress duplicate activation", async () => {
  const gate = deferred();
  let calls = 0;
  let renders = 0;
  const plugin = {
    applyConceptTagSuggestion: async () => {
      calls++;
      await gate.promise;
    },
  };
  const view = new RelatedNotesView({}, plugin);
  view.listEl = new FakeElement();
  view.requestRender = () => { renders++; };
  view.renderTagNoteSection(new TFile("notes/a.md", 1), ["Alpha", "Beta"], []);
  const buttons = elementsByTag(view.listEl, "button");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].attributes.type, "button");
  assert.equal(buttons[0].attributes["aria-label"], "Add concept tag #Alpha to a");
  buttons[0].dispatch("click");
  buttons[0].dispatch("click");
  assert.equal(calls, 1);
  assert.equal(buttons[0].disabled, true);
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(buttons[0].disabled, false);
  assert.equal(renders, 1);
});

test("vault-wide review remains an explicit keyboard control", () => {
  let reviews = 0;
  const view = new RelatedNotesView({}, { reviewConceptTags: () => { reviews++; } });
  view.listEl = new FakeElement();
  view.renderTagVaultReviewControl();
  const [button] = elementsByTag(view.listEl, "button");
  assert.equal(button.attributes.type, "button");
  assert.equal(button.attributes["aria-label"], "Review all vault concept tag proposals");
  button.dispatch("click");
  assert.equal(reviews, 1);
});

test("taxonomy callers share one build and invalidated work cannot stamp a new epoch", async () => {
  const plugin = fixture();
  let builds = 0;
  plugin.store.vaultMapInput = () => { builds++; return []; };
  const pending = Array.from({ length: 20 }, () => plugin.currentTaxonomy());
  await Promise.all(pending);
  assert.equal(builds, 1);
  plugin.conceptTaxonomyEpoch++;
  await Promise.all(Array.from({ length: 20 }, () => plugin.currentTaxonomy()));
  assert.equal(builds, 2);
  plugin.invalidateConceptTaxonomy();
  const stale = plugin.currentTaxonomy();
  plugin.conceptTaxonomyEpoch++;
  await stale;
  assert.equal(builds, 4);
  assert.equal(plugin.conceptTaxonomyIndexMtime, plugin.conceptTaxonomyEpoch);
});

test("an eligibility change during taxonomy body reads rejects stale naming inputs", async () => {
  const plugin = fixture();
  const files = ["a.md", "b.md", "c.md"].map((path, index) => new TFile(path, index + 1));
  const vectors = [new Float32Array([1, 0]), new Float32Array([0.9, 0.1]), new Float32Array([0.8, 0.2])];
  let eligibility = "first";
  let reads = 0;
  const entered = deferred();
  const release = deferred();
  plugin.store.conceptEligibilityKey = () => eligibility;
  plugin.store.conceptTaxonomyInput = () => files.map((file, index) => ({ path: file.path, title: file.basename, vec: vectors[index] }));
  plugin.app.vault = {
    getAbstractFileByPath: path => files.find(file => file.path === path) ?? null,
    cachedRead: async () => {
      reads++;
      if (reads <= files.length) {
        entered.resolve();
        await release.promise;
      }
      return "meaningful shared concept vocabulary";
    },
  };
  const pending = plugin.currentTaxonomy();
  await entered.promise;
  eligibility = "second";
  release.resolve();
  await pending;
  assert.equal(plugin.conceptTaxonomyNamingKey, plugin.tagNamingKey());
  assert.equal(reads, files.length, "the changed scope rebuild reuses revision-matched naming text");
});

test("clean naming text cache rereads only changed revisions and preserves tag-only text", async () => {
  const plugin = fixture();
  const files = ["a.md", "b.md", "c.md"].map((path, index) => {
    const file = new TFile(path, 1);
    file.stat.size = 100 + index;
    return file;
  });
  let reads = 0;
  let taxonomyBuilds = 0;
  plugin.store.conceptTaxonomyInput = () => {
    taxonomyBuilds++;
    return files.map((file, index) => ({
      path: file.path, title: file.basename, vec: new Float32Array([index === 0 ? 1 : 0, index === 0 ? 0 : 1]),
    }));
  };
  plugin.app.vault = {
    getAbstractFileByPath: path => files.find(file => file.path === path) ?? null,
    cachedRead: async file => { reads++; return `${file.basename} meaningful naming text`; },
  };
  await plugin.currentTaxonomy();
  assert.equal(reads, 3);

  plugin.conceptTaxonomyEpoch++;
  plugin.invalidateConceptTaxonomy();
  await plugin.currentTaxonomy();
  assert.equal(reads, 3, "unchanged taxonomy rerender performs no body reads");

  files[1].stat.mtime++;
  plugin.conceptTaxonomyEpoch++;
  plugin.invalidateConceptTaxonomy();
  await plugin.currentTaxonomy();
  assert.equal(reads, 4, "one content revision rereads only that note");

  files[2].stat.mtime++;
  plugin.preserveConceptNamingTextForTagOnlyChange(files[2]);
  plugin.conceptTaxonomyEpoch++;
  plugin.invalidateConceptTaxonomy();
  await plugin.currentTaxonomy();
  assert.equal(reads, 4, "known tag-only revision reuses cleaned naming text");

  plugin.settings.modelChosen = true;
  plugin.store.updateFile = async () => {};
  plugin.getView = () => null;
  files[2].stat.mtime++;
  plugin.conceptTagOnlyDirtyPaths.add(files[2].path);
  plugin.dirty.add(files[2].path);
  const buildsBeforeTagOnlyFlush = taxonomyBuilds;
  await plugin.flushDirty();
  await plugin.currentTaxonomy();
  assert.equal(reads, 4, "tag-only flush does not reread naming text");
  assert.equal(taxonomyBuilds, buildsBeforeTagOnlyFlush + 1, "tag-dependent vectors trigger one coalesced geometry refresh");
});

test("registered replacement events invalidate cleaned text before the coalesced flush", async () => {
  const file = new TFile("notes/a.md", 1);
  file.stat.size = 100;
  const { plugin, modify, metadataChanged } = registeredConceptEventFixture(file);
  let body = "Body #Old topic";
  let reads = 0;
  let frontmatterTags = ["Old"];
  let ledgerText = null;
  plugin.app.vault.getAbstractFileByPath = () => file;
  plugin.app.vault.cachedRead = async () => { reads++; return body; };
  plugin.store.updateFile = async () => {};
  plugin.getView = () => null;
  plugin.taggingCommandPort = () => ({
    frontmatter: {
      readNoteTags: async () => [...frontmatterTags],
      writeNoteTags: async (_path, tags, canMutate) => {
        if (canMutate?.() === false) throw new Error("ineligible");
        frontmatterTags = [...tags];
      },
    },
    inline: {
      readNoteContent: async () => body,
      inlineTagSpans: async () => [{ start: body.indexOf("#Old"), end: body.indexOf("#Old") + 4, text: "#Old" }],
      writeNoteContent: async (_path, text, canMutate) => {
        if (canMutate?.() === false) throw new Error("ineligible");
        body = text;
        file.stat.mtime++;
        modify();
        metadataChanged();
      },
    },
    ledgerStorage: {
      readLedgerText: async () => ledgerText,
      writeLedgerText: async (text) => { ledgerText = text; },
    },
    isNoteEligible: () => true,
    now: () => 1,
    ledgerRetentionDays: () => 0,
    taxonomyPreviewLines: async () => [],
  });
  await plugin.conceptNamingTextFor(file);
  plugin.conceptTagOnlyDirtyPaths.add(file.path);
  await plugin.applyReviewedProposals([{
    kind: "normalization", notePath: file.path, tagPath: "New", replacesTag: "Old",
    confidence: 1, evidence: "fixture",
  }]);
  assert.equal(body, "Body #New topic");
  assert.equal(plugin.conceptTagOnlyDirtyPaths.has(file.path), false);
  await plugin.flushDirty();
  assert.equal(reads, 2, "inline replacement rereads cleaned naming text instead of promoting the old revision");
  assert.equal(plugin.conceptNamingTextCache.get(file.path).text.includes("New"), true);
});

test("registered revert-style body events cannot reuse a tag-only naming cache entry", async () => {
  const file = new TFile("notes/a.md", 1);
  const { plugin, modify, metadataChanged } = registeredConceptEventFixture(file);
  let body = "Body #After topic";
  let reads = 0;
  plugin.app.vault.getAbstractFileByPath = () => file;
  plugin.app.vault.cachedRead = async () => { reads++; return body; };
  plugin.store.updateFile = async () => {};
  plugin.getView = () => null;
  plugin.taggingCommandPort = () => ({});
  await plugin.conceptNamingTextFor(file);
  plugin.conceptTagOnlyDirtyPaths.add(file.path);
  await plugin.runTaggingCommand(async () => {
    body = "Body #Before topic";
    file.stat.mtime++;
    modify();
    metadataChanged();
    return "reverted";
  }, true);
  await plugin.flushDirty();
  assert.equal(reads, 2);
  assert.equal(plugin.conceptNamingTextCache.get(file.path).text.includes("Before"), true);
});

test("dirty edit bursts coalesce into one post-vector taxonomy generation", async () => {
  const plugin = fixture();
  const file = new TFile("notes/a.md", 2);
  file.stat.size = 200;
  let updates = 0;
  let reads = 0;
  plugin.settings.modelChosen = true;
  plugin.app.vault = {
    getAbstractFileByPath: () => file,
    cachedRead: async () => { reads++; return "changed meaningful content"; },
  };
  plugin.store.updateFile = async () => { updates++; };
  plugin.getView = () => null;
  plugin.dirty.add(file.path);
  plugin.dirty.add(file.path);
  plugin.dirty.add(file.path);
  const before = plugin.conceptTaxonomyEpoch;
  await plugin.flushDirty();
  assert.equal(updates, 1);
  assert.equal(reads, 1);
  assert.equal(plugin.conceptTaxonomyEpoch, before + 1);
});

test("registered isolation events suppress taxonomy and active proposals until updateFile commits", async () => {
  const file = new TFile("notes/a.md", 1);
  const peers = [file, new TFile("notes/b.md", 1), new TFile("notes/c.md", 1)];
  const { plugin, modify, metadataChanged } = registeredConceptEventFixture(file);
  let taxonomyBuilds = 0;
  let rankCalls = 0;
  let eligibilityChanged = true;
  const updateEntered = deferred();
  const updateRelease = deferred();
  plugin.app.vault.getAbstractFileByPath = path => peers.find(peer => peer.path === path) ?? null;
  plugin.app.vault.cachedRead = async peer => `${peer.basename} meaningful topic evidence`;
  plugin.store.conceptTaxonomyInput = () => {
    taxonomyBuilds++;
    return peers.map((peer, index) => ({ path: peer.path, title: peer.basename, vec: new Float32Array([1, index / 10]) }));
  };
  plugin.store.refreshConceptEligibility = () => {
    const changed = eligibilityChanged;
    eligibilityChanged = false;
    return changed;
  };
  plugin.store.updateFile = async () => {
    updateEntered.resolve();
    await updateRelease.promise;
  };
  plugin.store.conceptProposalsForNote = async () => {
    rankCalls++;
    return [{ kind: "taxonomy", notePath: file.path, tagPath: "Fresh", confidence: 0.9, evidence: "fixture" }];
  };
  plugin.getView = () => null;

  await plugin.currentTaxonomy();
  assert.equal(taxonomyBuilds, 1);
  modify();
  metadataChanged();
  assert.deepEqual(await plugin.currentTaxonomy(), { nodes: [], leafAssignment: new Map() });
  assert.deepEqual(await plugin.assembleTagProposals(file), []);
  assert.equal(taxonomyBuilds, 1, "pending isolation does not rebuild on old vectors");
  assert.equal(rankCalls, 0, "active review does not rank the stale entry");

  const flushing = plugin.flushDirty();
  await updateEntered.promise;
  assert.deepEqual(await plugin.currentTaxonomy(), { nodes: [], leafAssignment: new Map() });
  assert.equal(taxonomyBuilds, 1, "an in-progress vector update cannot publish taxonomy");
  updateRelease.resolve();
  await flushing;
  await plugin.currentTaxonomy();
  assert.equal(taxonomyBuilds, 2, "the committed generation rebuilds exactly once");
  assert.deepEqual((await plugin.assembleTagProposals(file)).map(proposal => proposal.tagPath), ["Fresh"]);
  assert.equal(rankCalls, 1);
});

test("a registered edit to another note blocks active-note ranking until shared geometry settles", async () => {
  const active = new TFile("notes/a.md", 1);
  const changed = new TFile("notes/b.md", 1);
  const { plugin, modify } = registeredConceptEventFixture(active);
  const updateEntered = deferred();
  const updateRelease = deferred();
  let rankCalls = 0;
  plugin.app.vault.getAbstractFileByPath = path => path === active.path ? active : changed;
  plugin.app.vault.cachedRead = async file => `${file.basename} meaningful topic evidence`;
  plugin.currentTaxonomy = async () => ({ nodes: [], leafAssignment: new Map() });
  plugin.store.updateFile = async () => {
    updateEntered.resolve();
    await updateRelease.promise;
  };
  plugin.store.conceptProposalsForNote = async () => {
    rankCalls++;
    return [{ kind: "taxonomy", notePath: active.path, tagPath: "Fresh", confidence: 0.9, evidence: "fixture" }];
  };
  plugin.getView = () => null;

  modify(changed);
  assert.deepEqual(await plugin.assembleTagProposals(active), []);
  assert.deepEqual(plugin.conceptTagCandidatesFor(active.path), []);
  assert.equal(rankCalls, 0, "a dirty peer blocks ranking against shared stale geometry");

  const flushing = plugin.flushDirty();
  await updateEntered.promise;
  assert.deepEqual(await plugin.assembleTagProposals(active), []);
  assert.equal(rankCalls, 0, "an active peer update keeps local proposals pending");
  updateRelease.resolve();
  await flushing;
  assert.deepEqual((await plugin.assembleTagProposals(active)).map(proposal => proposal.tagPath), ["Fresh"]);
  assert.equal(rankCalls, 1);
});

test("overlapping registered edit flushes share one drain through edits arriving mid-update", async () => {
  const first = new TFile("notes/a.md", 1);
  const second = new TFile("notes/b.md", 1);
  const { plugin, modify } = registeredConceptEventFixture(first);
  const firstUpdateEntered = deferred();
  const firstUpdateRelease = deferred();
  const updatePaths = [];
  let activeUpdates = 0;
  let maximumActiveUpdates = 0;
  let rankCalls = 0;
  plugin.app.vault.getAbstractFileByPath = path => path === first.path ? first : second;
  plugin.app.vault.cachedRead = async file => `${file.basename} changed content`;
  plugin.currentTaxonomy = async () => ({ nodes: [], leafAssignment: new Map() });
  plugin.store.updateFile = async file => {
    activeUpdates++;
    maximumActiveUpdates = Math.max(maximumActiveUpdates, activeUpdates);
    updatePaths.push(file.path);
    if (updatePaths.length === 1) {
      firstUpdateEntered.resolve();
      await firstUpdateRelease.promise;
    }
    activeUpdates--;
  };
  plugin.store.conceptProposalsForNote = async () => {
    rankCalls++;
    return [];
  };
  plugin.getView = () => null;

  modify(first);
  const firstFlush = plugin.flushDirty();
  await firstUpdateEntered.promise;
  modify(first);
  modify(second);
  const epochAfterAllEdits = plugin.conceptTaxonomyEpoch;
  const overlappingFlush = plugin.flushDirty();
  assert.equal(overlappingFlush, firstFlush, "overlapping callers share the same drain flight");
  assert.equal(plugin.conceptTagRefreshPending(), true);
  assert.deepEqual(await plugin.assembleTagProposals(first), []);
  assert.equal(rankCalls, 0);

  firstUpdateRelease.resolve();
  await Promise.all([firstFlush, overlappingFlush]);
  assert.deepEqual(updatePaths, [first.path, first.path, second.path]);
  assert.equal(maximumActiveUpdates, 1, "overlapping flush calls never overlap store mutations");
  assert.equal(plugin.conceptTaxonomyEpoch, epochAfterAllEdits + 1, "the drained burst publishes one geometry generation");
  assert.equal(plugin.conceptTagRefreshPending(), false);
  await plugin.assembleTagProposals(first);
  assert.equal(rankCalls, 1);
});

test("a failed dirty update remains pending and can be retried without a busy loop", async () => {
  const file = new TFile("notes/a.md", 1);
  const { plugin, modify } = registeredConceptEventFixture(file);
  let updateCalls = 0;
  plugin.app.vault.getAbstractFileByPath = () => file;
  plugin.app.vault.cachedRead = async () => "changed content";
  plugin.store.updateFile = async () => {
    updateCalls++;
    if (updateCalls === 1) throw new Error("temporary failure");
  };
  plugin.getView = () => null;

  modify();
  await assert.rejects(plugin.flushDirty(), /temporary failure/);
  assert.equal(updateCalls, 1);
  assert.equal(plugin.conceptTagRefreshPending(), true, "failed work stays dirty instead of exposing stale geometry");
  await plugin.flushDirty();
  assert.equal(updateCalls, 2);
  assert.equal(plugin.conceptTagRefreshPending(), false);
});

test("registered concept edit callbacks request a pending-state render immediately", async () => {
  const file = new TFile("notes/a.md", 1);
  const { plugin, modify, metadataChanged } = registeredConceptEventFixture(file);
  let renderRequests = 0;
  let updateCalls = 0;
  plugin.getView = () => ({ requestRender: () => { renderRequests++; } });
  plugin.store.updateFile = async () => { updateCalls++; };

  modify();
  assert.equal(renderRequests, 1);
  assert.equal(updateCalls, 0, "the pending-state repaint precedes deferred vector work");
  metadataChanged();
  assert.equal(renderRequests, 2);
  assert.equal(updateCalls, 0);
});

test("registered file rename stays pending until the new path is indexed", async () => {
  const oldFile = new TFile("notes/old.md", 1);
  const renamedFile = new TFile("notes/new.md", 2);
  const peers = [new TFile("notes/b.md", 1), new TFile("notes/c.md", 1)];
  const { plugin, rename } = registeredConceptEventFixture(oldFile);
  const indexedPaths = new Set([oldFile.path, ...peers.map(file => file.path)]);
  const updateEntered = deferred();
  const updateRelease = deferred();
  let taxonomyBuilds = 0;
  let rankCalls = 0;
  plugin.app.vault.getMarkdownFiles = () => [renamedFile, ...peers];
  plugin.app.vault.getAbstractFileByPath = path => [renamedFile, ...peers].find(file => file.path === path) ?? null;
  plugin.app.vault.cachedRead = async file => `${file.basename} meaningful topic evidence`;
  plugin.store.renameFile = path => { indexedPaths.delete(path); };
  plugin.store.updateFile = async file => {
    updateEntered.resolve();
    await updateRelease.promise;
    indexedPaths.add(file.path);
  };
  plugin.store.isConceptTagEligible = path => indexedPaths.has(path);
  plugin.store.conceptTaxonomyInput = () => {
    taxonomyBuilds++;
    return [...indexedPaths].map((path, index) => ({
      path, title: path, vec: new Float32Array([1, index / 10]),
    }));
  };
  plugin.store.conceptProposalsForNote = async () => {
    rankCalls++;
    return [{ kind: "taxonomy", notePath: renamedFile.path, tagPath: "Fresh", confidence: 0.9, evidence: "fixture" }];
  };

  await plugin.currentTaxonomy();
  assert.equal(taxonomyBuilds, 1);
  plugin.conceptTagCandidates = {
    key: plugin.tagAssemblyKey(),
    byNote: new Map([[oldFile.path, ["Stale"]]]),
  };
  rename(renamedFile, oldFile.path);
  await updateEntered.promise;
  assert.equal(indexedPaths.has(oldFile.path), false, "the old corpus entry is evicted synchronously");
  assert.deepEqual(plugin.conceptTagCandidatesFor(oldFile.path), []);
  assert.deepEqual(await plugin.currentTaxonomy(), { nodes: [], leafAssignment: new Map() });
  assert.deepEqual(await plugin.assembleTagProposals(renamedFile), []);
  assert.equal(rankCalls, 0);
  assert.equal(taxonomyBuilds, 1);

  updateRelease.resolve();
  await plugin.conceptGeometryUpdateFlight;
  assert.deepEqual([...indexedPaths].sort(), [renamedFile.path, ...peers.map(file => file.path)].sort());
  await plugin.currentTaxonomy();
  assert.equal(taxonomyBuilds, 2, "rename completion exposes exactly one fresh taxonomy generation");
  assert.deepEqual((await plugin.assembleTagProposals(renamedFile)).map(proposal => proposal.tagPath), ["Fresh"]);
  assert.equal(rankCalls, 1);
});

test("registered folder rename drains children while excluded targets remain absent", async () => {
  const active = new TFile("active.md", 1);
  const renamedFolder = new TAbstractFile();
  renamedFolder.path = "Excluded/NewFolder";
  const renamedFiles = [
    new TFile("Excluded/NewFolder/a.md", 2),
    new TFile("Excluded/NewFolder/nested/b.md", 2),
  ];
  const oldPaths = ["OldFolder/a.md", "OldFolder/nested/b.md"];
  const { plugin, rename } = registeredConceptEventFixture(active);
  const indexedPaths = new Set(oldPaths);
  const updatedPaths = [];
  plugin.app.vault.getMarkdownFiles = () => renamedFiles;
  plugin.app.vault.getAbstractFileByPath = path => renamedFiles.find(file => file.path === path) ?? null;
  plugin.app.vault.cachedRead = async () => "folder rename content";
  plugin.store.renameFile = path => { indexedPaths.delete(path); };
  plugin.store.isExcluded = path => path === "Excluded" || path.startsWith("Excluded/");
  plugin.store.isConceptTagEligible = path => indexedPaths.has(path) && !plugin.store.isExcluded(path);
  plugin.store.updateFile = async file => {
    updatedPaths.push(file.path);
    if (!plugin.store.isExcluded(file.path)) indexedPaths.add(file.path);
  };

  rename(renamedFolder, "OldFolder");
  await plugin.conceptGeometryUpdateFlight;
  assert.deepEqual(updatedPaths, renamedFiles.map(file => file.path));
  assert.deepEqual([...indexedPaths], []);
  assert.equal(plugin.conceptTagRefreshPending(), false);
});

test("rename during an active registered dirty drain cannot escape pending or restore the old path", async () => {
  const oldFile = new TFile("notes/old.md", 1);
  const renamedFile = new TFile("notes/new.md", 2);
  const { plugin, modify, rename } = registeredConceptEventFixture(oldFile);
  const firstUpdateEntered = deferred();
  const firstUpdateRelease = deferred();
  const indexedPaths = new Set([oldFile.path]);
  const retiredPaths = new Set();
  const updatedPaths = [];
  let rankCalls = 0;
  let hasRenamed = false;
  plugin.app.vault.getMarkdownFiles = () => [renamedFile];
  plugin.app.vault.getAbstractFileByPath = path => {
    if (!hasRenamed && path === oldFile.path) return oldFile;
    return path === renamedFile.path ? renamedFile : null;
  };
  plugin.app.vault.cachedRead = async file => `${file.basename} content`;
  plugin.store.renameFile = path => {
    retiredPaths.add(path);
    indexedPaths.delete(path);
  };
  plugin.store.updateFile = async file => {
    updatedPaths.push(file.path);
    if (updatedPaths.length === 1) {
      firstUpdateEntered.resolve();
      await firstUpdateRelease.promise;
    }
    if (!retiredPaths.has(file.path)) indexedPaths.add(file.path);
  };
  plugin.store.isConceptTagEligible = path => indexedPaths.has(path);
  plugin.currentTaxonomy = async () => ({ nodes: [], leafAssignment: new Map() });
  plugin.store.conceptProposalsForNote = async () => { rankCalls++; return []; };

  modify(oldFile);
  const draining = plugin.flushDirty();
  await firstUpdateEntered.promise;
  hasRenamed = true;
  rename(renamedFile, oldFile.path);
  const epochAfterRename = plugin.conceptTaxonomyEpoch;
  assert.equal(plugin.conceptTagRefreshPending(), true);
  assert.deepEqual(await plugin.assembleTagProposals(renamedFile), []);
  assert.equal(rankCalls, 0);

  firstUpdateRelease.resolve();
  await draining;
  assert.deepEqual(updatedPaths, [oldFile.path, renamedFile.path]);
  assert.equal(indexedPaths.has(oldFile.path), false);
  assert.equal(indexedPaths.has(renamedFile.path), true);
  assert.equal(plugin.conceptTaxonomyEpoch, epochAfterRename + 1);
  assert.equal(plugin.conceptTagRefreshPending(), false);
});

test("the real store rejects an old-path update invalidated by rename", async () => {
  const oldFile = new TFile("notes/old.md", 1);
  const updateEntered = deferred();
  const updateRelease = deferred();
  const app = {
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getCache: () => ({}), getFileCache: () => ({}), resolvedLinks: {} },
  };
  const store = new IndexStore(app, {}, "rename-race", {
    excludeFolders: [], isolatedAreas: [], topK: 50, minSimilarity: 0.2,
    chunking: true, maxChunks: 48, shortlistSize: 60, showSummary: true,
    headingContext: false, structureInfluence: 0, ideaInfluence: 0, graphInfluence: 0,
  });
  const entry = {
    path: oldFile.path, mtime: 1, dims: 2, chunkCount: 1,
    meanVector: new Float32Array([1, 0]), chunkBytes: new Int8Array([1, 0]), scales: [1],
  };
  store.entries.set(oldFile.path, entry);
  store.persist = async () => {};
  store.embedFile = async () => {
    updateEntered.resolve();
    await updateRelease.promise;
    return entry;
  };

  const staleUpdate = store.updateFile(oldFile);
  await updateEntered.promise;
  store.renameFile(oldFile.path);
  updateRelease.resolve();
  await staleUpdate;
  assert.equal(store.entries.has(oldFile.path), false);
});

test("real persistence acknowledges only rename removals present in its captured snapshot", async () => {
  const oldFiles = [
    new TFile("notes/old-a.md", 1),
    new TFile("notes/old-b.md", 1),
    new TFile("notes/old-c.md", 1),
  ];
  const survivor = new TFile("notes/survivor.md", 1);
  const replacement = new TFile("notes/new-a.md", 2);
  const excludedTarget = new TFile("Excluded/new-b.md", 2);
  const unembeddableTarget = new TFile("notes/new-c.md", 2);
  const firstSnapshotCaptured = deferred();
  const releaseFirstSnapshot = deferred();
  const files = new Map();
  const directories = new Set();
  let binaryWrites = 0;
  const adapter = {
    exists: async path => files.has(path) || directories.has(path),
    mkdir: async path => { directories.add(path); },
    writeBinary: async (path, blob) => {
      binaryWrites++;
      if (binaryWrites === 1) {
        firstSnapshotCaptured.resolve();
        await releaseFirstSnapshot.promise;
      }
      files.set(path, blob.slice(0));
    },
    write: async (path, text) => { files.set(path, text); },
    remove: async path => { files.delete(path); },
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  const app = {
    vault: { adapter, getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getCache: () => ({}), getFileCache: () => ({}), resolvedLinks: {} },
  };
  const store = new IndexStore(app, { modelId: "fixture-model" }, "rename-generation", {
    excludeFolders: ["Excluded"], isolatedAreas: [], topK: 50, minSimilarity: 0.2,
    chunking: true, maxChunks: 48, shortlistSize: 60, showSummary: true,
    headingContext: false, structureInfluence: 0, ideaInfluence: 0, graphInfluence: 0,
  });
  const entryFor = file => ({
    path: file.path, mtime: file.stat.mtime, dims: 2, chunkCount: 1,
    meanVector: new Float32Array([1, 0]), chunkBytes: new Int8Array([1, 0]), scales: [1],
  });
  for (const file of [...oldFiles, survivor]) store.entries.set(file.path, entryFor(file));
  store.embedFile = async file => file.path === unembeddableTarget.path ? null : entryFor(file);

  store.renameFile(oldFiles[0].path);
  const firstReplacement = store.updateFile(replacement);
  await firstSnapshotCaptured.promise;
  store.renameFile(oldFiles[1].path);
  store.renameFile(oldFiles[2].path);
  const excludedReplacement = store.updateFile(excludedTarget);
  const unembeddableReplacement = store.updateFile(unembeddableTarget);
  releaseFirstSnapshot.resolve();
  await Promise.all([firstReplacement, excludedReplacement, unembeddableReplacement]);

  assert.ok(binaryWrites >= 2, "newer removal generations force a later full snapshot");
  const json = files.get("rename-generation/index.json");
  const blob = files.get("rename-generation/index.bin");
  assert.equal(typeof json, "string");
  assert.ok(blob instanceof ArrayBuffer);
  const persistedPaths = deserializeIndex(json, blob).entries.map(entry => entry.path).sort();
  assert.deepEqual(persistedPaths, [replacement.path, survivor.path].sort());
});

test("failed empty-index deletion stays pending and a later tracked update retries it", async () => {
  const oldFile = new TFile("notes/last-old.md", 1);
  const excludedTarget = new TFile("Excluded/new.md", 2);
  const files = new Map();
  const directories = new Set();
  const removalAttempts = new Map();
  let shouldFailManifestRemoval = false;
  const adapter = {
    exists: async path => files.has(path) || directories.has(path),
    mkdir: async path => { directories.add(path); },
    writeBinary: async (path, blob) => { files.set(path, blob.slice(0)); },
    write: async (path, text) => { files.set(path, text); },
    remove: async path => {
      removalAttempts.set(path, (removalAttempts.get(path) ?? 0) + 1);
      if (shouldFailManifestRemoval && path === "empty-retry/index.json") {
        shouldFailManifestRemoval = false;
        throw new Error("temporarily locked");
      }
      files.delete(path);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  const app = {
    vault: { adapter, getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getCache: () => ({}), getFileCache: () => ({}), resolvedLinks: {} },
  };
  const engine = { modelId: "fixture-model" };
  const options = {
    excludeFolders: ["Excluded"], isolatedAreas: [], topK: 50, minSimilarity: 0.2,
    chunking: true, maxChunks: 48, shortlistSize: 60, showSummary: true,
    headingContext: false, structureInfluence: 0, ideaInfluence: 0, graphInfluence: 0,
  };
  const store = new IndexStore(app, engine, "empty-retry", options);
  store.entries.set(oldFile.path, {
    path: oldFile.path, mtime: 1, dims: 2, chunkCount: 1,
    meanVector: new Float32Array([1, 0]), chunkBytes: new Int8Array([1, 0]), scales: [1],
  });
  await store.persist();

  store.renameFile(oldFile.path);
  shouldFailManifestRemoval = true;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await store.updateFile(excludedTarget);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(store.renameRemovalRevision, 1);
  assert.equal(store.persistedRenameRemovalRevision, 0);
  assert.equal(removalAttempts.get("empty-retry/index.json"), 1);
  assert.equal(removalAttempts.get("empty-retry/index.bin"), 1, "strict discard attempts every artifact after one failure");
  assert.equal(files.has("empty-retry/index.json"), true);
  assert.equal(files.has("empty-retry/index.bin"), false);

  await store.updateFile(excludedTarget);
  assert.equal(store.persistedRenameRemovalRevision, 1);
  assert.equal(files.has("empty-retry/index.json"), false);
  assert.equal(files.has("empty-retry/index.bin"), false);
  const reloaded = new IndexStore(app, engine, "empty-retry", options);
  assert.equal(await reloaded.load(), false);
  assert.equal(reloaded.entries.has(oldFile.path), false);
});

test("a nonempty serialization failure cannot acknowledge rename-removal progress", async () => {
  const oldFile = new TFile("notes/old.md", 1);
  const survivor = new TFile("notes/survivor.md", 1);
  const replacement = new TFile("notes/replacement.md", 2);
  const adapter = Object.fromEntries(
    ["exists", "write", "writeBinary", "rename", "remove", "mkdir"].map(name => [name, async () => false]),
  );
  const app = {
    vault: { adapter, getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getCache: () => ({}), getFileCache: () => ({}), resolvedLinks: {} },
  };
  const store = new IndexStore(app, { modelId: "fixture-model" }, "serialize-failure", {
    excludeFolders: [], isolatedAreas: [], topK: 50, minSimilarity: 0.2,
    chunking: true, maxChunks: 48, shortlistSize: 60, showSummary: true,
    headingContext: false, structureInfluence: 0, ideaInfluence: 0, graphInfluence: 0,
  });
  const validEntry = file => ({
    path: file.path, mtime: file.stat.mtime, dims: 1, chunkCount: 1,
    meanVector: new Float32Array([1]), chunkBytes: new Int8Array([1]), scales: [1],
  });
  store.entries.set(oldFile.path, validEntry(oldFile));
  store.entries.set(survivor.path, validEntry(survivor));
  store.embedFile = async file => ({
    path: file.path, mtime: file.stat.mtime, dims: 1, chunkCount: 0,
    meanVector: new Float32Array(8), chunkBytes: new Int8Array(), scales: [],
  });
  const persistFull = store.persistFull.bind(store);
  let persistAttempts = 0;
  store.persistFull = async () => {
    persistAttempts++;
    await persistFull();
  };

  store.renameFile(oldFile.path);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await store.updateFile(replacement);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(persistAttempts, 2, "one replacement write and one bounded pending-removal retry");
  assert.equal(store.renameRemovalRevision, 1);
  assert.equal(store.persistedRenameRemovalRevision, 0);
});

test("active-note and vault review use independent keyed flights", async () => {
  const plugin = fixture();
  const file = new TFile("notes/a.md", 1);
  const gate = deferred();
  let localSweeps = 0;
  let vaultSweeps = 0;
  plugin.store.conceptProposalsForNote = async () => {
    localSweeps++;
    await gate.promise;
    return [];
  };
  plugin.store.computeConceptProposalsAsync = async () => {
    vaultSweeps++;
    await gate.promise;
    return [];
  };
  const pending = Array.from({ length: 20 }, () => plugin.tagPanelDataFor(file));
  const review = plugin.assembleTagProposals();
  await plugin.currentTaxonomy();
  assert.equal(localSweeps, 1);
  assert.equal(vaultSweeps, 1);
  gate.resolve();
  await Promise.all([...pending, review]);
  await plugin.tagPanelDataFor(file);
  assert.equal(localSweeps, 1);
  assert.equal(plugin.tagAssemblyProgress, null);

  plugin.indexEpoch++;
  plugin.store.conceptProposalsForNote = async () => { throw new Error("read failed"); };
  await assert.rejects(plugin.tagPanelDataFor(file), /read failed/);
  plugin.store.conceptProposalsForNote = async () => [];
  await plugin.tagPanelDataFor(file);
});

test("an epoch change during a slice discards the old result", async () => {
  const plugin = fixture();
  let sweeps = 0;
  plugin.store.computeConceptProposalsAsync = async () => {
    sweeps++;
    if (sweeps === 1) plugin.indexEpoch++;
    return [];
  };
  await plugin.assembleTagProposals();
  assert.equal(plugin.conceptTagCandidates.key.split("|")[0], String(plugin.indexEpoch));
  assert.equal(plugin.tagAssemblyInFlight, null);
  assert.ok(sweeps >= 2);
});

test("registered metadata invalidation rejects an in-flight local proposal result", async () => {
  const file = new TFile("notes/a.md", 1);
  const { plugin, metadataChanged } = registeredConceptEventFixture(file);
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  plugin.currentTaxonomy = async () => ({ nodes: [], leafAssignment: new Map() });
  plugin.store.conceptProposalsForNote = async () => {
    calls++;
    if (calls === 1) {
      entered.resolve();
      await release.promise;
    }
    return [{ kind: "taxonomy", notePath: file.path, tagPath: "Fresh", confidence: 0.9, evidence: "fixture" }];
  };
  const pending = plugin.assembleTagProposals(file);
  await entered.promise;
  metadataChanged();
  release.resolve();
  assert.deepEqual((await pending).map(proposal => proposal.tagPath), ["Fresh"]);
  assert.equal(calls, 2);
  assert.equal(plugin.conceptTagCandidates.key, plugin.tagAssemblyKey());
});

const channels = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this); }
};
after(() => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } });

test("real store yields before ranking and preserves complete synchronous output", async () => {
  const files = Array.from({ length: 8 }, (_, index) => new TFile(`note${index}.md`, index + 1));
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: path => files.find(file => file.path === path),
      cachedRead: async file => `${file.basename} ` + "A substantial body about mathematics and numbers. ".repeat(8),
      adapter: Object.fromEntries(["exists", "write", "writeBinary", "rename", "remove", "mkdir"].map(name => [name, async () => true])),
    },
    metadataCache: { getCache: () => ({}), getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { on: () => ({}), getActiveFile: () => null },
  };
  const engine = {
    loaded: true,
    embedBatch: async texts => texts.map(() => new Float32Array([1, 0, 0])),
    embed: async () => new Float32Array([1, 0, 0]),
  };
  const store = new IndexStore(app, engine, "async-check", {
    excludeFolders: [], isolatedAreas: [], topK: 50, minSimilarity: 0.2,
    chunking: true, maxChunks: 48, shortlistSize: 60, showSummary: true,
    headingContext: false, structureInfluence: 0, ideaInfluence: 0, graphInfluence: 0,
  });
  await store.build();
  assert.equal(store.getProgress().status, "ready");
  const expected = store.computeInsights();
  assert.equal(expected.total, files.length);
  const progress = [];
  const pending = store.computeInsightsAsync(new Set(), undefined, (done, total) => progress.push([done, total]));
  assert.deepEqual(progress, [[0, files.length]]); // the first rank waits for a macrotask
  assert.deepEqual(await pending, expected);
  assert.deepEqual(progress, Array.from({ length: files.length + 1 }, (_, done) => [done, files.length]));
});

test("unexcluding a folder during an active build schedules one follow-up reconciliation", async () => {
  const files = [new TFile("Keep/one.md", 1), new TFile("Added/two.md", 2)];
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: path => files.find(file => file.path === path) ?? null,
      cachedRead: async file => `${file.basename} has enough explanatory prose for indexing. `.repeat(8),
      adapter: Object.fromEntries(["exists", "write", "writeBinary", "rename", "remove", "mkdir"].map(name => [name, async () => true])),
    },
    metadataCache: { getCache: () => ({}), getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { on: () => ({}), getActiveFile: () => null },
  };
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const engine = {
    loaded: true,
    embedBatch: async texts => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return texts.map(() => new Float32Array([1, 0, 0]));
    },
    embed: async () => new Float32Array([1, 0, 0]),
  };
  const options = {
    excludeFolders: ["Added"], isolatedAreas: [], topK: 50, minSimilarity: 0.2,
    chunking: true, maxChunks: 48, shortlistSize: 60, showSummary: true,
    headingContext: false, structureInfluence: 0, ideaInfluence: 0, graphInfluence: 0,
  };
  const store = new IndexStore(app, engine, "scope-reconcile-check", options);
  const first = store.build();
  await entered.promise;
  store.updateOptions({ ...options, excludeFolders: [] });
  const reconciled = store.reconcileFiles();
  release.resolve();
  await Promise.all([first, reconciled]);
  assert.equal(store.count, 2);
  assert.equal(store.conceptTaxonomyInput().some(note => note.path === "Added/two.md"), true);
  assert.equal(calls, 2, "the follow-up reuses the first note and embeds only the newly eligible note");
});

test("default 0.6 assembly keeps two supported bridge concepts and lets an outlier abstain", async () => {
  const dimensions = 6;
  const unit = (...components) => {
    const vector = new Float32Array(dimensions);
    components.forEach((component, index) => { vector[index] = component; });
    const length = Math.hypot(...vector) || 1;
    for (let index = 0; index < dimensions; index++) vector[index] /= length;
    return vector;
  };
  const biased = (direction) => unit(...Array.from(direction).map((value, index) => index === 5 ? value + 1 : value));
  const negative = (direction) => new Float32Array(Array.from(direction, value => -value));
  const specs = [];
  const addPair = (name, direction) => {
    specs.push({ path: `notes/${name}.md`, name, vector: biased(direction) });
    specs.push({ path: `Templates/anti-${name}.md`, name: `anti-${name}`, vector: biased(negative(direction)) });
  };
  for (let index = 1; index <= 3; index++) addPair(`alpha-${index}`, unit(1, 0, 0, 0, 0, 0));
  for (let index = 1; index <= 3; index++) addPair(`beta-${index}`, unit(0, 1, 0, 0, 0, 0));
  addPair("bridge", unit(1, 1, 0, 0, 0, 0));
  addPair("outlier", unit(0, 0, 1, 0, 0, 0));
  const files = specs.map((spec, index) => new TFile(spec.path, index + 1));
  const byPath = new Map(files.map(file => [file.path, file]));
  const byName = new Map(specs.map(spec => [spec.name, spec]));
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: path => byPath.get(path) ?? null,
      cachedRead: async file => `${file.basename} ` + "substantial topic evidence and detailed supporting prose ".repeat(8),
      adapter: Object.fromEntries(["exists", "write", "writeBinary", "rename", "remove", "mkdir"].map(name => [name, async () => true])),
    },
    metadataCache: { getCache: () => ({}), getFileCache: () => ({}), resolvedLinks: {} },
    workspace: { on: () => ({}), getActiveFile: () => null },
  };
  const engine = {
    loaded: true,
    embedBatch: async texts => texts.map(text => {
      const spec = Array.from(byName.values()).find(candidate => text === candidate.name || text.startsWith(`${candidate.name} `));
      if (!spec) throw new Error(`no vector fixture for ${text.slice(0, 40)}`);
      return spec.vector;
    }),
    embed: async text => (await engine.embedBatch([text]))[0],
  };
  const store = new IndexStore(app, engine, "default-floor-check", {
    excludeFolders: [], isolatedAreas: [], topK: 50, minSimilarity: 0.2,
    chunking: true, maxChunks: 48, shortlistSize: 60, showSummary: true,
    headingContext: false, structureInfluence: 0, ideaInfluence: 0, graphInfluence: 0,
  });
  await store.build();
  assert.ok(store.centroid && store.centroid[5] > 0.999, "production store geometry has a nonzero corpus centroid");

  const alpha = ["notes/alpha-1.md", "notes/alpha-2.md", "notes/alpha-3.md", "notes/bridge.md", "notes/outlier.md"];
  const beta = ["notes/beta-1.md", "notes/beta-2.md", "notes/beta-3.md"];
  const taxonomy = {
    nodes: [
      { level: 1, segments: ["Alpha"], notePaths: alpha },
      { level: 1, segments: ["Beta"], notePaths: beta },
    ],
    leafAssignment: new Map([...alpha.map(path => [path, "Alpha"]), ...beta.map(path => [path, "Beta"])]),
  };
  const plugin = fixture();
  plugin.app = app;
  plugin.store = store;
  plugin.settings.conceptTagMinConfidence = 0.6;
  plugin.currentTaxonomy = async () => taxonomy;
  const taxonomyRows = (await plugin.assembleTagProposals()).filter(proposal => proposal.kind === "taxonomy");
  const tagsFor = path => taxonomyRows.filter(proposal => proposal.notePath === path).map(proposal => proposal.tagPath);
  assert.deepEqual(tagsFor("notes/bridge.md"), ["Alpha", "Beta"]);
  assert.deepEqual(tagsFor("notes/alpha-1.md"), ["Alpha"]);
  assert.deepEqual(tagsFor("notes/outlier.md"), []);
});
