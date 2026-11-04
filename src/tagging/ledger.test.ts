// Unit tests for the change ledger: offline, synthetic, deterministic (all timestamps injected).
import { test } from "node:test";
import assert from "node:assert/strict";
// Node's type stripping needs the ".ts" specifier; tsconfig (not ours to edit) omits
// allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else.
// @ts-expect-error
import { appendLedgerEntries, journalEntriesForNote, nextBatchOrdinal, pruneLedgerEntries, recordAppliedChanges, revertAppliedChanges, type InlineRevertAccess, type LedgerEntry, type LedgerStoragePort } from "./ledger.ts";
// The type-only import compiles without the extension complaint, so no expect-error here.
import type { ApplyFrontmatterPort, ApplyNoteOutput, ApplyResult } from "./apply.ts";
import type { InlineEditRecord } from "./inline-rewrite.ts";

type AppliedReceipt = ApplyNoteOutput["appliedProposals"][number];

// In-memory storage port over the text seam; null text means "no ledger file yet".
function makeStorage(initial: string | null = null) {
  const state = { text: initial, reads: 0, writes: 0 };
  const storage: LedgerStoragePort = {
    readLedgerText: async () => {
      state.reads += 1;
      return state.text;
    },
    writeLedgerText: async (text: string) => {
      state.writes += 1;
      state.text = text;
    },
  };
  return { storage, state };
}

// In-memory frontmatter port; a note mapped to null has no `tags:` key at all.
function makeFrontmatter(notes: Record<string, string[] | null>, failReads: string[] = [], failWrites: string[] = []) {
  const state = { writes: [] as { notePath: string; tags: string[] }[] };
  const port: ApplyFrontmatterPort = {
    readNoteTags: async (notePath: string) => {
      if (failReads.includes(notePath)) throw new Error(`read threw: ${notePath}`);
      const tags = notes[notePath];
      if (tags === undefined) throw new Error(`unknown note: ${notePath}`);
      return tags === null ? null : [...tags];
    },
    writeNoteTags: async (notePath: string, tags: string[]) => {
      if (failWrites.includes(notePath)) throw new Error(`write threw: ${notePath}`);
      state.writes.push({ notePath, tags: [...tags] });
      notes[notePath] = [...tags];
    },
  };
  return { port, state };
}

// In-memory inline text port; a note mapped to null is missing from the vault.
function makeInlineAccess(notes: Record<string, string | null>, failReads: string[] = [], failWrites: string[] = []) {
  const state = { writes: [] as { notePath: string; text: string }[] };
  const access: InlineRevertAccess = {
    readNoteContent: async (notePath: string) => {
      if (failReads.includes(notePath)) throw new Error(`read threw: ${notePath}`);
      const text = notes[notePath];
      if (text === undefined) throw new Error(`unknown note: ${notePath}`);
      return text;
    },
    writeNoteContent: async (notePath: string, text: string) => {
      if (failWrites.includes(notePath)) throw new Error(`write threw: ${notePath}`);
      state.writes.push({ notePath, text });
      notes[notePath] = text;
    },
  };
  return { access, state };
}

function receipt(kind: AppliedReceipt["kind"], tagPath: string, addedTags: string[], removedTags: string[]): AppliedReceipt {
  return { kind, tagPath, replacesTag: null, addedTags, removedTags };
}

function applyResultFor(notePath: string, tagsBefore: string[], tagsAfter: string[], appliedProposals: AppliedReceipt[]): ApplyResult {
  return {
    notes: [{ notePath, tagsBefore, tagsAfter, appliedProposals, skippedProposals: [] }],
    appliedProposalCount: appliedProposals.length,
    skippedProposalCount: 0,
    mutatedNoteCount: 1,
  };
}

function entry(overrides: Partial<LedgerEntry> & Pick<LedgerEntry, "notePath" | "timestamp" | "tagPath">): LedgerEntry {
  return {
    kind: "taxonomy",
    addedTags: [],
    removedTags: [],
    tagsBefore: [],
    tagsAfter: [],
    batch: 1, // persisted batch identity; multi-batch fixtures override with distinct ordinals
    ...overrides,
  };
}

void test("record then revert restores the exact before-array", async () => {
  const { storage, state } = makeStorage();
  const result = applyResultFor("notes/a.md", ["Existing"], ["Existing", "MachineLearning"], [
    receipt("taxonomy", "MachineLearning", ["MachineLearning"], []),
  ]);
  await recordAppliedChanges(result, storage, 1000);
  const expected: LedgerEntry = {
    notePath: "notes/a.md",
    timestamp: 1000,
    batch: 1, // an empty persisted journal allocates ordinal 1
    kind: "taxonomy",
    tagPath: "MachineLearning",
    addedTags: ["MachineLearning"],
    removedTags: [],
    tagsBefore: ["Existing"],
    tagsAfter: ["Existing", "MachineLearning"],
  };
  assert.equal(state.text, JSON.stringify([expected])); // persisted form is JSON.stringify(entries)
  const fm = makeFrontmatter({ "notes/a.md": ["Existing", "MachineLearning"] });
  const reverted = await revertAppliedChanges(storage, fm.port);
  assert.deepEqual(fm.state.writes, [{ notePath: "notes/a.md", tags: ["Existing"] }]); // exact before-array, order intact
  assert.equal(reverted.appliedProposalCount, 1);
  assert.equal(reverted.skippedProposalCount, 0);
  assert.equal(reverted.mutatedNoteCount, 1);
  const note = reverted.notes[0];
  assert.deepEqual(note.tagsBefore, ["Existing", "MachineLearning"]);
  assert.deepEqual(note.tagsAfter, ["Existing"]);
  assert.deepEqual(note.appliedProposals, [receipt("taxonomy", "MachineLearning", [], ["MachineLearning"])]);
  assert.equal(state.text, "[]"); // the consumed entry left the journal
});

void test("record appends after already-stored entries in journal order", async () => {
  const stored = entry({ notePath: "notes/old.md", timestamp: 1, batch: 7, tagPath: "Old" });
  const { storage, state } = makeStorage(JSON.stringify([stored]));
  await recordAppliedChanges(applyResultFor("notes/new.md", [], ["New"], [receipt("placement", "New", ["New"], [])]), storage, 2);
  assert.deepEqual(JSON.parse(state.text!), [stored, entry({ notePath: "notes/new.md", timestamp: 2, batch: 8, kind: "placement", tagPath: "New", addedTags: ["New"], tagsAfter: ["New"] })]); // the allocated ordinal is the persisted maximum + 1
});

