// Unit tests for the tagging command layer: offline, synthetic, scripted in-memory ports.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TagRewriteProposal } from "./proposal";
import type { ApplyFrontmatterPort } from "./apply";
import type { LedgerEntry, LedgerStoragePort } from "./ledger";
import type { InlineRewriteAccess, InlineTagSpan } from "./inline-rewrite";
import type { TaggingCommandPort } from "./commands";
// Node's type stripping needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else.
// @ts-expect-error
import { applySelectedProposals, filterAdditiveProposals, previewTaxonomy, revertTagChanges } from "./commands.ts";

const NOW = 1_730_000_000_000; // fixed clock: every timestamp is injected through the port
const DAY = 86_400_000;

function proposal(notePath: string, tagPath: string, over: Partial<TagRewriteProposal> = {}): TagRewriteProposal {
  return { kind: "taxonomy", notePath, tagPath, confidence: 0.9, evidence: "test fixture", ...over };
}

// Scripted frontmatter: seeded arrays, notes whose read throws (locked), and an
// optional shared call log ("fm-write:<path>") for the write-ahead order proof.
function makeFrontmatter(seed: Record<string, string[] | null>, locked: string[] = [], log?: string[]) {
  const tags = new Map<string, string[] | null>(Object.entries(seed));
  const written: string[] = [];
  const port: ApplyFrontmatterPort = {
    readNoteTags: async (notePath: string) => {
      if (locked.includes(notePath)) throw new Error(`locked: ${notePath}`);
      const seeded = tags.get(notePath); // a seeded null means the note has no tags key
      return seeded === undefined || seeded === null ? null : [...seeded];
    },
    writeNoteTags: async (notePath: string, next: string[]) => {
      log?.push(`fm-write:${notePath}`);
      written.push(notePath);
      tags.set(notePath, [...next]);
    },
  };
  return { port, tags, written };
}

// Scripted ledger storage: one text slot; writes can be made to fail (disk
// full, or per-text for the partial-failure case); reads and writes are
// counted/logged for the write-ahead proof.
function makeLedger(initialText: string | null = null, failWrites: boolean | ((text: string) => boolean) = false, log?: string[]) {
  let text = initialText;
  const writes: string[] = [];
  let reads = 0;
  const port: LedgerStoragePort = {
    readLedgerText: async () => {
      reads += 1;
      return text;
    },
    writeLedgerText: async (next: string) => {
      if (typeof failWrites === "function" ? failWrites(next) : failWrites) {
        log?.push("journal-write-fail");
        throw new Error("ledger disk full");
      }
      writes.push(next);
      log?.push("journal-write");
      text = next;
    },
  };
  return { port, writes, get reads(): number { return reads; }, get text(): string | null { return text; } };
}

// The span for the first occurrence of `text` in `content`, at real offsets.
function spanIn(content: string, text: string): InlineTagSpan {
  const start = content.indexOf(text);
  return { start, end: start + text.length, text };
}

