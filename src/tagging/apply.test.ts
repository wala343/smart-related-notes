// Unit tests for the concept-tag pipeline's mutation core: offline, synthetic, in-memory ports.
import { test } from "node:test";
import assert from "node:assert/strict";
// Node's transform-types needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else.
// @ts-expect-error
import { applyTagProposals, type ApplyFrontmatterPort, type ApplyNoteOutput, type ApplySideChannels } from "./apply.ts";
import type { InlineEditRecord, InlineRewriteBatch } from "./inline-rewrite.ts";
import type { TagRewriteProposal } from "./proposal.ts";

// In-memory port: an absent key reads null (no `tags:` key), a stored [] reads the empty
// form, and every write is logged so tests can count calls and inspect the exact array.
function memoryPort(initial: Record<string, string[] | null> = {}) {
  const store = new Map<string, string[] | null>(Object.entries(initial));
  const writeLog: { notePath: string; tags: string[] }[] = [];
  const port: ApplyFrontmatterPort = {
    async readNoteTags(notePath) {
      return store.get(notePath) ?? null;
    },
    async writeNoteTags(notePath, tags) {
      writeLog.push({ notePath, tags: [...tags] });
      store.set(notePath, [...tags]);
    },
  };
  return { port, store, writeLog };
}

function proposal(notePath: string, tagPath: string, extra: Partial<TagRewriteProposal> = {}): TagRewriteProposal {
  return { kind: "taxonomy", notePath, tagPath, confidence: 0.9, evidence: "test fixture", ...extra };
}

void test("an empty proposal list is the empty result", async () => {
  const result = await applyTagProposals([], memoryPort().port);
  assert.deepEqual(result, { notes: [], appliedProposalCount: 0, skippedProposalCount: 0, mutatedNoteCount: 0 });
});

void test("appends to an existing block list, keeping order and exact forms", async () => {
  const { port, store, writeLog } = memoryPort({ "notes/a.md": ["Existing", "other tag"] });
  const result = await applyTagProposals([proposal("notes/a.md", "MachineLearning/NeuralNetworks")], port);
  assert.deepEqual(writeLog, [{ notePath: "notes/a.md", tags: ["Existing", "other tag", "MachineLearning/NeuralNetworks"] }]);
  assert.deepEqual(store.get("notes/a.md"), ["Existing", "other tag", "MachineLearning/NeuralNetworks"]);
  const note = result.notes[0];
  assert.deepEqual(note.tagsBefore, ["Existing", "other tag"]);
  assert.deepEqual(note.tagsAfter, ["Existing", "other tag", "MachineLearning/NeuralNetworks"]);
  assert.deepEqual(note.appliedProposals, [
    { kind: "taxonomy", tagPath: "MachineLearning/NeuralNetworks", replacesTag: null,
      addedTags: ["MachineLearning/NeuralNetworks"], removedTags: [] },
  ]);
  assert.deepEqual(note.skippedProposals, []);
  assert.equal(result.appliedProposalCount, 1);
  assert.equal(result.skippedProposalCount, 0);
  assert.equal(result.mutatedNoteCount, 1);
});

void test("the empty-form note (tags: [] present) appends like any other", async () => {
  const { port, writeLog } = memoryPort({ "notes/empty.md": [] });
  const result = await applyTagProposals([proposal("notes/empty.md", "Topic")], port);
  assert.deepEqual(writeLog[0].tags, ["Topic"]);
  assert.deepEqual(result.notes[0].tagsBefore, []);
  assert.deepEqual(result.notes[0].tagsAfter, ["Topic"]);
});

void test("a note with no tags key reads null; the port receives the new array whole", async () => {
  const { port, writeLog } = memoryPort({}); // key absent entirely
  const result = await applyTagProposals([proposal("notes/new.md", "Topic")], port);
  assert.deepEqual(writeLog[0].tags, ["Topic"]); // create-the-key is the port's job; the core hands it the full list
  assert.deepEqual(result.notes[0].tagsBefore, []); // the null read maps to []
});