void test("an empty ApplyResult writes nothing, not even a journal read", async () => {
  const { storage, state } = makeStorage();
  await recordAppliedChanges({ notes: [], appliedProposalCount: 0, skippedProposalCount: 0, mutatedNoteCount: 0 }, storage, 5);
  assert.deepEqual([state.reads, state.writes, state.text], [0, 0, null]);
});

void test("revert over an absent ledger reads null and writes nothing", async () => {
  const { storage, state } = makeStorage(null);
  const fm = makeFrontmatter({});
  const reverted = await revertAppliedChanges(storage, fm.port);
  assert.deepEqual(reverted, { notes: [], appliedProposalCount: 0, skippedProposalCount: 0, mutatedNoteCount: 0 });
  assert.deepEqual([state.writes, state.text], [0, null]);
});

void test("partial revert by filter touches only the selected note", async () => {
  const journal: LedgerEntry[] = [
    entry({ notePath: "notes/a.md", timestamp: 10, tagPath: "Alpha", addedTags: ["Alpha"], tagsBefore: ["KeptA"], tagsAfter: ["KeptA", "Alpha"] }),
    entry({ notePath: "notes/b.md", timestamp: 20, tagPath: "Beta", addedTags: ["Beta"], tagsBefore: ["KeptB"], tagsAfter: ["KeptB", "Beta"] }),
  ];
  const { storage, state } = makeStorage(JSON.stringify(journal));
  const fm = makeFrontmatter({ "notes/a.md": ["KeptA", "Alpha"], "notes/b.md": ["KeptB", "Beta"] });
  const reverted = await revertAppliedChanges(storage, fm.port, undefined, (e) => e.notePath === "notes/a.md");
  assert.deepEqual(fm.state.writes, [{ notePath: "notes/a.md", tags: ["KeptA"] }]); // note b is untouched
  assert.deepEqual(reverted.notes.map((n) => n.notePath), ["notes/a.md"]);
  assert.deepEqual(JSON.parse(state.text!), [journal[1]]); // only the consumed entry left the journal
});

void test("guards hold: reverting an early entry whose tag a later live entry replaced removes nothing", async () => {
  const added = entry({ notePath: "n.md", timestamp: 100, tagPath: "Foo", addedTags: ["Foo"], tagsBefore: ["Base"], tagsAfter: ["Base", "Foo"] });
  const replaced = entry({ notePath: "n.md", timestamp: 200, tagPath: "FooBar", addedTags: ["FooBar"], removedTags: ["Foo"], tagsBefore: ["Base", "Foo"], tagsAfter: ["Base", "FooBar"] });
  const { storage, state } = makeStorage(JSON.stringify([added, replaced]));
  const fm = makeFrontmatter({ "n.md": ["Base", "FooBar"] });
  const reverted = await revertAppliedChanges(storage, fm.port, undefined, (e) => e.tagPath === "Foo");
  // "Foo" is no longer present (the live replacement carries "FooBar"), so the entry acts on nothing:
  // consumed from the journal, reported in neither count, and the live replacement survives unwritten.
  assert.deepEqual(reverted, { notes: [], appliedProposalCount: 0, skippedProposalCount: 0, mutatedNoteCount: 0 });
  assert.deepEqual(fm.state.writes, []);
  assert.deepEqual(JSON.parse(state.text!), [replaced]);
});

void test("revert-all of the same journal restores the fully-undone state oldest-first", async () => {
  const added = entry({ notePath: "n.md", timestamp: 100, tagPath: "Foo", addedTags: ["Foo"], tagsBefore: ["Base"], tagsAfter: ["Base", "Foo"] });
  const replaced = entry({ notePath: "n.md", timestamp: 200, tagPath: "FooBar", kind: "normalization", addedTags: ["FooBar"], removedTags: ["Foo"], tagsBefore: ["Base", "Foo"], tagsAfter: ["Base", "FooBar"] });
  const { storage, state } = makeStorage(JSON.stringify([added, replaced]));
  const fm = makeFrontmatter({ "n.md": ["Base", "FooBar"] });
  const reverted = await revertAppliedChanges(storage, fm.port);
  assert.deepEqual(fm.state.writes, [{ notePath: "n.md", tags: ["Base", "Foo"] }]); // "Foo" restored exactly once, at the end
  const note = reverted.notes[0];
  assert.deepEqual(note.tagsBefore, ["Base", "FooBar"]); // arrays around the whole revert of the note
  assert.deepEqual(note.tagsAfter, ["Base", "Foo"]);
  assert.deepEqual(note.appliedProposals, [receipt("normalization", "FooBar", ["Foo"], ["FooBar"])]); // only the entry that changed tags
  assert.equal(reverted.mutatedNoteCount, 1);
  assert.equal(state.text, "[]"); // both entries consumed, the no-action one too
});

void test("revert of a note whose tags key has since vanished creates it from the restored forms", async () => {
  const replaced = entry({ notePath: "gone.md", timestamp: 5, tagPath: "B", kind: "normalization", addedTags: ["B"], removedTags: ["A"], tagsBefore: ["A"], tagsAfter: ["B"] });
  const { storage } = makeStorage(JSON.stringify([replaced]));
  const fm = makeFrontmatter({ "gone.md": null }); // no `tags:` key anymore
  const reverted = await revertAppliedChanges(storage, fm.port);
  assert.deepEqual(fm.state.writes, [{ notePath: "gone.md", tags: ["A"] }]); // null read + restorations writes the key
  assert.deepEqual(reverted.notes[0].tagsBefore, []);
  assert.deepEqual(reverted.notes[0].tagsAfter, ["A"]);
});

void test("restored forms append after the surviving tags in journal order", async () => {
  const e = entry({ notePath: "r.md", timestamp: 7, tagPath: "X", kind: "placement", addedTags: ["X"], removedTags: ["Y", "Z"], tagsBefore: ["K", "Y", "Z"], tagsAfter: ["K", "X"] });
  const { storage } = makeStorage(JSON.stringify([e]));
  const fm = makeFrontmatter({ "r.md": ["K", "X"] });
  await revertAppliedChanges(storage, fm.port);
  assert.deepEqual(fm.state.writes, [{ notePath: "r.md", tags: ["K", "Y", "Z"] }]);
});