// Live-cache-shaped spans: the `#tag` occurrences of the CURRENT text, scanned
// fresh on every call — the QA probe's fake, so multi-call tests see real frames.
function liveSpans(text: string): InlineTagSpan[] {
  const out: InlineTagSpan[] = [];
  for (const match of text.matchAll(/#[\w/]+/gu)) {
    const start = match.index; // always defined on matchAll results
    if (start === undefined) continue;
    out.push({ start, end: start + match[0].length, text: match[0] });
  }
  return out;
}

// Scripted inline access: seeded note texts, scripted cache spans ("live" =
// scanned from the current text per read), and the same shared call log
// ("inline-write:<path>"); writes are counted.
function makeInline(contents: Record<string, string>, spans: Record<string, InlineTagSpan[]> | "live" = {}, log?: string[]) {
  const files = new Map<string, string>(Object.entries(contents));
  const writes: { notePath: string; text: string }[] = [];
  const access: InlineRewriteAccess = {
    readNoteContent: async (notePath: string) => files.get(notePath) ?? null,
    writeNoteContent: async (notePath: string, text: string) => {
      writes.push({ notePath, text });
      log?.push(`inline-write:${notePath}`);
      files.set(notePath, text);
    },
    inlineTagSpans: async (notePath: string) =>
      spans === "live" ? liveSpans(files.get(notePath) ?? "") : spans[notePath] ?? [],
  };
  return { access, writes, text: (notePath: string): string | null => files.get(notePath) ?? null };
}

function commandPort(fm: ApplyFrontmatterPort, ledger: LedgerStoragePort, over: Partial<TaggingCommandPort> = {}): TaggingCommandPort {
  return {
    frontmatter: fm,
    ledgerStorage: ledger,
    now: () => NOW,
    ledgerRetentionDays: () => 0,
    taxonomyPreviewLines: async () => [],
    ...over,
  };
}

function entry(over: Partial<LedgerEntry> & { notePath: string; tagPath: string }): LedgerEntry {
  return {
    timestamp: NOW,
    batch: 1, // persisted batch identity; fixtures needing several batches override
    kind: "taxonomy",
    addedTags: [],
    removedTags: [],
    tagsBefore: [],
    tagsAfter: [],
    ...over,
  };
}

function journaled(text: string | null): LedgerEntry[] {
  return JSON.parse(text as string) as LedgerEntry[];
}

void test("applySelectedProposals applies EXACTLY the passed list: an unpassed vault proposal never touches the frontmatter port", async () => {
  // notes/b.md carries a real candidate proposal; it is NOT passed, so it must not run (B1).
  const fm = makeFrontmatter({ "notes/a.md": ["Old"], "notes/b.md": ["Existing"] });
  const ledger = makeLedger();
  const port = commandPort(fm.port, ledger.port);
  const notice = await applySelectedProposals(port, [proposal("notes/a.md", "Concept/New", { replacesTag: "Old" })]);
  assert.equal(notice, "Concept tags: applied 1 proposals to 1 notes, skipped 0.");
  assert.deepEqual(fm.tags.get("notes/a.md"), ["Concept/New"]);
  assert.deepEqual(fm.tags.get("notes/b.md"), ["Existing"]); // the unpassed note is untouched
  assert.deepEqual(fm.written, ["notes/a.md"]); // the port saw exactly the passed note
  assert.deepEqual(journaled(ledger.text).map((e) => e.notePath), ["notes/a.md"]);
});

void test("an empty selection returns the no-proposals notice and touches no port at all", async () => {
  const fm = makeFrontmatter({ "notes/a.md": ["Existing"] });
  const ledger = makeLedger();
  const port = commandPort(fm.port, ledger.port);
  assert.equal(await applySelectedProposals(port, []), "Concept tags: no proposals selected.");
  assert.deepEqual(fm.written, []);
  assert.deepEqual(ledger.writes, []);
  assert.equal(ledger.reads, 0); // not even the journal is read for an empty selection
});

void test("apply then revert round trips through the journal with the exact notices", async () => {
  const fm = makeFrontmatter({ "notes/a.md": ["Existing"] });
  const ledger = makeLedger();
  const port = commandPort(fm.port, ledger.port);
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "Concept/Foo")]),
    "Concept tags: applied 1 proposals to 1 notes, skipped 0.",
  );
  const journaled0 = journaled(ledger.text);
  assert.equal(journaled0.length, 1);
  assert.equal(journaled0[0].timestamp, NOW); // the journal timestamp is the injected clock
  assert.equal(await revertTagChanges(port), "Concept tags: reverted 1 changes across 1 notes.");
  assert.deepEqual(fm.tags.get("notes/a.md"), ["Existing"]); // the exact before-array is back
  assert.deepEqual(journaled(ledger.text), []); // reverted entries leave the journal
});

void test("revert then prune appends the pruned sentence to the reverted notice", async () => {
  // The old entry must survive the revert to be pruned: its note's read throws,
  // so the ledger keeps it (0010) and the retention window then drops it.
  const journal = JSON.stringify([
    entry({ notePath: "notes/a.md", tagPath: "Concept/Foo", addedTags: ["Concept/Foo"], tagsAfter: ["Concept/Foo"] }),
    entry({
      notePath: "notes/old.md",
      timestamp: NOW - 100 * DAY,
      tagPath: "Concept/Old",
      addedTags: ["Concept/Old"],
      tagsAfter: ["Concept/Old"],
    }),
  ]);
  const fm = makeFrontmatter({ "notes/a.md": ["Concept/Foo"], "notes/old.md": ["Concept/Old"] }, ["notes/old.md"]);
  const ledger = makeLedger(journal);
  const port = commandPort(fm.port, ledger.port, { ledgerRetentionDays: () => 30 });
  assert.equal(
    await revertTagChanges(port),
    "Concept tags: reverted 1 changes across 1 notes. Pruned 1 old ledger entries.",
  );
  assert.deepEqual(fm.tags.get("notes/a.md"), []);
  assert.deepEqual(journaled(ledger.text), []);
});