void test("case-insensitive dedupe keeps the existing form and writes nothing", async () => {
  const { port, store, writeLog } = memoryPort({ "notes/t.md": ["city"] });
  const result = await applyTagProposals([proposal("notes/t.md", "City")], port);
  assert.equal(writeLog.length, 0);                    // all-skipped notes are never written
  assert.deepEqual(store.get("notes/t.md"), ["city"]); // the core never rewrites an existing form
  const note = result.notes[0];
  assert.deepEqual(note.tagsBefore, ["city"]);
  assert.deepEqual(note.tagsAfter, []); // [] when nothing was written
  assert.deepEqual(note.skippedProposals, [{ tagPath: "City", reason: "already-present" }]);
  assert.equal(result.mutatedNoteCount, 0);
});

void test("replacesTag displaces every exact occurrence and appends the new form", async () => {
  const { port, writeLog } = memoryPort({ "notes/r.md": ["ML", "Old", "keep", "Old"] });
  const result = await applyTagProposals(
    [proposal("notes/r.md", "MachineLearning", { kind: "normalization", replacesTag: "Old" })],
    port,
  );
  assert.deepEqual(writeLog[0].tags, ["ML", "keep", "MachineLearning"]); // order kept, new form appended
  assert.deepEqual(result.notes[0].appliedProposals, [
    { kind: "normalization", tagPath: "MachineLearning", replacesTag: "Old",
      addedTags: ["MachineLearning"], removedTags: ["Old", "Old"] }, // one receipt entry per displaced occurrence
  ]);
});

void test("a replacesTag with no exact match skips replacement-not-found, unwritten", async () => {
  const { port, writeLog } = memoryPort({ "notes/r.md": ["old", "ML"] }); // "old" is not the exact "Old"
  const result = await applyTagProposals(
    [proposal("notes/r.md", "MachineLearning", { kind: "placement", replacesTag: "Old" })],
    port,
  );
  assert.equal(writeLog.length, 0); // no partial write for the proposal
  assert.deepEqual(result.notes[0].skippedProposals, [{ tagPath: "MachineLearning", reason: "replacement-not-found" }]);
});

void test("a replacement whose path matches a remaining tag removes but suppresses the append", async () => {
  const { port, writeLog } = memoryPort({ "notes/s.md": ["Topic", "old"] });
  const result = await applyTagProposals(
    [proposal("notes/s.md", "Topic", { kind: "normalization", replacesTag: "old" })],
    port,
  );
  assert.deepEqual(writeLog[0].tags, ["Topic"]); // the removal lands, the remaining form wins
  assert.deepEqual(result.notes[0].appliedProposals, [
    { kind: "normalization", tagPath: "Topic", replacesTag: "old", addedTags: [], removedTags: ["old"] },
  ]);
});

void test("an empty-after-trim tag path skips malformed-proposal; an empty replacesTag is absent", async () => {
  const { port, writeLog } = memoryPort({ "notes/m.md": ["Keep"] });
  const result = await applyTagProposals(
    [
      proposal("notes/m.md", "   "),
      proposal("notes/m.md", "  Padded  "),                            // the trim lands in the write
      proposal("notes/m.md", "BlankReplace", { replacesTag: "  " }),   // empty replacesTag treated as absent
    ],
    port,
  );
  assert.deepEqual(result.notes[0].skippedProposals, [{ tagPath: "", reason: "malformed-proposal" }]);
  assert.deepEqual(writeLog[0].tags, ["Keep", "Padded", "BlankReplace"]);
  assert.equal(result.appliedProposalCount, 2);
});

void test("the same note and tag path proposed twice skips duplicate-proposal whatever the kind", async () => {
  const { port, writeLog } = memoryPort({ "notes/d.md": [] });
  const result = await applyTagProposals(
    [
      proposal("notes/d.md", "Topic"),
      proposal("notes/d.md", "topic", { kind: "propagation", replacesTag: "Topic" }), // case-insensitive clash
      proposal("notes/d.md", "Other"),
    ],
    port,
  );
  assert.deepEqual(result.notes[0].skippedProposals, [{ tagPath: "topic", reason: "duplicate-proposal" }]);
  assert.equal(result.appliedProposalCount, 2);
  assert.equal(writeLog.length, 1);                    // one write per note, holding both applies
  assert.deepEqual(writeLog[0].tags, ["Topic", "Other"]);
});

void test("a note facing no applicable proposal is never written, even beside one that is", async () => {
  const { port, store, writeLog } = memoryPort({ "notes/skip.md": ["city"], "notes/write.md": null });
  const result = await applyTagProposals(
    [proposal("notes/skip.md", "City"), proposal("notes/write.md", "Fresh")],
    port,
  );
  assert.equal(writeLog.length, 1);
  assert.equal(writeLog[0].notePath, "notes/write.md");
  assert.deepEqual(store.get("notes/skip.md"), ["city"]);
  assert.deepEqual(result.notes[0].tagsAfter, []); // the all-skipped note reports no write
});