void test("revert matches exact string forms, never case-insensitively", async () => {
  const e = entry({ notePath: "c.md", timestamp: 9, tagPath: "Foo", addedTags: ["Foo"], removedTags: ["bar"], tagsBefore: ["bar"], tagsAfter: ["Foo"] });
  const { storage } = makeStorage(JSON.stringify([e]));
  const fm = makeFrontmatter({ "c.md": ["foo"] }); // user renamed the case meanwhile
  await revertAppliedChanges(storage, fm.port);
  assert.deepEqual(fm.state.writes, [{ notePath: "c.md", tags: ["foo", "bar"] }]); // "Foo" not present exactly: nothing removed; "bar" restored alongside "foo"
});

void test("a note whose read throws keeps its entries and reports note-unavailable", async () => {
  const e1 = entry({ notePath: "down.md", timestamp: 1, tagPath: "One", addedTags: ["One"] });
  const e2 = entry({ notePath: "down.md", timestamp: 2, tagPath: "Two", addedTags: ["Two"] });
  const seed = JSON.stringify([e1, e2]);
  const { storage, state } = makeStorage(seed);
  const fm = makeFrontmatter({}, ["down.md"]);
  const reverted = await revertAppliedChanges(storage, fm.port);
  assert.deepEqual(reverted.notes, [{
    notePath: "down.md",
    tagsBefore: [],
    tagsAfter: [],
    appliedProposals: [],
    skippedProposals: [
      { tagPath: "One", reason: "note-unavailable" },
      { tagPath: "Two", reason: "note-unavailable" },
    ],
  }]);
  assert.deepEqual([reverted.skippedProposalCount, reverted.mutatedNoteCount], [2, 0]);
  assert.equal(state.text, seed); // the journal is untouched: the entries stay revertible
});

void test("a note whose write throws keeps its entries while the other note reverts", async () => {
  const good = entry({ notePath: "good.md", timestamp: 1, tagPath: "Good", addedTags: ["Good"], tagsBefore: [], tagsAfter: ["Good"] });
  const bad = entry({ notePath: "bad.md", timestamp: 2, tagPath: "Bad", addedTags: ["Bad"], tagsBefore: [], tagsAfter: ["Bad"] });
  const { storage, state } = makeStorage(JSON.stringify([good, bad]));
  const fm = makeFrontmatter({ "good.md": ["Good"], "bad.md": ["Bad"] }, [], ["bad.md"]);
  const reverted = await revertAppliedChanges(storage, fm.port);
  assert.deepEqual(fm.state.writes, [{ notePath: "good.md", tags: [] }]);
  assert.deepEqual(reverted.notes.find((n) => n.notePath === "bad.md")?.skippedProposals, [{ tagPath: "Bad", reason: "note-unavailable" }]);
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [1, 1, 1]);
  assert.deepEqual(JSON.parse(state.text!), [bad]); // only the failed note's entry survives in the journal
});

void test("pruning with keep-all retention (0) leaves the journal untouched", async () => {
  const seed = JSON.stringify([entry({ notePath: "a.md", timestamp: 0, tagPath: "A" })]);
  const { storage, state } = makeStorage(seed);
  assert.equal(await pruneLedgerEntries(storage, 0, 999 * 86400000), 0);
  assert.equal(await pruneLedgerEntries(storage, -3, 999 * 86400000), 0);
  assert.equal(state.text, seed); // no rewrite at all: keep-all is the default
});

void test("windowed pruning removes only entries older than the retention window", async () => {
  const now = 1_700_000_000_000;
  const day = 86400000;
  const old = entry({ notePath: "old.md", timestamp: now - 31 * day, tagPath: "Old" });
  const edge = entry({ notePath: "edge.md", timestamp: now - 30 * day, tagPath: "Edge" }); // exactly at the cutoff survives
  const fresh = entry({ notePath: "fresh.md", timestamp: now, tagPath: "Fresh" });
  const { storage, state } = makeStorage(JSON.stringify([old, edge, fresh]));
  assert.equal(await pruneLedgerEntries(storage, 30, now), 1);
  assert.deepEqual(JSON.parse(state.text!), [edge, fresh]); // remainder persisted in order
});

void test("malformed stored JSON makes every ledger operation throw", async () => {
  for (const text of ["{ not json", "5"]) {
    const { storage } = makeStorage(text);
    const fm = makeFrontmatter({});
    await assert.rejects(recordAppliedChanges(applyResultFor("n.md", [], ["T"], [receipt("taxonomy", "T", ["T"], [])]), storage, 1));
    await assert.rejects(revertAppliedChanges(storage, fm.port));
    await assert.rejects(pruneLedgerEntries(storage, 30, 1));
  }
});

// ---------------------------------------------------------------------------
// QA HOLD cycle 1 amendment (F3 + F4): inline entries, entry builder, append,
// guarded inline reversion.
// ---------------------------------------------------------------------------

void test("journalEntriesForNote maps a note output to entries, copying inline edit records", () => {
  const inlineEdits: InlineEditRecord[] = [{ start: 4, end: 9, before: "#OldT", after: "#NewT" }];
  const note: ApplyNoteOutput = {
    notePath: "n.md",
    tagsBefore: ["Base"],
    tagsAfter: ["Base", "NewT"],
    appliedProposals: [
      { ...receipt("normalization", "NewT", ["NewT"], ["OldT"]), inlineEdits },
      receipt("taxonomy", "Extra", ["Extra"], []),
    ],
    skippedProposals: [],
  };
  const entries = journalEntriesForNote(note, 42, 5);
  assert.equal(entries.length, 2); // one entry per applied proposal, in appliedProposals order
  assert.deepEqual(entries[0], {
    notePath: "n.md",
    timestamp: 42,
    batch: 5, // the caller's allocated ordinal is stamped onto every entry of the batch
    kind: "normalization",
    tagPath: "NewT",
    addedTags: ["NewT"],
    removedTags: ["OldT"],
    tagsBefore: ["Base"],
    tagsAfter: ["Base", "NewT"],
    inlineEdits: [{ start: 4, end: 9, before: "#OldT", after: "#NewT" }],
  });
  assert.equal(entries[1].inlineEdits, undefined); // a proposal without inline plans yields no key
  inlineEdits[0].start = 0;
  inlineEdits.push({ start: 0, end: 0, before: "", after: "" });
  assert.deepEqual(entries[0].inlineEdits, [{ start: 4, end: 9, before: "#OldT", after: "#NewT" }]); // copied, never the caller's array or records
});