void test("previewTaxonomy prefixes the fixed lines and reports an empty yield", async () => {
  const lines = ["Concept", "  Concept/Sub", "notes/a.md -> Concept/Sub"];
  const port = commandPort(makeFrontmatter({}).port, makeLedger().port, { taxonomyPreviewLines: async () => lines });
  assert.equal(await previewTaxonomy(port), `Preview the concept taxonomy\n\n${lines.join("\n")}`);
  assert.equal(await previewTaxonomy({ ...port, taxonomyPreviewLines: async () => [] }), "Concept taxonomy: nothing to preview.");
});

void test("a journal-failing note applies NOTHING while its journaled sibling applies; counts surface in the notice", async () => {
  // The blanket "applied, but writing the undo ledger failed" notice is RETIRED
  // on the apply path: the failure is a per-note write-ahead failure, never an
  // applied-then-failed window.
  const fm = makeFrontmatter({ "notes/a.md": ["Keep"], "notes/b.md": [] });
  const ledger = makeLedger(null, (text) => text.includes("notes/b.md")); // only b's append fails
  const port = commandPort(fm.port, ledger.port); // no inline channel — the idle additive shape
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "Concept/A"), proposal("notes/b.md", "Concept/B")]),
    "Concept tags: applied 1 proposals to 1 notes, skipped 1.",
  ); // the journal-unavailable skip lands in the count
  assert.deepEqual(fm.written, ["notes/a.md"]); // the journaled fine note applies
  assert.deepEqual(fm.tags.get("notes/b.md"), []); // the failing note was never mutated (F3)
  assert.deepEqual(journaled(ledger.text).map((e) => e.notePath), ["notes/a.md"]); // the failed entry never landed
});

void test("an unreadable ledger gives the revert read-failure notice, never a throw", async () => {
  const port = commandPort(makeFrontmatter({}).port, makeLedger("{ this is not json").port);
  assert.equal(await revertTagChanges(port), "Concept tags: the undo ledger could not be read.");
});

void test("reverting an absent ledger reports nothing to revert without a prune sentence", async () => {
  const port = commandPort(makeFrontmatter({}).port, makeLedger(null).port, { ledgerRetentionDays: () => 30 }); // keep-all aside, an empty journal leaves nothing to prune
  assert.equal(await revertTagChanges(port), "Concept tags: nothing to revert.");
});

void test("filterAdditiveProposals: keeps undefined and trim-empty replacesTag, drops real rewrites, leaves the input untouched", () => {
  const absent = { ...proposal("a.md", "City") }; // replacesTag never set
  const trimEmpty = { ...proposal("b.md", "Physics/MRI"), replacesTag: "  " };
  const rewrite = { ...proposal("c.md", "Physics/MRI"), replacesTag: "mri" };
  const input = [absent, rewrite, trimEmpty];
  const before = [...input];
  const kept = filterAdditiveProposals(input);
  assert.deepEqual(kept, [absent, trimEmpty]); // given order kept
  assert.equal(kept[0], absent); // same proposal objects, no cloning beyond the filter
  assert.equal(kept[1], trimEmpty);
  assert.notEqual(kept, input); // a new array, never the caller's
  assert.deepEqual(input, before); // input array unmutated
});

// --- QA HOLD cycle 1: the explicit-selection apply path over the inline channel ---

void test("write-ahead order is total on EVERY port: each note's journal persists BEFORE its frontmatter write, no inline needed (F3)", async () => {
  // The order proof stands WITHOUT port.inline — the idle additive shape carries
  // the same write-ahead journal as the approved inline path.
  const log: string[] = [];
  const fm = makeFrontmatter({ "notes/a.md": ["Keep"], "notes/b.md": [] }, [], log);
  const ledger = makeLedger(null, false, log);
  const port = commandPort(fm.port, ledger.port);
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "Concept/A"), proposal("notes/b.md", "Concept/B")]),
    "Concept tags: applied 2 proposals to 2 notes, skipped 0.",
  );
  assert.deepEqual(log, ["journal-write", "fm-write:notes/a.md", "journal-write", "fm-write:notes/b.md"]);
  assert.deepEqual(journaled(ledger.text).map((e) => e.notePath), ["notes/a.md", "notes/b.md"]);
});