void test("a read throw skips the whole note note-unavailable and never rethrows", async () => {
  const port: ApplyFrontmatterPort = {
    async readNoteTags() {
      throw new Error("vault offline");
    },
    async writeNoteTags() {
      throw new Error("must never be reached");
    },
  };
  const result = await applyTagProposals([proposal("notes/x.md", "A"), proposal("notes/x.md", "  ")], port);
  assert.deepEqual(result.notes[0], {
    notePath: "notes/x.md",
    tagsBefore: [],
    tagsAfter: [],
    appliedProposals: [],
    skippedProposals: [
      { tagPath: "A", reason: "note-unavailable" },
      { tagPath: "", reason: "note-unavailable" }, // receipts carry the trimmed path even here
    ],
  });
  assert.equal(result.appliedProposalCount, 0);
  assert.equal(result.skippedProposalCount, 2);
  assert.equal(result.mutatedNoteCount, 0);
});

void test("a write throw re-records the note's applied proposals as note-unavailable and counts no mutation", async () => {
  const store = new Map<string, string[] | null>([["notes/w.md", ["Keep"]]]);
  const port: ApplyFrontmatterPort = {
    async readNoteTags(notePath) {
      return store.get(notePath) ?? null;
    },
    async writeNoteTags() {
      throw new Error("disk full");
    },
  };
  const result = await applyTagProposals(
    [proposal("notes/w.md", "Added"), proposal("notes/w.md", "keep")], // "keep" dedupes before the write
    port,
  );
  assert.deepEqual(result.notes[0].appliedProposals, []);
  assert.deepEqual(result.notes[0].skippedProposals, [
    { tagPath: "keep", reason: "already-present" },
    { tagPath: "Added", reason: "note-unavailable" },
  ]);
  assert.deepEqual(result.notes[0].tagsBefore, ["Keep"]);
  assert.deepEqual(result.notes[0].tagsAfter, []);
  assert.equal(result.appliedProposalCount, 0);
  assert.equal(result.skippedProposalCount, 2);
  assert.equal(result.mutatedNoteCount, 0);
});

void test("notes come out in first-proposal order and the counts sum the receipts", async () => {
  const { port, writeLog } = memoryPort({ "notes/a.md": ["city"], "notes/b.md": null, "notes/c.md": ["Solo"] });
  const result = await applyTagProposals(
    [
      proposal("notes/b.md", "Beta"),
      proposal("notes/a.md", "City"),   // already-present → a is never written
      proposal("notes/b.md", "Gamma"),
      proposal("notes/c.md", "Solo"),   // matches its own existing tag → c is never written
    ],
    port,
  );
  assert.deepEqual(result.notes.map((n) => n.notePath), ["notes/b.md", "notes/a.md", "notes/c.md"]);
  assert.equal(writeLog.length, 1);
  assert.deepEqual(writeLog[0].tags, ["Beta", "Gamma"]); // b had no tags key: the null read merged as []
  assert.equal(result.appliedProposalCount, 2);
  assert.equal(result.skippedProposalCount, 2);
  assert.equal(result.mutatedNoteCount, 1);
});

// ---------------------------------------------------------------------------
// Amendment: side channels (write-ahead journal + ONE note-level body batch).
// The fakes below share one event log so a test can assert the total per-note
// order: plan → journal → commit (whole body) → write (frontmatter).
// ---------------------------------------------------------------------------

// An inline edit record in the exact shape inline-rewrite.ts ships.
function rec(start: number, end: number, before: string, after: string): InlineEditRecord {
  return { start, end, before, after };
}

// The deterministic default batch: one group per request, positional per the
// batch contract (editGroups[i] answers requests[i], in approval order).
function batchFor(requests: { replacesTag: string; tagPath: string }[]): InlineRewriteBatch {
  return {
    source: "body",
    content: requests.map((r) => `#${r.tagPath}`).join(" "),
    editGroups: requests.map((r, i) => [rec(i * 10, i * 10 + r.tagPath.length + 1, `#${r.replacesTag}`, `#${r.tagPath}`)]),
  };
}