void test("appendLedgerEntries persists entries while preserving the stored journal", async () => {
  const stored = entry({ notePath: "notes/old.md", timestamp: 1, tagPath: "Old" });
  const { storage, state } = makeStorage(JSON.stringify([stored]));
  const fresh = entry({ notePath: "notes/new.md", timestamp: 2, kind: "placement", tagPath: "New", addedTags: ["New"] });
  await appendLedgerEntries([fresh], storage);
  assert.deepEqual(JSON.parse(state.text!), [stored, fresh]); // prior entries survive in journal order
  await appendLedgerEntries([], storage); // an empty append touches nothing, not even a read
  assert.deepEqual([state.reads, state.writes], [1, 1]);
});

void test("revert restores inline anchors still holding `after` and retains the entry when other records skip", async () => {
  // Content "x #NewT y #Touched z #Missing": anchor 1 still equals its `after`, anchor 2 was
  // retyped since the commit, anchor 3's plan never committed (the slice still equals `before`).
  const content = "x #NewT y #Touched z #Missing";
  const inlineEdits: InlineEditRecord[] = [
    { start: 2, end: 7, before: "#OldT", after: "#NewT" },
    { start: 10, end: 18, before: "#Gone", after: "#Retyped" },
    { start: 21, end: 29, before: "#Missing", after: "#Committed" },
  ];
  const e = entry({ notePath: "i.md", timestamp: 1, tagPath: "OldT", inlineEdits });
  const { storage, state } = makeStorage(JSON.stringify([e]));
  const fm = makeFrontmatter({ "i.md": ["Keep"] });
  const text = makeInlineAccess({ "i.md": content });
  const reverted = await revertAppliedChanges(storage, fm.port, text.access);
  assert.deepEqual(text.state.writes, [{ notePath: "i.md", text: "x #OldT y #Touched z #Missing" }]); // only the surviving anchor restored, no clobber
  assert.deepEqual(fm.state.writes, []); // the frontmatter channel acts on nothing here
  assert.deepEqual(reverted.notes[0].skippedProposals, [
    { tagPath: "OldT", reason: "inline-unavailable" },
    { tagPath: "OldT", reason: "inline-unavailable" },
  ]); // one skip receipt per guard-skipped record
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [0, 2, 1]); // inline mutation counts as a mutation
  assert.deepEqual(reverted.notes[0].tagsBefore, ["Keep"]); // arrays around the revert: tags untouched
  assert.deepEqual(reverted.notes[0].tagsAfter, ["Keep"]);
  assert.equal(state.text, JSON.stringify([e])); // any guard failure retains the entry: its undo is not whole (H2)
});

void test("revert without inline access reverts the frontmatter part, reports inline records skipped and retains the entry", async () => {
  const e = entry({
    notePath: "na.md",
    timestamp: 1,
    kind: "normalization",
    tagPath: "NewT",
    addedTags: ["NewT"],
    removedTags: ["OldT"],
    tagsBefore: ["OldT"],
    tagsAfter: ["NewT"],
    inlineEdits: [{ start: 0, end: 5, before: "#OldT", after: "#NewT" }],
  });
  const { storage, state } = makeStorage(JSON.stringify([e]));
  const fm = makeFrontmatter({ "na.md": ["NewT"] });
  const reverted = await revertAppliedChanges(storage, fm.port); // no inline access: the text is not touched
  assert.deepEqual(fm.state.writes, [{ notePath: "na.md", tags: ["OldT"] }]); // the frontmatter part reverts by the guards
  assert.deepEqual(reverted.notes[0].appliedProposals, [receipt("normalization", "NewT", ["OldT"], ["NewT"])]);
  assert.deepEqual(reverted.notes[0].skippedProposals, [{ tagPath: "NewT", reason: "inline-unavailable" }]); // the caller cannot safely touch text it has no access to
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [1, 1, 1]);
  assert.equal(state.text, JSON.stringify([e])); // unrestored inline records keep the entry pending (H2)
});

void test("phantom entry: revert reports the never-committed inline plan and keeps the entry pending", async () => {
  const e = entry({
    notePath: "ph.md",
    timestamp: 5,
    kind: "normalization",
    tagPath: "B",
    addedTags: ["B"],
    removedTags: ["A"],
    tagsBefore: ["A"],
    tagsAfter: ["B"],
    inlineEdits: [{ start: 6, end: 8, before: "#A", after: "#B" }],
  });
  const { storage, state } = makeStorage(JSON.stringify([e]));
  const fm = makeFrontmatter({ "ph.md": ["A"] }); // the note's mutation never happened: "B" absent, "A" still present
  const text = makeInlineAccess({ "ph.md": "hello #A world" }); // the inline plan never committed either: the slice still equals `before`
  const reverted = await revertAppliedChanges(storage, fm.port, text.access);
  assert.deepEqual(fm.state.writes, []); // tags untouched
  assert.deepEqual(text.state.writes, []); // text untouched
  assert.deepEqual(reverted.notes[0].skippedProposals, [{ tagPath: "B", reason: "inline-unavailable" }]); // the never-committed plan is reported, never forced
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [0, 1, 0]);
  assert.equal(state.text, JSON.stringify([e])); // the never-committed record stays pending (H2): the journal is not emptied
});

void test("partial write recovery: revert restores the completed note and consumes the crashed note's phantom", async () => {
  const first = entry({ notePath: "first.md", timestamp: 1, tagPath: "X", addedTags: ["X"], tagsBefore: [], tagsAfter: ["X"] });
  const second = entry({ notePath: "second.md", timestamp: 2, tagPath: "Y", addedTags: ["Y"], tagsBefore: [], tagsAfter: ["Y"] });
  const { storage, state } = makeStorage(JSON.stringify([first, second])); // both journaled write-ahead
  const fm = makeFrontmatter({ "first.md": ["X"], "second.md": [] }); // the first note's write completed, the second's crashed
  const reverted = await revertAppliedChanges(storage, fm.port);
  assert.deepEqual(fm.state.writes, [{ notePath: "first.md", tags: [] }]); // exactly the first note is restored
  assert.deepEqual(reverted.notes[0].appliedProposals, [receipt("taxonomy", "X", [], ["X"])]); // only the completed note appears in the receipt
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [1, 0, 1]);
  assert.equal(state.text, "[]"); // both entries consumed: the phantom acted on nothing
});