void test("a journal write failure on the inline path means zero mutation and surfaces in the counts", async () => {
  const log: string[] = [];
  const fm = makeFrontmatter({ "notes/a.md": ["Keep"] }, [], log);
  const ledger = makeLedger(null, true, log); // every ledger write throws
  const inline = makeInline({ "notes/a.md": "Text #Keep here." }, {}, log);
  const port = commandPort(fm.port, ledger.port, { inline: inline.access });
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "Concept/A")]),
    "Concept tags: applied 0 proposals to 0 notes, skipped 1.",
  ); // the journal-unavailable path lands in the skip count (the core records it)
  assert.deepEqual(fm.written, []); // write-ahead failed, so the note was never mutated
  assert.deepEqual(inline.writes, []); // neither channel moved
  assert.equal(inline.text("notes/a.md"), "Text #Keep here.");
  assert.deepEqual(log, ["journal-write-fail"]);
});

void test("inline drift vetoes the whole selected replacement: zero mutations on either channel", async () => {
  const log: string[] = [];
  const fm = makeFrontmatter({ "notes/a.md": ["Old"] }, [], log); // the frontmatter match EXISTS
  const ledger = makeLedger(null, false, log);
  const content = "Intro #Old text.";
  // A stale cache: the span claims "#Old" at offsets where the text is no longer there.
  const stale: InlineTagSpan = { start: 8, end: 12, text: "#Old" };
  const inline = makeInline({ "notes/a.md": content }, { "notes/a.md": [stale] }, log);
  const port = commandPort(fm.port, ledger.port, { inline: inline.access });
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "New", { replacesTag: "Old" })]),
    "Concept tags: applied 0 proposals to 0 notes, skipped 1.",
  ); // the whole replacement is vetoed (content-drift), not half-applied
  assert.deepEqual(fm.written, []);
  assert.deepEqual(fm.tags.get("notes/a.md"), ["Old"]);
  assert.deepEqual(inline.writes, []);
  assert.equal(inline.text("notes/a.md"), content);
  assert.deepEqual(ledger.writes, []); // a vetoed note has nothing applied, so nothing is journaled
});

void test("inline commit writes note content once, the journaled records recover on revertTagChanges", async () => {
  const log: string[] = [];
  const fm = makeFrontmatter({ "notes/a.md": ["Old", "Keep"] }, [], log);
  const ledger = makeLedger(null, false, log);
  const content = "Intro #Old text.";
  const inline = makeInline({ "notes/a.md": content }, { "notes/a.md": [spanIn(content, "#Old")] }, log);
  const port = commandPort(fm.port, ledger.port, { inline: inline.access });
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "New", { replacesTag: "Old" })]),
    "Concept tags: applied 1 proposals to 1 notes, skipped 0.",
  );
  assert.deepEqual(log, ["journal-write", "inline-write:notes/a.md", "fm-write:notes/a.md"]); // journal → body commit → tags write (C2 order)
  assert.deepEqual(fm.tags.get("notes/a.md"), ["Keep", "New"]); // survivors keep order, the new tag appends (0009)
  assert.equal(inline.writes.length, 1); // the note text is written exactly once
  assert.equal(inline.text("notes/a.md"), "Intro #New text.");
  const records = journaled(ledger.text);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].inlineEdits, [{ start: 6, end: 10, before: "#Old", after: "#New" }]); // the plan rode the write-ahead
  assert.equal(await revertTagChanges(port), "Concept tags: reverted 1 changes across 1 notes.");
  assert.deepEqual(fm.tags.get("notes/a.md"), ["Keep", "Old"]); // restored forms append after survivors (0010)
  assert.equal(inline.text("notes/a.md"), content); // the inline anchor reverted too
  assert.deepEqual(journaled(ledger.text), []); // and the entry left the journal
});

// --- QA HOLD cycle 2 (B1): note-level side channels, the integrated multi-rewrite regression ---