function sideFakes(
  initial: Record<string, string[] | null> = {},
  options: {
    plan?: (requests: { replacesTag: string; tagPath: string }[]) => InlineRewriteBatch | null;
    journalThrows?: boolean;
    commitThrows?: boolean;
    commitResult?: "committed" | "drifted";
    journalOnly?: boolean; // the idle additive shape: journalNoteWrite with NO inline members
  } = {},
) {
  const events: string[] = [];
  const journaled: ApplyNoteOutput[] = [];
  const bodyWrites: { notePath: string; content: string }[] = []; // the side channel's whole-body writes
  const writeLog: { notePath: string; tags: string[] }[] = [];
  let planned: InlineRewriteBatch | null = null; // the keyed-retrieval stand-in: commit writes what the plan held
  const store = new Map<string, string[] | null>(Object.entries(initial));
  const port: ApplyFrontmatterPort = {
    async readNoteTags(notePath) {
      return store.get(notePath) ?? null;
    },
    async writeNoteTags(notePath, tags) {
      events.push("write");
      writeLog.push({ notePath, tags: [...tags] });
      store.set(notePath, [...tags]);
    },
  };
  const channels: ApplySideChannels = {
    async planNoteRewrites(notePath, requests) {
      events.push("plan");
      planned = options.plan ? options.plan(requests) : batchFor(requests);
      return planned;
    },
    async journalNoteWrite(note) {
      events.push("journal");
      if (options.journalThrows) throw new Error("journal offline");
      journaled.push(note);
    },
    async commitNoteRewrite(notePath) {
      events.push("commit");
      if (options.commitThrows) throw new Error("inline file busy");
      const outcome = options.commitResult ?? "committed";
      if (outcome === "committed" && planned !== null) bodyWrites.push({ notePath, content: planned.content });
      return outcome;
    },
  };
  // The idle additive shape: strip both inline members, keep the journal alone.
  if (options.journalOnly) {
    delete channels.planNoteRewrites;
    delete channels.commitNoteRewrite;
  }
  return { port, store, channels, events, journaled, bodyWrites, writeLog };
}

void test("write-ahead order under the new shape: the journal log precedes the body commit AND the tags write", async () => {
  const f = sideFakes({ "notes/j.md": ["Old", "Keep"] });
  const result = await applyTagProposals(
    [proposal("notes/j.md", "New", { kind: "normalization", replacesTag: "Old" })],
    f.port,
    f.channels,
  );
  assert.deepEqual(f.events, ["plan", "journal", "commit", "write"]); // nothing mutates before the journal returns
  assert.deepEqual(f.bodyWrites, [{ notePath: "notes/j.md", content: "#New" }]); // the body commits BEFORE the tags write
  assert.deepEqual(f.store.get("notes/j.md"), ["Keep", "New"]);
  assert.deepEqual(f.journaled[0], {
    notePath: "notes/j.md",
    tagsBefore: ["Old", "Keep"],
    tagsAfter: ["Keep", "New"],
    appliedProposals: [
      { kind: "normalization", tagPath: "New", replacesTag: "Old", addedTags: ["New"], removedTags: ["Old"],
        inlineEdits: [rec(0, 4, "#Old", "#New")] },
    ],
    skippedProposals: [],
  });
  assert.deepEqual(result.notes[0].appliedProposals[0].inlineEdits, [rec(0, 4, "#Old", "#New")]);
  assert.equal(result.mutatedNoteCount, 1);
});

void test("two same-note replacements merge through ONE batch: one commit, one write of the final merged list", async () => {
  const f = sideFakes({ "notes/2.md": ["Old", "Old2"] });
  const result = await applyTagProposals(
    [
      proposal("notes/2.md", "New", { kind: "normalization", replacesTag: "Old" }),
      proposal("notes/2.md", "New2", { kind: "normalization", replacesTag: "Old2" }),
      proposal("notes/2.md", "PlainAdd"), // additive: applies at once, never bucketed, never in the batch
    ],
    f.port,
    f.channels,
  );
  assert.deepEqual(f.events, ["plan", "journal", "commit", "write"]); // ONE plan for both replacements, then the total order
  assert.equal(f.journaled.length, 1); // journaled once, after ALL merging
  assert.equal(f.bodyWrites.length, 1); // ONE whole-body commit for the note, and "committed" proceeds to the tags write
  assert.deepEqual(f.writeLog, [{ notePath: "notes/2.md", tags: ["PlainAdd", "New", "New2"] }]); // the port receives the final merged list once
  assert.deepEqual(result.notes[0].appliedProposals, [
    { kind: "taxonomy", tagPath: "PlainAdd", replacesTag: null, addedTags: ["PlainAdd"], removedTags: [] },
    { kind: "normalization", tagPath: "New", replacesTag: "Old", addedTags: ["New"], removedTags: ["Old"],
      inlineEdits: [rec(0, 4, "#Old", "#New")] }, // each receipt carries its OWN final-frame group
    { kind: "normalization", tagPath: "New2", replacesTag: "Old2", addedTags: ["New2"], removedTags: ["Old2"],
      inlineEdits: [rec(10, 15, "#Old2", "#New2")] },
  ]);
  assert.equal(result.appliedProposalCount, 3);
});