void test("an inline access throw keeps the note's entries; a later revert retries only the inline part", async () => {
  const e = entry({
    notePath: "mix.md",
    timestamp: 1,
    kind: "normalization",
    tagPath: "NewT",
    addedTags: ["NewT"],
    removedTags: ["OldT"],
    tagsBefore: ["OldT"],
    tagsAfter: ["NewT"],
    inlineEdits: [{ start: 5, end: 10, before: "#OldT", after: "#NewT" }],
  });
  const { storage, state } = makeStorage(JSON.stringify([e]));
  const fm = makeFrontmatter({ "mix.md": ["NewT"] });
  const texts: Record<string, string | null> = { "mix.md": "lead #NewT tail" };
  const broken = makeInlineAccess(texts, ["mix.md"]);
  const first = await revertAppliedChanges(storage, fm.port, broken.access);
  assert.deepEqual(fm.state.writes, [{ notePath: "mix.md", tags: ["OldT"] }]); // the frontmatter part landed
  assert.deepEqual(first.notes[0].skippedProposals, [{ tagPath: "NewT", reason: "inline-unavailable" }]);
  assert.equal(state.text, JSON.stringify([e])); // the entries stand: the inline part is still revertible
  const working = makeInlineAccess(texts);
  const second = await revertAppliedChanges(storage, fm.port, working.access);
  assert.deepEqual(fm.state.writes, [{ notePath: "mix.md", tags: ["OldT"] }]); // the guards make the frontmatter retry a no-op, not a double revert
  assert.deepEqual(working.state.writes, [{ notePath: "mix.md", text: "lead #OldT tail" }]); // the inline part completes
  assert.deepEqual([second.appliedProposalCount, second.skippedProposalCount, second.mutatedNoteCount], [0, 0, 1]);
  assert.equal(state.text, "[]"); // only now is the entry consumed
});

// ---------------------------------------------------------------------------
// QA HOLD cycle 2 amendment (B2): LIFO inline undo, exact-inverse restoration,
// per-entry retention on any guard failure.
// ---------------------------------------------------------------------------

// Shared fixture: two apply calls whose rewrites BOTH change lengths —
// "#aa" -> "#AlphaBeta" grows, "#bbb" -> "#B" shrinks — across both channels.
// Records are anchored in each batch's final frame, as the commit path writes them.
function lengthChangeBatches(notePath: string) {
  const older = entry({
    notePath,
    timestamp: 1000,
    batch: 1, // first apply invocation's write for the note
    kind: "normalization",
    tagPath: "AlphaBeta",
    addedTags: ["AlphaBeta"],
    removedTags: ["aa"],
    tagsBefore: ["aa", "bbb"],
    tagsAfter: ["AlphaBeta", "bbb"],
    inlineEdits: [{ start: 4, end: 14, before: "#aa", after: "#AlphaBeta" }], // in the frame of batch 1's final body
  });
  const newer = entry({
    notePath,
    timestamp: 2000,
    batch: 2, // second apply invocation: a distinct persisted ordinal, not a distinct time
    kind: "normalization",
    tagPath: "B",
    addedTags: ["B"],
    removedTags: ["bbb"],
    tagsBefore: ["AlphaBeta", "bbb"],
    tagsAfter: ["AlphaBeta", "B"],
    inlineEdits: [{ start: 19, end: 21, before: "#bbb", after: "#B" }], // in the frame of batch 2's final body
  });
  return {
    older,
    newer,
    originalBody: "one #aa two #bbb three",
    appliedBody: "one #AlphaBeta two #B three",
    originalTags: ["aa", "bbb"],
    appliedTags: ["AlphaBeta", "B"],
  };
}

void test("QA probe scenario: revert-all of two batches restores the exact original body and frontmatter, journal emptied, counts truthful", async () => {
  // Faithful transcription of QA probe 2 ("a #mri b #city c": mri at t=1000, city at t=2000).
  const mri = entry({
    notePath: "probe.md",
    timestamp: 1000,
    batch: 1,
    kind: "normalization",
    tagPath: "Physics/MRI",
    addedTags: ["Physics/MRI"],
    removedTags: ["mri"],
    tagsBefore: ["mri", "city"],
    tagsAfter: ["Physics/MRI", "city"],
    inlineEdits: [{ start: 2, end: 14, before: "#mri", after: "#Physics/MRI" }],
  });
  const city = entry({
    notePath: "probe.md",
    timestamp: 2000,
    batch: 2,
    kind: "normalization",
    tagPath: "City",
    addedTags: ["City"],
    removedTags: ["city"],
    tagsBefore: ["Physics/MRI", "city"],
    tagsAfter: ["Physics/MRI", "City"],
    inlineEdits: [{ start: 17, end: 22, before: "#city", after: "#City" }],
  });
  const { storage, state } = makeStorage(JSON.stringify([mri, city]));
  const fm = makeFrontmatter({ "probe.md": ["Physics/MRI", "City"] });
  const text = makeInlineAccess({ "probe.md": "a #Physics/MRI b #City c" });
  const reverted = await revertAppliedChanges(storage, fm.port, text.access);
  assert.equal(text.state.writes.at(-1)?.text, "a #mri b #city c"); // exact original body — the pinned LIFO invariant
  assert.deepEqual(reverted.notes[0].tagsAfter, ["mri", "city"]); // exact original frontmatter, order intact
  assert.deepEqual(reverted.notes[0].skippedProposals, []); // no hidden guard failures
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [2, 0, 1]); // truthful counts
  assert.equal(state.text, "[]"); // the journal empties only because BOTH undos fully completed
});

void test("one apply call's entries share their allocated batch: revert restores the exact original in one merged call", async () => {
  // SUPERSEDED IDENTITY NOTE (QA HOLD cycle 3): this case was pinned under
  // cycle 2 on "one timestamp = one batch, ties by reverse journal position".
  // The identity is now the persisted batch ordinal: ONE apply invocation's
  // journal write carries ONE allocated ordinal regardless of the clock, and
  // the batch's entries revert through ONE merged call. The restore itself is
  // unchanged — the pinned invariant stands under the new identity.
  const { storage, state } = makeStorage();
  await recordAppliedChanges(applyResultFor("b.md", ["alpha", "beta"], ["A", "BB"], [
    { ...receipt("normalization", "A", ["A"], ["alpha"]), inlineEdits: [{ start: 2, end: 4, before: "#alpha", after: "#A" }] },
    { ...receipt("normalization", "BB", ["BB"], ["beta"]), inlineEdits: [{ start: 7, end: 10, before: "#beta", after: "#BB" }] },
  ]), storage, 100); // one allocation: the same ordinal on every entry of this write
  assert.deepEqual((JSON.parse(state.text!) as LedgerEntry[]).map((e) => e.batch), [1, 1]); // the batch is the identity, never the clock
  const fm = makeFrontmatter({ "b.md": ["A", "BB"] });
  const text = makeInlineAccess({ "b.md": "q #A r #BB s" });
  const reverted = await revertAppliedChanges(storage, fm.port, text.access);
  assert.equal(text.state.writes.at(-1)?.text, "q #alpha r #beta s"); // exact original body
  assert.deepEqual(fm.state.writes.at(-1)?.tags, ["alpha", "beta"]); // exact original frontmatter
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [2, 0, 1]);
  assert.equal(state.text, "[]"); // both entries consumed: each entry's own revert fully completed
});

