// Unit tests for the inline rewrite core: offline, synthetic, pure — span-level only,
// because fence/link/url exclusion lives in the caller's cache, not in this module.
import { test } from "node:test";
import assert from "node:assert/strict";
// Node's transform-types needs the ".ts" specifier; tsconfig (not ours to edit) omits
// allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else.
// @ts-expect-error
import { computeInlineRewrite, computeInlineRewriteBatch, revertInlineRewrites, type InlineEditRecord, type InlineReplacementRequest, type InlineTagSpan } from "./inline-rewrite.ts";

// Three inline "#Old" occurrences plus one unrelated tag, no fence or link anywhere.
const CONTENT = "One #Old two #Old three #Old end #Other";
const OLD_SPANS = spansOf(CONTENT, "#Old"); // 3 targets
const ALL_SPANS = [...OLD_SPANS, ...spansOf(CONTENT, "#Other")]; // document order, as the cache emits

// The shape the cache hands over: one span per occurrence of `text`, in document order.
function spansOf(content: string, text: string): InlineTagSpan[] {
  const spans: InlineTagSpan[] = [];
  for (let i = content.indexOf(text); i !== -1; i = content.indexOf(text, i + 1)) {
    spans.push({ start: i, end: i + text.length, text });
  }
  return spans;
}

// Every record's anchor must locate its own `after` exactly in the content the plan made.
function assertAnchors(content: string, edits: InlineEditRecord[]) {
  for (const e of edits) assert.equal(content.slice(e.start, e.end), e.after);
}

void test("compute: rewrites EVERY exactly-matching span, leaves non-matching spans alone", () => {
  const plan = computeInlineRewrite(CONTENT, ALL_SPANS, "Old", "NewPath");
  assert.notEqual(plan, null);
  assert.equal(plan!.content, "One #NewPath two #NewPath three #NewPath end #Other");
  assert.equal(plan!.edits.length, 3); // occurrence-complete: no twin left behind, "#Other" untouched
});

void test("compute: edits carry exact before/after pairs, ascending, each anchored on its own rewrite", () => {
  const plan = computeInlineRewrite(CONTENT, ALL_SPANS, "Old", "MachineLearning/NeuralNetworks");
  assert.deepEqual(plan!.edits.map((e) => [e.before, e.after]),
    OLD_SPANS.map(() => ["#Old", "#MachineLearning/NeuralNetworks"])); // inserted verbatim after "#"
  assertAnchors(plan!.content, plan!.edits);
  assert.deepEqual(plan!.edits.map((e) => e.start), [...plan!.edits.map((e) => e.start)].sort((a, b) => a - b));
  // Anchors are the span starts carried forward: the first is the original offset, each
  // later one shifted by the plan's own length delta.
  const delta = plan!.edits[0].after.length - plan!.edits[0].before.length;
  assert.equal(plan!.edits[0].start, OLD_SPANS[0].start);
  assert.deepEqual(plan!.edits.map((e, i) => e.start), OLD_SPANS.map((s, i) => s.start + i * delta));
});

void test("compute: a stale span vetoes the WHOLE call — null, never a partial plan", () => {
  const staleAt = (i: number): InlineTagSpan[] =>
    OLD_SPANS.map((s, j) => (j === i ? { ...s, start: s.start + 1, end: s.end + 1 } : s));
  // One moved span among two sound ones: the sound ones get nothing either.
  assert.equal(computeInlineRewrite(CONTENT, staleAt(0), "Old", "NewPath"), null);
  assert.equal(computeInlineRewrite(CONTENT, staleAt(1), "Old", "NewPath"), null);
  assert.equal(computeInlineRewrite(CONTENT, staleAt(2), "Old", "NewPath"), null);
  // Same offsets, cached text that no longer matches: also a veto.
  const staleText = OLD_SPANS.map((s, j) => (j === 2 ? { ...s, text: "#Gone" } : s));
  assert.equal(computeInlineRewrite(CONTENT, staleText, "Gone", "NewPath"), null);
});