void test("a journal throw leaves zero mutations and records journal-unavailable for every applied proposal", async () => {
  const f = sideFakes({ "notes/jt.md": ["Old"] }, { journalThrows: true });
  const result = await applyTagProposals(
    [
      proposal("notes/jt.md", "New", { kind: "normalization", replacesTag: "Old" }),
      proposal("notes/jt.md", "Adder"),
    ],
    f.port,
    f.channels,
  );
  assert.deepEqual(f.events, ["plan", "journal"]); // no commit, no write: the note is vetoed whole
  assert.deepEqual(f.store.get("notes/jt.md"), ["Old"]);
  const note = result.notes[0];
  assert.deepEqual(note.appliedProposals, []);
  assert.deepEqual(note.skippedProposals, [
    { tagPath: "Adder", reason: "journal-unavailable" },
    { tagPath: "New", reason: "journal-unavailable" },
  ]);
  assert.deepEqual(note.tagsAfter, []);
  assert.equal(result.appliedProposalCount, 0);
  assert.equal(result.skippedProposalCount, 2);
  assert.equal(result.mutatedNoteCount, 0);
});

void test("a null note-level plan vetoes ALL the note's bucketed replacements as content-drift; additives stand", async () => {
  const f = sideFakes({ "notes/d.md": ["Old", "Old2", "Keep"] }, { plan: () => null });
  const result = await applyTagProposals(
    [
      proposal("notes/d.md", "New", { kind: "normalization", replacesTag: "Old" }),
      proposal("notes/d.md", "Adder"),
      proposal("notes/d.md", "New2", { kind: "normalization", replacesTag: "Old2" }),
    ],
    f.port,
    f.channels,
  );
  assert.deepEqual(f.events, ["plan", "journal", "write"]); // the additive carries the note through: journaled, written — no batch, so no commit
  assert.deepEqual(f.store.get("notes/d.md"), ["Old", "Old2", "Keep", "Adder"]); // frontmatter matches EXISTED and were NOT displaced
  const note = result.notes[0];
  assert.deepEqual(note.appliedProposals, [
    { kind: "taxonomy", tagPath: "Adder", replacesTag: null, addedTags: ["Adder"], removedTags: [] },
  ]);
  assert.deepEqual(note.skippedProposals, [
    { tagPath: "New", reason: "content-drift" },
    { tagPath: "New2", reason: "content-drift" },
  ]);
  assert.equal(result.mutatedNoteCount, 1);

  // With no additive to carry the note, the vetoed replacements leave it entirely unwritten.
  const g = sideFakes({ "notes/d2.md": ["Old"] }, { plan: () => null });
  const alone = await applyTagProposals(
    [proposal("notes/d2.md", "New", { kind: "normalization", replacesTag: "Old" })],
    g.port,
    g.channels,
  );
  assert.deepEqual(g.events, ["plan"]); // no journal, no commit, no write
  assert.deepEqual(g.store.get("notes/d2.md"), ["Old"]);
  assert.deepEqual(alone.notes[0].skippedProposals, [{ tagPath: "New", reason: "content-drift" }]);
});

void test("a planNoteRewrites throw cannot revalidate the spans: same veto as a null plan", async () => {
  const f = sideFakes({ "notes/pt.md": ["Old"] });
  f.channels.planNoteRewrites = async () => {
    f.events.push("plan");
    throw new Error("live snapshot gone");
  };
  const result = await applyTagProposals(
    [proposal("notes/pt.md", "New", { kind: "normalization", replacesTag: "Old" })],
    f.port,
    f.channels,
  );
  assert.deepEqual(f.events, ["plan"]);
  assert.deepEqual(result.notes[0].skippedProposals, [{ tagPath: "New", reason: "content-drift" }]);
  assert.equal(result.mutatedNoteCount, 0);
});