void test("two batches with changing lengths: one revert call restores the exact original; newest-only filter leaves the older batch intact", async () => {
  const f = lengthChangeBatches("c.md");
  const full = makeStorage(JSON.stringify([f.older, f.newer]));
  const fmAll = makeFrontmatter({ "c.md": [...f.appliedTags] });
  const textAll = makeInlineAccess({ "c.md": f.appliedBody });
  const reverted = await revertAppliedChanges(full.storage, fmAll.port, textAll.access);
  assert.equal(textAll.state.writes.at(-1)?.text, f.originalBody); // exact original body in ONE call, lengths drifted both ways
  assert.deepEqual(fmAll.state.writes.at(-1)?.tags, f.originalTags); // exact original frontmatter
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [2, 0, 1]);
  assert.equal(full.state.text, "[]"); // both consumed
  const filtered = makeStorage(JSON.stringify([f.older, f.newer]));
  const fmNew = makeFrontmatter({ "c.md": [...f.appliedTags] });
  const textNew = makeInlineAccess({ "c.md": f.appliedBody });
  const newest = await revertAppliedChanges(filtered.storage, fmNew.port, textNew.access, (e) => e.timestamp === 2000);
  assert.equal(textNew.state.writes.at(-1)?.text, "one #AlphaBeta two #bbb three"); // only the newest batch's anchor reverted
  assert.deepEqual(fmNew.state.writes.at(-1)?.tags, ["AlphaBeta", "bbb"]); // the older batch's tag change stands
  assert.deepEqual([newest.appliedProposalCount, newest.skippedProposalCount, newest.mutatedNoteCount], [1, 0, 1]);
  assert.deepEqual(JSON.parse(filtered.state.text!), [f.older]); // the unselected older entry stays in the journal
});

void test("intervening edit inside one reverted anchor: that entry is retained with skip receipts, later retries never double-restore, the other entry reverts and consumes", async () => {
  const older = entry({
    notePath: "ed.md",
    timestamp: 1000,
    batch: 1, // first apply invocation's write for the note
    kind: "normalization",
    tagPath: "ONE",
    addedTags: ["ONE"],
    removedTags: ["one"],
    tagsBefore: ["one", "two"],
    tagsAfter: ["ONE", "two"],
    inlineEdits: [{ start: 2, end: 6, before: "#one", after: "#ONE" }],
  });
  const newer = entry({
    notePath: "ed.md",
    timestamp: 2000,
    batch: 2, // second apply invocation: a distinct persisted ordinal, not a distinct time
    kind: "normalization",
    tagPath: "TWO",
    addedTags: ["TWO"],
    removedTags: ["two"],
    tagsBefore: ["ONE", "two"],
    tagsAfter: ["ONE", "TWO"],
    inlineEdits: [{ start: 9, end: 13, before: "#two", after: "#TWO" }],
  });
  const { storage, state } = makeStorage(JSON.stringify([older, newer]));
  const fm = makeFrontmatter({ "ed.md": ["ONE", "TWO"] });
  const texts: Record<string, string | null> = { "ed.md": "z #oNe y #TWO x" }; // user retyped batch 1's anchor (same length) between commit and revert
  const text = makeInlineAccess(texts);
  const first = await revertAppliedChanges(storage, fm.port, text.access);
  assert.equal(text.state.writes.at(-1)?.text, "z #oNe y #two x"); // the healthy anchor reverted, the retyped one left alone
  assert.deepEqual(fm.state.writes.at(-1)?.tags, ["one", "two"]); // both frontmatter parts reverted (guards, oldest-first)
  assert.deepEqual(first.notes[0].skippedProposals, [{ tagPath: "ONE", reason: "inline-unavailable" }]); // only the perturbed entry reports skips
  assert.deepEqual([first.appliedProposalCount, first.skippedProposalCount, first.mutatedNoteCount], [2, 1, 1]);
  assert.deepEqual(JSON.parse(state.text!), [older]); // the newer entry fully undid and consumed; the perturbed one stays
  const retry = await revertAppliedChanges(storage, fm.port, text.access);
  assert.equal(text.state.writes.length, 1); // no retry write: the guard refuses to restore the retyped anchor twice
  assert.equal(fm.state.writes.length, 1); // and the frontmatter guards make the retry a no-op, not a double revert
  assert.deepEqual([retry.appliedProposalCount, retry.skippedProposalCount, retry.mutatedNoteCount], [0, 1, 0]);
  assert.equal(state.text, JSON.stringify([older])); // still pending after the retry
  assert.equal(texts["ed.md"], "z #oNe y #two x"); // "#two" stands exactly once
});

void test("phantom batch after a committed one: revert-all restores the committed batch exactly and leaves the phantom pending", async () => {
  const committed = entry({
    notePath: "ph2.md",
    timestamp: 1000,
    batch: 1, // first apply invocation's write for the note
    kind: "normalization",
    tagPath: "Physics/MRI",
    addedTags: ["Physics/MRI"],
    removedTags: ["mri"],
    tagsBefore: ["mri", "city"],
    tagsAfter: ["Physics/MRI", "city"],
    inlineEdits: [{ start: 2, end: 14, before: "#mri", after: "#Physics/MRI" }],
  });
  const phantom = entry({
    notePath: "ph2.md",
    timestamp: 2000,
    batch: 2, // the phantom is a SEPARATE apply invocation's write: its own ordinal
    kind: "normalization",
    tagPath: "City",
    addedTags: ["City"],
    removedTags: ["city"],
    tagsBefore: ["Physics/MRI", "city"],
    tagsAfter: ["Physics/MRI", "City"],
    inlineEdits: [{ start: 17, end: 22, before: "#city", after: "#City" }], // journaled write-ahead, never committed anywhere
  });
  const { storage, state } = makeStorage(JSON.stringify([committed, phantom]));
  const fm = makeFrontmatter({ "ph2.md": ["Physics/MRI", "city"] }); // the phantom's mutation never happened
  const text = makeInlineAccess({ "ph2.md": "a #Physics/MRI b #city c" }); // nor did its inline rewrite
  const reverted = await revertAppliedChanges(storage, fm.port, text.access);
  assert.equal(text.state.writes.at(-1)?.text, "a #mri b #city c"); // the committed batch restores exactly
  assert.deepEqual(fm.state.writes.at(-1)?.tags, ["city", "mri"]); // committed batch's form restored (appended-after-survivors, the accepted rule); the phantom acted on nothing
  assert.deepEqual(reverted.notes[0].skippedProposals, [{ tagPath: "City", reason: "inline-unavailable" }]); // the never-committed plan reports, never forces
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [1, 1, 1]);
  assert.deepEqual(JSON.parse(state.text!), [phantom]); // journal NOT emptied: the phantom's records stay pending
});