void test("compute: span text is matched exactly — no case folding anywhere", () => {
  const lower = spansOf(CONTENT, "#Old").map((s) => ({ ...s, text: "#old" }));
  const plan = computeInlineRewrite(CONTENT, lower, "Old", "NewPath");
  assert.deepEqual(plan, { content: CONTENT, edits: [] }); // "#old" spans are not targets
  const target = computeInlineRewrite(CONTENT, spansOf(CONTENT, "#Other"), "Other", "other");
  assert.equal(target!.content, "One #Old two #Old three #Old end #other"); // new path as given
});

void test("compute: empty spans and no matching span are clean no-ops", () => {
  assert.deepEqual(computeInlineRewrite(CONTENT, [], "Old", "NewPath"), { content: CONTENT, edits: [] });
  assert.deepEqual(computeInlineRewrite("", [], "Old", "NewPath"), { content: "", edits: [] });
  const onlyOther = spansOf(CONTENT, "#Other");
  assert.deepEqual(computeInlineRewrite(CONTENT, onlyOther, "Old", "NewPath"), { content: CONTENT, edits: [] });
});

void test("compute: out-of-order spans still yield ascending edits and never reorder the caller's array", () => {
  const shuffled = [OLD_SPANS[2], OLD_SPANS[0], OLD_SPANS[1], ...spansOf(CONTENT, "#Other")];
  const plan = computeInlineRewrite(CONTENT, shuffled, "Old", "NewPath");
  assert.equal(plan!.content, "One #NewPath two #NewPath three #NewPath end #Other");
  assertAnchors(plan!.content, plan!.edits); // same plan as the document-order call
  assert.deepEqual(plan!.edits, computeInlineRewrite(CONTENT, ALL_SPANS, "Old", "NewPath")!.edits);
  assert.equal(shuffled[0].start, OLD_SPANS[2].start); // input order intact
});

void test("revert: restores every committed anchor and round-trips the plan exactly", () => {
  const plan = computeInlineRewrite(CONTENT, ALL_SPANS, "Old", "NewPath");
  const result = revertInlineRewrites(plan!.content, plan!.edits);
  assert.deepEqual(result, { content: CONTENT, reverted: 3, skipped: 0 });
});

void test("revert: skips an anchor the user retyped — no clobber, counted, neighbours still restored", () => {
  const plan = computeInlineRewrite(CONTENT, ALL_SPANS, "Old", "NewPath");
  const victim = plan!.edits[1];
  // A length-neutral retype inside one committed anchor: the neighbouring anchors still hold.
  const touched = plan!.content.slice(0, victim.start) + "#newpath" + plan!.content.slice(victim.end);
  const result = revertInlineRewrites(touched, plan!.edits);
  assert.equal(result.content, "One #Old two #newpath three #Old end #Other");
  assert.deepEqual({ reverted: result.reverted, skipped: result.skipped }, { reverted: 2, skipped: 1 });
});

void test("revert: a plan that never committed is every anchor mismatched — skipped, zero corruption", () => {
  const plan = computeInlineRewrite(CONTENT, ALL_SPANS, "Old", "NewPath");
  const result = revertInlineRewrites(CONTENT, plan!.edits); // the file still reads `before` everywhere
  assert.deepEqual(result, { content: CONTENT, reverted: 0, skipped: 3 });
});

void test("revert: empty edits are a clean no-op and the caller's records keep their order", () => {
  assert.deepEqual(revertInlineRewrites(CONTENT, []), { content: CONTENT, reverted: 0, skipped: 0 });
  const plan = computeInlineRewrite(CONTENT, ALL_SPANS, "Old", "NewPath");
  const descending = [...plan!.edits].reverse(); // each record is anchored on its own rewrite, so order is the caller's business
  const result = revertInlineRewrites(plan!.content, descending);
  assert.deepEqual(result, { content: CONTENT, reverted: 3, skipped: 0 });
  assert.deepEqual(descending.map((e) => e.start), [...plan!.edits.map((e) => e.start)].reverse()); // ledger's array untouched
});