void test("a replacement found only inline proceeds: empty frontmatter receipts, its group rides the batch", async () => {
  const f = sideFakes({ "notes/io.md": ["Keep"] });
  const result = await applyTagProposals(
    [proposal("notes/io.md", "New", { kind: "normalization", replacesTag: "Old" })],
    f.port,
    f.channels,
  );
  assert.deepEqual(result.notes[0].appliedProposals, [
    { kind: "normalization", tagPath: "New", replacesTag: "Old", addedTags: [], removedTags: [],
      inlineEdits: [rec(0, 4, "#Old", "#New")] }, // the working list displaced nothing; the receipt still records the replacement
  ]);
  assert.deepEqual(f.store.get("notes/io.md"), ["Keep"]);
  assert.deepEqual(f.events, ["plan", "journal", "commit", "write"]); // journaled, body committed, then written (same array)
  assert.deepEqual(f.bodyWrites, [{ notePath: "notes/io.md", content: "#New" }]);
  assert.equal(result.mutatedNoteCount, 1);
});

void test("with side channels, a replacesTag found on NEITHER channel still skips replacement-not-found", async () => {
  const f = sideFakes({ "notes/nf.md": ["Keep"] }, { plan: () => ({ source: "body", content: "body", editGroups: [[]] }) }); // [] = no inline occurrences
  const result = await applyTagProposals(
    [proposal("notes/nf.md", "New", { kind: "normalization", replacesTag: "Old" })],
    f.port,
    f.channels,
  );
  assert.deepEqual(f.events, ["plan"]); // neither channel matched: no journal, no commit, no write
  assert.deepEqual(result.notes[0].skippedProposals, [{ tagPath: "New", reason: "replacement-not-found" }]);
});

void test("a drifted commit skips the bucketed replacements content-drift with no body write, while the tags write proceeds", async () => {
  const f = sideFakes({ "notes/dr.md": ["Old"] }, { commitResult: "drifted" });
  const result = await applyTagProposals(
    [proposal("notes/dr.md", "New", { kind: "normalization", replacesTag: "Old" })],
    f.port,
    f.channels,
  );
  assert.deepEqual(f.events, ["plan", "journal", "commit", "write"]);
  assert.deepEqual(f.bodyWrites, []); // "drifted" wrote no body
  assert.deepEqual(f.store.get("notes/dr.md"), ["New"]); // the tags write still proceeds
  const note = result.notes[0];
  assert.deepEqual(note.skippedProposals, [{ tagPath: "New", reason: "content-drift" }]);
  assert.deepEqual(note.appliedProposals, [
    { kind: "normalization", tagPath: "New", replacesTag: "Old", addedTags: ["New"], removedTags: ["Old"],
      inlineEdits: [rec(0, 4, "#Old", "#New")] }, // the frontmatter receipt stands
  ]);
  // The journal recorded the planned rewrite BEFORE the commit refused it: those
  // records stand as pending truth for a later reversion or acceptance.
  assert.deepEqual(f.journaled[0].appliedProposals[0].inlineEdits, [rec(0, 4, "#Old", "#New")]);
  assert.equal(result.mutatedNoteCount, 1);
});

void test("a body-commit throw records inline-unavailable while the tags write and receipts stand", async () => {
  const f = sideFakes({ "notes/ic.md": ["Old"] }, { commitThrows: true });
  const result = await applyTagProposals(
    [proposal("notes/ic.md", "New", { kind: "normalization", replacesTag: "Old" })],
    f.port,
    f.channels,
  );
  assert.deepEqual(f.store.get("notes/ic.md"), ["New"]); // the frontmatter write stands
  assert.deepEqual(result.notes[0].appliedProposals, [
    { kind: "normalization", tagPath: "New", replacesTag: "Old", addedTags: ["New"], removedTags: ["Old"],
      inlineEdits: [rec(0, 4, "#Old", "#New")] }, // the applied receipt survives for the revert
  ]);
  assert.deepEqual(result.notes[0].skippedProposals, [{ tagPath: "New", reason: "inline-unavailable" }]);
  assert.equal(result.mutatedNoteCount, 1);
});