void test("integrated regression (QA B1): ONE call selecting both rewrites — final body exact, no erasure, truthful journal", async () => {
  const log: string[] = [];
  const fm = makeFrontmatter({ "notes/a.md": ["mri", "city"] }, [], log);
  const ledger = makeLedger(null, false, log);
  const inline = makeInline({ "notes/a.md": "a #mri b #city c" }, "live", log); // probe-shaped live-cache spans
  const port = commandPort(fm.port, ledger.port, { inline: inline.access });
  assert.equal(
    await applySelectedProposals(port, [
      proposal("notes/a.md", "Physics/MRI", { replacesTag: "mri" }),
      proposal("notes/a.md", "City", { replacesTag: "city" }),
    ]),
    "Concept tags: applied 2 proposals to 1 notes, skipped 0.",
  );
  const body = "a #Physics/MRI b #City c";
  assert.equal(inline.text("notes/a.md"), body); // the defect's corpse: BOTH rewrites landed, neither erased
  assert.equal(inline.writes.length, 1); // ONE note-level batch = ONE whole-document commit
  assert.deepEqual(fm.tags.get("notes/a.md"), ["Physics/MRI", "City"]);
  assert.deepEqual(log, ["journal-write", "inline-write:notes/a.md", "fm-write:notes/a.md"]); // write-ahead precedes the body commit AND the tags write
  const entries = journaled(ledger.text);
  assert.equal(entries.length, 2); // one receipt per applied proposal, in proposal order
  assert.deepEqual(entries[0].inlineEdits, [{ start: 2, end: 14, before: "#mri", after: "#Physics/MRI" }]); // its OWN group, final-frame anchors
  assert.deepEqual(entries[1].inlineEdits, [{ start: 17, end: 22, before: "#city", after: "#City" }]);
  for (const e of entries) for (const r of e.inlineEdits ?? []) assert.equal(body.slice(r.start, r.end), r.after); // the journal is truthful against the final body
});

void test("a second apply call renames another tag without erasing the previous call's body edits", async () => {
  const fm = makeFrontmatter({ "notes/a.md": ["mri", "city"] });
  const ledger = makeLedger();
  const inline = makeInline({ "notes/a.md": "a #mri b #city c" }, "live");
  const port = commandPort(fm.port, ledger.port, { inline: inline.access });
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "Physics/MRI", { replacesTag: "mri" })]),
    "Concept tags: applied 1 proposals to 1 notes, skipped 0.",
  );
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "City", { replacesTag: "city" })]),
    "Concept tags: applied 1 proposals to 1 notes, skipped 0.",
  );
  assert.equal(inline.text("notes/a.md"), "a #Physics/MRI b #City c"); // call 2's fresh plan keeps call 1's edits
  assert.deepEqual(fm.tags.get("notes/a.md"), ["Physics/MRI", "City"]);
  assert.equal(journaled(ledger.text).length, 2); // each call journaled its own receipt
});

void test("commit drift: revalidation read differs → content-drift skip, body untouched, tags write proceeds, journal stands pending", async () => {
  const log: string[] = [];
  const fm = makeFrontmatter({ "notes/a.md": ["Old"] }, [], log);
  const ledger = makeLedger(null, false, log);
  const content = "Intro #Old text.";
  let reads = 0;
  let bodyWrites = 0;
  const access: InlineRewriteAccess = {
    // The note changes between the plan read and the commit revalidation:
    // the plan sees the old text, the revalidation sees something else.
    readNoteContent: async () => (++reads === 1 ? content : `${content} #typed`),
    writeNoteContent: async () => {
      bodyWrites += 1;
      log.push("inline-write:notes/a.md");
    },
    inlineTagSpans: async () => [spanIn(content, "#Old")],
  };
  const port = commandPort(fm.port, ledger.port, { inline: access });
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "New", { replacesTag: "Old" })]),
    "Concept tags: applied 1 proposals to 1 notes, skipped 1.",
  ); // the drifted commit surfaces as the replacement's content-drift skip (C2)
  assert.equal(bodyWrites, 0); // nothing was written to the body
  assert.deepEqual(fm.written, ["notes/a.md"]); // the tags write proceeds after the drift
  assert.deepEqual(fm.tags.get("notes/a.md"), ["New"]);
  assert.deepEqual(log, ["journal-write", "fm-write:notes/a.md"]); // no body commit between them
  const entries = journaled(ledger.text); // the write-ahead entry stands, planned records pending
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].inlineEdits, [{ start: 6, end: 10, before: "#Old", after: "#New" }]);
});