void test("revert: a selection of a plan's records reverts on its own, anchor by anchor", () => {
  const plan = computeInlineRewrite(CONTENT, ALL_SPANS, "Old", "NewPath");
  const result = revertInlineRewrites(plan!.content, [plan!.edits[2]]); // the ledger may revert one entry's slice
  assert.equal(result.content, "One #NewPath two #NewPath three #Old end #Other");
  assert.deepEqual({ reverted: result.reverted, skipped: result.skipped }, { reverted: 1, skipped: 0 });
});

void test("compute: adjacent occurrences both rewrite; a duplicated span rewrites its occurrence once", () => {
  const tight = "Two #Old#Old twins"; // no separator: the second occurrence starts exactly where the first ends
  const plan = computeInlineRewrite(tight, spansOf(tight, "#Old"), "Old", "New");
  assert.equal(plan!.content, "Two #New#New twins");
  assert.equal(plan!.edits.length, 2);
  const doubled = computeInlineRewrite(tight, [...spansOf(tight, "#Old"), ...spansOf(tight, "#Old")], "Old", "New");
  assert.equal(doubled!.content, "Two #New#New twins"); // a span handed twice is one occurrence, not two cuts
  assert.equal(doubled!.edits.length, 2);
  assert.deepEqual(revertInlineRewrites(doubled!.content, doubled!.edits).content, tight);
});

void test("revert: the same records handed twice cut once — the twin anchors are skipped, nothing duplicates", () => {
  const plan = computeInlineRewrite(CONTENT, ALL_SPANS, "Old", "NewPath");
  const result = revertInlineRewrites(plan!.content, [...plan!.edits, ...plan!.edits]);
  assert.deepEqual(result, { content: CONTENT, reverted: 3, skipped: 3 });
});

// --- the combined per-note batch planner (QA hold cycle 2, B1) ---------------------------

// One note, two approved replacements. "#Two" sits FIRST in the document, "#Keep" is a tag no
// request touches, and both renames change length ("#Old" grows, "#Two" shrinks).
const BATCH = "Alpha #Two beta #Old gamma #Two delta #Old end #Keep";
const BATCH_SPANS = [
  spansOf(BATCH, "#Two")[0], spansOf(BATCH, "#Old")[0], // document order, as the cache emits
  spansOf(BATCH, "#Two")[1], spansOf(BATCH, "#Old")[1], ...spansOf(BATCH, "#Keep"),
];
// Request 1's spans PRECEDE request 0's: the fold must carry request 0's records across them.
const REVERSED: InlineReplacementRequest[] = [
  { replacesTag: "Old", tagPath: "MachineLearning" },
  { replacesTag: "Two", tagPath: "T" },
];
const BATCH_OUT = "Alpha #T beta #MachineLearning gamma #T delta #MachineLearning end #Keep";

void test("batch: two same-note requests in REVERSED document order fold into ONE truthful document plan", () => {
  const batch = computeInlineRewriteBatch(BATCH, BATCH_SPANS, REVERSED);
  assert.notEqual(batch, null);
  assert.equal(batch!.source, BATCH); // the commit-time revalidation basis, untouched
  assert.equal(batch!.content, BATCH_OUT); // occurrence-complete across BOTH requests
  assert.equal(batch!.editGroups.length, 2); // aligned with requests, request order intact
  // Every group is anchored in the FINAL frame: request 0's records sit past request 1's
  // length deltas that precede them (-2 for "#Two"→"#T"), not on their original offsets.
  assert.deepEqual(batch!.editGroups[0].map((e) => e.start), [14, 46]);
  assert.deepEqual(batch!.editGroups[1].map((e) => e.start), [6, 37]);
  for (const group of batch!.editGroups) {
    assert.equal(group.length, 2);
    assertAnchors(batch!.content, group); // simultaneously valid slices against ONE content
  }
  assert.deepEqual(batch!.editGroups[0].map((e) => [e.before, e.after]), [["#Old", "#MachineLearning"], ["#Old", "#MachineLearning"]]);
  assert.deepEqual(batch!.editGroups[1].map((e) => [e.before, e.after]), [["#Two", "#T"], ["#Two", "#T"]]);
});