void test("restart recovery: revert driven purely from persisted journal text through fresh storage and access instances restores the exact original", async () => {
  const f = lengthChangeBatches("r.md");
  const seed = makeStorage();
  await appendLedgerEntries([f.older, f.newer], seed.storage); // the only durable artifact left behind by the crash
  const persisted = seed.state.text!;
  // Restart: every in-memory object is fresh; the revert sees the vault state and the persisted text.
  const { storage, state } = makeStorage(persisted);
  const fm = makeFrontmatter({ "r.md": [...f.appliedTags] });
  const text = makeInlineAccess({ "r.md": f.appliedBody });
  const reverted = await revertAppliedChanges(storage, fm.port, text.access);
  assert.equal(text.state.writes.at(-1)?.text, f.originalBody); // exact original body from the serialized journal alone
  assert.deepEqual(fm.state.writes.at(-1)?.tags, f.originalTags); // exact original frontmatter
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [2, 0, 1]);
  assert.equal(state.text, "[]"); // and the journal fully drains
});

// ---------------------------------------------------------------------------
// Lead's micro-amendment (QA cycle 2, post-collection): ONE merged inline
// revert per batch, attribution read off the post-revert text.
// ---------------------------------------------------------------------------

void test("the TRAP's corpse: one apply call whose journal positions oppose their document positions reverts exactly", async () => {
  // ONE apply call (one timestamp), TWO replacements of DIFFERENT length deltas, and the
  // journal order opposes the document order: entry 1 is the LATER-document replacement
  // ("#beta"→"#B", shrinks), entry 2 the earlier one ("#alpha"→"#AlphaLonger", grows).
  // Records sit in the batch's single final frame — exactly what computeInlineRewriteBatch
  // folds out of "x #alpha y #beta z" for this request order: body "x #AlphaLonger y #B z".
  // Per-entry calls die here: the alpha restore lengthens the text first, so the beta
  // record's final-frame anchor mis-anchors (false guard-skip, retained entry, inexact
  // body with no intervening edit anywhere). The merged per-batch call is exact.
  const { storage, state } = makeStorage();
  await recordAppliedChanges(applyResultFor("trap.md", ["beta", "alpha"], ["B", "AlphaLonger"], [
    { ...receipt("normalization", "B", ["B"], ["beta"]), inlineEdits: [{ start: 17, end: 19, before: "#beta", after: "#B" }] },
    { ...receipt("normalization", "AlphaLonger", ["AlphaLonger"], ["alpha"]), inlineEdits: [{ start: 2, end: 14, before: "#alpha", after: "#AlphaLonger" }] },
  ]), storage, 100);
  const fm = makeFrontmatter({ "trap.md": ["B", "AlphaLonger"] });
  const text = makeInlineAccess({ "trap.md": "x #AlphaLonger y #B z" });
  const reverted = await revertAppliedChanges(storage, fm.port, text.access);
  assert.equal(text.state.writes.at(-1)?.text, "x #alpha y #beta z"); // the EXACT original body, one merged write
  assert.deepEqual(fm.state.writes.at(-1)?.tags, ["beta", "alpha"]); // the EXACT original frontmatter, order intact
  assert.deepEqual(reverted.notes[0].skippedProposals, []); // no false guard-skips: nothing perturbed
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [2, 0, 1]); // truthful counts
  assert.equal(state.text, "[]"); // both entries consumed: every one of their records restored
});

// ---------------------------------------------------------------------------
// QA HOLD cycle 3 amendment: the PERSISTED BATCH ORDINAL replaces timestamp
// grouping — pure allocator, the faithful probe3 scenario, the LEGACY
// per-entry fallback, monotonicity through persistence and restart.
// ---------------------------------------------------------------------------

void test("nextBatchOrdinal allocates max + 1 from the persisted journal text alone", () => {
  assert.equal(nextBatchOrdinal(null), 1); // an absent journal starts the sequence at 1
  assert.equal(nextBatchOrdinal("[]"), 1); // an empty journal too
  const legacy = { notePath: "a.md", timestamp: 1, kind: "taxonomy", tagPath: "T", addedTags: [], removedTags: [], tagsBefore: [], tagsAfter: [] };
  assert.equal(nextBatchOrdinal(JSON.stringify([legacy])), 1); // LEGACY entries carry no ordinal and contribute nothing
  assert.equal(nextBatchOrdinal(JSON.stringify([{ ...legacy, batch: 3 }, legacy, { ...legacy, batch: 7 }])), 8); // the maximum over the mixed numbered entries, wherever it sits
});

void test("nextBatchOrdinal throws on malformed journal text like every other read", () => {
  assert.throws(() => nextBatchOrdinal("{ not json"));
  assert.throws(() => nextBatchOrdinal("5")); // a non-array document is as malformed as bad syntax
});