// --- QA HOLD cycle 3: the serialized operation queue and the batch ordinal ---

void test("concurrent applySelectedProposals calls queue: both land, distinct persisted ordinals, revert-all restores exactly", async () => {
  // Promise.all races two invocations on ONE port at the same NOW. Without the
  // serialized operation queue both would read the empty journal and allocate
  // batch 1 twice — the journal's ordinals are the queue's observable ordering:
  // start order, dense and collision-free, each caller seeing the other's write.
  const fm = makeFrontmatter({ "notes/a.md": ["aa"], "notes/b.md": ["bb"] });
  const ledger = makeLedger();
  const inline = makeInline({ "notes/a.md": "one #aa two", "notes/b.md": "three #bb four" }, "live");
  const port = commandPort(fm.port, ledger.port, { inline: inline.access });
  const notices = await Promise.all([
    applySelectedProposals(port, [proposal("notes/a.md", "AlphaLong", { replacesTag: "aa" })]), // grows
    applySelectedProposals(port, [proposal("notes/b.md", "B", { replacesTag: "bb" })]), // shrinks
  ]);
  assert.deepEqual(notices, [
    "Concept tags: applied 1 proposals to 1 notes, skipped 0.",
    "Concept tags: applied 1 proposals to 1 notes, skipped 0.",
  ]); // both land
  assert.equal(inline.text("notes/a.md"), "one #AlphaLong two");
  assert.equal(inline.text("notes/b.md"), "three #B four");
  const entries = journaled(ledger.text);
  assert.deepEqual(entries.map((e) => [e.notePath, e.batch]), [["notes/a.md", 1], ["notes/b.md", 2]]); // queue start order == append order, ordinals distinct and dense
  assert.equal(await revertTagChanges(port), "Concept tags: reverted 2 changes across 2 notes."); // truthful counts
  assert.equal(inline.text("notes/a.md"), "one #aa two"); // the EXACT original bodies
  assert.equal(inline.text("notes/b.md"), "three #bb four");
  assert.deepEqual(fm.tags.get("notes/a.md"), ["aa"]);
  assert.deepEqual(fm.tags.get("notes/b.md"), ["bb"]);
  assert.deepEqual(journaled(ledger.text), []); // the journal drains, never discarded
});

void test("probe3 regression: same-millisecond sequential calls journal distinct ordinals and revert-all restores exactly", async () => {
  // QA probe3's corpse at the commands layer: ONE clock (both calls NOW),
  // city→Urban SECOND and EARLIER in the document with a length change — under
  // timestamp grouping the two applies false-merge into one frame; under the
  // persisted ordinals each call's write stands alone. Seed ["mri","city"]:
  // restored forms append after survivors, the order that lands back exactly.
  const fm = makeFrontmatter({ "notes/a.md": ["mri", "city"] });
  const ledger = makeLedger();
  const inline = makeInline({ "notes/a.md": "x #city y #mri z" }, "live");
  const port = commandPort(fm.port, ledger.port, { inline: inline.access });
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "Physics/MRI", { replacesTag: "mri" })]),
    "Concept tags: applied 1 proposals to 1 notes, skipped 0.",
  );
  assert.equal(
    await applySelectedProposals(port, [proposal("notes/a.md", "Urban", { replacesTag: "city" })]),
    "Concept tags: applied 1 proposals to 1 notes, skipped 0.",
  );
  assert.equal(inline.text("notes/a.md"), "x #Urban y #Physics/MRI z");
  const entries = journaled(ledger.text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.batch), [1, 2]); // distinct persisted ordinals...
  assert.deepEqual(entries.map((e) => e.timestamp), [NOW, NOW]); // ...over one shared millisecond: time never groups
  assert.equal(await revertTagChanges(port), "Concept tags: reverted 2 changes across 1 notes."); // truthful counts
  assert.equal(inline.text("notes/a.md"), "x #city y #mri z"); // the EXACT original body
  assert.deepEqual(fm.tags.get("notes/a.md"), ["mri", "city"]); // the EXACT original frontmatter
  assert.deepEqual(journaled(ledger.text), []); // the journal empties: no stranded entry
});