void test("batch: a request with no matching spans is an EMPTY group while the rest of the batch commits", () => {
  const batch = computeInlineRewriteBatch(BATCH, BATCH_SPANS, [
    REVERSED[0],
    { replacesTag: "Ghost", tagPath: "Nowhere" }, // the cache holds no "#Ghost" occurrence
    REVERSED[1],
  ]);
  assert.notEqual(batch, null); // a request that matches nothing is NOT drift
  assert.equal(batch!.content, BATCH_OUT); // the other two requests commit unchanged
  assert.deepEqual(batch!.editGroups.map((g) => g.length), [2, 0, 2]); // still aligned with requests
  assert.deepEqual(batch!.editGroups[1], []);
});

void test("batch: one stale span ANYWHERE in the fold vetoes the WHOLE batch — null, never a partial plan", () => {
  const drift = (list: InlineTagSpan[], i: number): InlineTagSpan[] =>
    list.map((s, j) => (j === i ? { ...s, start: s.start + 1, end: s.end + 1 } : s));
  // A stale target of the FIRST request: the second request's spans get nothing either.
  assert.equal(computeInlineRewriteBatch(BATCH, drift(BATCH_SPANS, 1), REVERSED), null);
  // A stale target of the LAST request: request 0's already-folded cuts are dropped with it —
  // the batch is all-or-nothing, so no partial plan can reach a writer.
  assert.equal(computeInlineRewriteBatch(BATCH, drift(BATCH_SPANS, 2), REVERSED), null);
  // Sound offsets, cached text that no longer matches: the same veto, in the later request.
  const staleText = BATCH_SPANS.map((s) => (s.text === "#Two" ? { ...s, text: "#Gone" } : s));
  assert.equal(computeInlineRewriteBatch(BATCH, staleText, [{ replacesTag: "Gone", tagPath: "X" }]), null);
});

void test("batch: groups reverted independently, per entry, in inverse request order restore the exact original", () => {
  // Request order here MATCHES document order, so the newest entry's edits sit LAST in the
  // document: reverting them first leaves every earlier entry's final-frame anchors intact.
  const ORDERED = "Alpha #Two beta #Two gamma #Old delta #Old end";
  const orderedSpans = [...spansOf(ORDERED, "#Two"), ...spansOf(ORDERED, "#Old")];
  const batch = computeInlineRewriteBatch(ORDERED, orderedSpans, [
    { replacesTag: "Two", tagPath: "T" },
    REVERSED[0],
  ]);
  assert.notEqual(batch, null);
  const newest = revertInlineRewrites(batch!.content, batch!.editGroups[1]); // the entry applied last
  assert.deepEqual({ reverted: newest.reverted, skipped: newest.skipped }, { reverted: 2, skipped: 0 });
  const oldest = revertInlineRewrites(newest.content, batch!.editGroups[0]); // then the entry before it
  assert.deepEqual({ reverted: oldest.reverted, skipped: oldest.skipped }, { reverted: 2, skipped: 0 });
  assert.equal(oldest.content, ORDERED); // the exact original body, nothing clobbered
  // One frame for the whole batch: a batch may also be reverted in ONE call even where the
  // requests interleave in the document, which no per-plan merging could claim.
  const interleaved = computeInlineRewriteBatch(BATCH, BATCH_SPANS, REVERSED);
  const whole = revertInlineRewrites(interleaved!.content, interleaved!.editGroups.flat());
  assert.deepEqual({ content: whole.content, reverted: whole.reverted, skipped: whole.skipped },
    { content: BATCH, reverted: 4, skipped: 0 });
});