void test("without side channels the replacement behavior is byte-for-byte the accepted semantics (regression)", async () => {
  const { port, writeLog } = memoryPort({ "notes/e.md": ["city"] });
  const result = await applyTagProposals(
    [
      proposal("notes/e.md", "Fresh"),
      proposal("notes/e.md", "Gone", { kind: "normalization", replacesTag: "Absent" }),
      proposal("notes/e.md", "Fixed", { kind: "normalization", replacesTag: "city" }), // a full frontmatter-only replacement
    ],
    port, // no third argument at all
  );
  assert.deepEqual(result.notes[0], {
    notePath: "notes/e.md",
    tagsBefore: ["city"],
    tagsAfter: ["Fresh", "Fixed"],
    appliedProposals: [
      { kind: "taxonomy", tagPath: "Fresh", replacesTag: null, addedTags: ["Fresh"], removedTags: [] },
      { kind: "normalization", tagPath: "Fixed", replacesTag: "city", addedTags: ["Fixed"], removedTags: ["city"] },
    ],
    skippedProposals: [{ tagPath: "Gone", reason: "replacement-not-found" }],
  }); // deepStrictEqual: no inlineEdits key exists without side channels
  assert.deepEqual(writeLog, [{ notePath: "notes/e.md", tags: ["Fresh", "Fixed"] }]); // one write, the accepted displacement
});

void test("side channels with ONLY journalNoteWrite: the write-ahead holds with no inline channel anywhere", async () => {
  // The idle additive port's shape (journal-only): F3's order and zero-write veto
  // must hold without any inline member, and a replacement stays frontmatter-only.
  const f = sideFakes({ "notes/jo.md": ["Keep"] }, { journalOnly: true });
  const additive = await applyTagProposals([proposal("notes/jo.md", "Adder")], f.port, f.channels);
  assert.deepEqual(f.events, ["journal", "write"]); // journal before the write; no plan/commit event exists
  assert.deepEqual(f.journaled[0], {
    notePath: "notes/jo.md",
    tagsBefore: ["Keep"],
    tagsAfter: ["Keep", "Adder"],
    appliedProposals: [{ kind: "taxonomy", tagPath: "Adder", replacesTag: null, addedTags: ["Adder"], removedTags: [] }],
    skippedProposals: [],
  }); // the receipt handed to the journal keeps the accepted no-inline shapes
  assert.equal(additive.mutatedNoteCount, 1);

  const g = sideFakes({ "notes/jt2.md": ["Keep"] }, { journalOnly: true, journalThrows: true });
  const failed = await applyTagProposals([proposal("notes/jt2.md", "Adder")], g.port, g.channels);
  assert.deepEqual(g.events, ["journal"]); // a bare journal call: no write follows, the note is vetoed whole
  assert.deepEqual(g.store.get("notes/jt2.md"), ["Keep"]); // zero writes
  assert.deepEqual(failed.notes[0].skippedProposals, [{ tagPath: "Adder", reason: "journal-unavailable" }]);

  const h = sideFakes({ "notes/jf.md": ["Old", "Keep"] }, { journalOnly: true });
  const replaced = await applyTagProposals(
    [proposal("notes/jf.md", "New", { kind: "normalization", replacesTag: "Old" })],
    h.port,
    h.channels,
  );
  assert.deepEqual(h.events, ["journal", "write"]); // frontmatter-only replacement: journaled, no inline events
  assert.deepEqual(h.store.get("notes/jf.md"), ["Keep", "New"]);
  assert.deepEqual(replaced.notes[0].appliedProposals, [
    { kind: "normalization", tagPath: "New", replacesTag: "Old", addedTags: ["New"], removedTags: ["Old"] },
  ]); // deepStrictEqual: no inlineEdits key — with no planner the receipt is the accepted form

  const nf = sideFakes({ "notes/jn.md": ["Keep"] }, { journalOnly: true });
  const missing = await applyTagProposals(
    [proposal("notes/jn.md", "New", { kind: "normalization", replacesTag: "Absent" })],
    nf.port,
    nf.channels,
  );
  assert.deepEqual(nf.events, []); // no planner consulted, nothing matched: the accepted skip
  assert.deepEqual(missing.notes[0].skippedProposals, [{ tagPath: "New", reason: "replacement-not-found" }]);
});