void test("QA probe3 at the ledger level: two same-millisecond batches revert exactly through the persisted ordinals", async () => {
  // Faithful transcription of probe3-lengthchange.mjs: body "x #city y #mri z",
  // mri→Physics/MRI FIRST, then city→Urban at the EARLIER position with a length
  // change, both calls in the SAME millisecond — the timestamps are identical,
  // so only the persisted batch ordinals keep the two invocations apart. The
  // frontmatter seeds start ["mri","city"] because the revert's restored forms
  // APPEND AFTER the surviving tags: with this seed order the append-after-
  // survivors rule lands back on the exact original; the inverse seed would
  // restore ["mri","city"] from ["city","mri"] (a reordering the guards allow).
  const mri = entry({
    notePath: "p3.md",
    timestamp: 5000, // the same millisecond as the city entry: time never groups
    batch: 1,
    kind: "normalization",
    tagPath: "Physics/MRI",
    addedTags: ["Physics/MRI"],
    removedTags: ["mri"],
    tagsBefore: ["mri", "city"],
    tagsAfter: ["Physics/MRI", "city"],
    inlineEdits: [{ start: 10, end: 22, before: "#mri", after: "#Physics/MRI" }], // anchored in batch 1's final frame "x #city y #Physics/MRI z"
  });
  const city = entry({
    notePath: "p3.md",
    timestamp: 5000,
    batch: 2, // the second invocation's write: ALLOCATED, never derived from the shared timestamp
    kind: "normalization",
    tagPath: "Urban",
    addedTags: ["Urban"],
    removedTags: ["city"],
    tagsBefore: ["Physics/MRI", "city"],
    tagsAfter: ["Physics/MRI", "Urban"],
    inlineEdits: [{ start: 2, end: 8, before: "#city", after: "#Urban" }], // anchored in batch 2's final frame "x #Urban y #Physics/MRI z"
  });
  const { storage, state } = makeStorage(JSON.stringify([mri, city]));
  const fm = makeFrontmatter({ "p3.md": ["Physics/MRI", "Urban"] });
  const text = makeInlineAccess({ "p3.md": "x #Urban y #Physics/MRI z" });
  const reverted = await revertAppliedChanges(storage, fm.port, text.access);
  assert.equal(text.state.writes.at(-1)?.text, "x #city y #mri z"); // the EXACT original body: batch 2 (newer ordinal) reverted first
  assert.deepEqual(fm.state.writes.at(-1)?.tags, ["mri", "city"]); // the EXACT original frontmatter
  assert.deepEqual(reverted.notes[0].skippedProposals, []); // no hidden guard failures, no stranded entry
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [2, 0, 1]); // truthful counts
  assert.equal(state.text, "[]"); // the journal empties: both batches fully undone
});

void test("LEGACY journal entries without a batch member revert per-entry, never false-merged", async () => {
  // Pre-identity journal: NO `batch` member anywhere. Two same-millisecond
  // writes with the probe3 geometry — each record anchored in ITS OWN write's
  // final frame — so a false merge into one call would test the first record's
  // anchor against the second frame ("x #Urban y #Physics/MRI z" slices 10..22
  // as " #Physics/MR", not "#Physics/MRI") and strand it. The documented
  // fallback makes EVERY legacy entry its own single-entry batch, ordered by
  // timestamp DESC with reverse journal position as the tie-break: the newer
  // write reverts first, then the older lands on its own frame, exactly.
  const first = { // apply 1 (mri) wrote first; its record anchors in "x #city y #Physics/MRI z"
    notePath: "lg.md",
    timestamp: 5000,
    kind: "normalization",
    tagPath: "Physics/MRI",
    addedTags: ["Physics/MRI"],
    removedTags: ["mri"],
    tagsBefore: ["mri", "city"],
    tagsAfter: ["Physics/MRI", "city"],
    inlineEdits: [{ start: 10, end: 22, before: "#mri", after: "#Physics/MRI" }],
  };
  const second = { // apply 2 (city→Urban) wrote second; its record anchors in "x #Urban y #Physics/MRI z"
    notePath: "lg.md",
    timestamp: 5000,
    kind: "normalization",
    tagPath: "Urban",
    addedTags: ["Urban"],
    removedTags: ["city"],
    tagsBefore: ["Physics/MRI", "city"],
    tagsAfter: ["Physics/MRI", "Urban"],
    inlineEdits: [{ start: 2, end: 8, before: "#city", after: "#Urban" }],
  };
  const { storage, state } = makeStorage(JSON.stringify([first, second])); // neither entry carries a batch member
  const fm = makeFrontmatter({ "lg.md": ["Physics/MRI", "Urban"] });
  const text = makeInlineAccess({ "lg.md": "x #Urban y #Physics/MRI z" });
  const reverted = await revertAppliedChanges(storage, fm.port, text.access);
  assert.equal(text.state.writes.at(-1)?.text, "x #city y #mri z"); // exact: only per-entry frames make this restoration possible
  assert.deepEqual(fm.state.writes.at(-1)?.tags, ["mri", "city"]); // the EXACT original frontmatter
  assert.deepEqual(reverted.notes[0].skippedProposals, []); // no false guard-skip: nothing merged
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [2, 0, 1]); // truthful counts
  assert.equal(state.text, "[]"); // both entries consumed per-entry: the journal drains
});

void test("batch ordinals are strictly monotonic across appends, persisted, and restore exactly through a fresh storage instance", async () => {
  const f = lengthChangeBatches("mo.md");
  const { storage, state } = makeStorage();
  // Two applies through the allocator (recordAppliedChanges), the same two
  // batches the lengthChangeBatches fixture describes: each write allocates its
  // ordinal from the persisted journal's maximum — never from time.
  await recordAppliedChanges(applyResultFor("mo.md", ["aa", "bbb"], ["AlphaBeta", "bbb"], [
    { ...receipt("normalization", "AlphaBeta", ["AlphaBeta"], ["aa"]), inlineEdits: [{ start: 4, end: 14, before: "#aa", after: "#AlphaBeta" }] },
  ]), storage, 1000);
  await recordAppliedChanges(applyResultFor("mo.md", ["AlphaBeta", "bbb"], ["AlphaBeta", "B"], [
    { ...receipt("normalization", "B", ["B"], ["bbb"]), inlineEdits: [{ start: 19, end: 21, before: "#bbb", after: "#B" }] },
  ]), storage, 2000);
  assert.deepEqual((JSON.parse(state.text!) as LedgerEntry[]).map((e) => e.batch), [1, 2]); // strictly monotonic across appends, persisted in the text
  assert.equal(nextBatchOrdinal(state.text), 3); // the next write allocates strictly above every persisted ordinal
  // Restart: a FRESH storage instance over the same persisted text — the ordinals survive serialization.
  const fresh = makeStorage(state.text);
  const fm = makeFrontmatter({ "mo.md": [...f.appliedTags] });
  const text = makeInlineAccess({ "mo.md": f.appliedBody });
  const reverted = await revertAppliedChanges(fresh.storage, fm.port, text.access);
  assert.equal(text.state.writes.at(-1)?.text, f.originalBody); // the exact original body, restored through the persisted identity alone
  assert.deepEqual(fm.state.writes.at(-1)?.tags, f.originalTags); // the exact original frontmatter
  assert.deepEqual([reverted.appliedProposalCount, reverted.skippedProposalCount, reverted.mutatedNoteCount], [2, 0, 1]); // truthful counts
  assert.equal(fresh.state.text, "[]"); // the journal fully drains
});
