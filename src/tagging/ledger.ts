// =============================================================================
// CHANGE LEDGER — the vault's undo trail for applied tag changes.
//
// The vault is not under git, so the apply engine carries its own undo: every
// applied proposal of an ApplyResult is journaled as one LedgerEntry (note
// path, injected timestamp, kind, tag path, the exact forms the mutation added
// and displaced, and the note's before-/after-arrays for the apply call).
// revertAppliedChanges restores what a selection of entries did — frontmatter
// oldest-first per note with still-present/still-absent guards, inline undo
// batch-by-batch newest-first by the persisted batch ORDINAL (LIFO across
// batches, ONE merged revert call within a batch, so a revert-all restores the
// exact original body across and inside successive batches) — and
// pruneLedgerEntries drops entries past a retention window (zero
// retention keeps everything, because there is no git to fall back on).
//
// The journal is persisted as JSON text through the injected LedgerStoragePort;
// malformed stored JSON throws rather than silently reset a journal that might
// not be empty. Entries also carry planned inline edit records (inline-rewrite,
// order 0018): revertAppliedChanges undoes committed inline text through the
// optional InlineRevertAccess, guarded so perturbed anchors and never-committed
// plans skip instead of clobbering — and an entry whose inline undo did not
// fully complete stays pending in the journal rather than being consumed as a
// success. The module is pure: no Obsidian, DOM, fs,
// clock or store imports, and every timestamp is injected by the caller, so
// tests are deterministic.
// =============================================================================

import type { ProposalKind } from "./proposal";
import type { ApplyFrontmatterPort, ApplyNoteOutput, ApplyResult, ApplySkipReason } from "./apply";
import type { InlineEditRecord } from "./inline-rewrite";
// Value imports need the ".ts" specifier for Node's runtime (the test chain has
// no extension resolution); the expect-error pins the one tsc complaint.
// @ts-expect-error
import { revertInlineRewrites } from "./inline-rewrite.ts";

export interface LedgerEntry {
  notePath: string;
  timestamp: number;        // milliseconds, injected by the caller
  kind: ProposalKind;
  tagPath: string;
  addedTags: string[];      // exact tag forms this mutation appended
  removedTags: string[];    // exact tag forms this mutation displaced (replace only)
  tagsBefore: string[];     // the note's array before the apply call ([] when it had no tags key)
  tagsAfter: string[];      // the note's array after the apply call
  inlineEdits?: InlineEditRecord[]; // planned and journaled inline rewrites ([] = none); copy, never the caller's array
  batch: number;            // persisted monotonic ordinal of ONE apply invocation's journal write for this note — the collision-free batch identity, allocated at append time from the persisted journal's current maximum (nextBatchOrdinal) under the serialized operation queue (order 0011); NEVER derived from time. LEGACY entries written before this identity carry no member (the revert groups those per-entry).
}

// Optional text seam for reverting inline edits: without it, inline records
// cannot be touched and are reported skipped instead.
export interface InlineRevertAccess {
  readNoteContent(notePath: string): Promise<string | null>;
  writeNoteContent(notePath: string, text: string): Promise<void>;
}

// Text seam: the port stores the serialized journal; null text means no ledger
// file exists yet. Malformed stored JSON makes parsing throw (never silently
// reset a journal that might not be empty).
export interface LedgerStoragePort {
  readLedgerText(): Promise<string | null>;
  writeLedgerText(text: string): Promise<void>;
}

const DAY_MS = 86400000;

// One entry's pending inline work during a revert.
interface PendingInline {
  entry: LedgerEntry;
  edits: InlineEditRecord[];
}

// One pending inline batch during a revert: every record sharing one batch
// identity (or one LEGACY entry's own single-entry batch), frame-shared.
interface InlineBatch {
  batch: number | undefined; // undefined: a LEGACY write — no persisted ordinal
  timestamp: number; // reporting data only; orders LEGACY batches by timestamp DESC
  position: number; // note-local commit position of the batch's newest member
  items: PendingInline[];
}

// One parse point for the journal; a non-array document is as malformed as bad syntax.
function parseJournal(text: string): LedgerEntry[] {
  const parsed: unknown = JSON.parse(text); // malformed JSON throws by design
  if (!Array.isArray(parsed)) throw new TypeError("ledger JSON must be an array");
  return parsed as LedgerEntry[];
}

async function readJournal(storage: LedgerStoragePort): Promise<LedgerEntry[]> {
  const text = await storage.readLedgerText();
  if (text === null) return []; // absent ledger file reads as an empty journal
  return parseJournal(text);
}

// The pure batch-ordinal allocation rule, applied to the persisted journal
// text: one apply invocation's journal write takes the journal's current
// maximum batch + 1 (an absent journal or legacy entries without a batch
// member start at 1; malformed JSON throws like every other read). BATCH IS
// NEVER DERIVED FROM TIME; every journal write allocates through exactly this
// rule, under the serialized operation queue of the command layer (0011), so
// the read-modify-write is race-free and restart-durable.
export function nextBatchOrdinal(journalText: string | null): number {
  let max = 0;
  if (journalText !== null) for (const entry of parseJournal(journalText)) if (typeof entry.batch === "number" && entry.batch > max) max = entry.batch;
  return max + 1;
}

// Pure entry construction from a note's apply receipt: one entry per applied
// proposal in appliedProposals order, all carrying the caller's allocated
// batch ordinal (the collision-free batch identity — see nextBatchOrdinal),
// with the proposal's inline plans copied entry-ward (the journal never shares
// an array with its source).
export function journalEntriesForNote(note: ApplyNoteOutput, timestamp: number, batch: number): LedgerEntry[] {
  return note.appliedProposals.map((proposal) => ({
    notePath: note.notePath,
    timestamp,
    batch,
    kind: proposal.kind,
    tagPath: proposal.tagPath,
    addedTags: [...proposal.addedTags],
    removedTags: [...proposal.removedTags],
    tagsBefore: [...note.tagsBefore],
    tagsAfter: [...note.tagsAfter],
    ...(proposal.inlineEdits === undefined ? {} : { inlineEdits: proposal.inlineEdits.map((r) => ({ ...r })) }),
  }));
}

// Durable append (the write-ahead primitive every journal write flows through):
// read-modify-write the full journal; an empty append touches nothing, not even a read.
export async function appendLedgerEntries(entries: LedgerEntry[], storage: LedgerStoragePort): Promise<void> {
  if (entries.length === 0) return;
  const journal = await readJournal(storage);
  journal.push(...entries);
  await storage.writeLedgerText(JSON.stringify(journal));
}

// Append one entry per applied proposal of every note output: a composition
// over the same primitives the write-ahead path journals through, allocating
// this invocation's batch ordinal through the one allocation rule. Nothing
// applied means no entries: not even a journal read happens.
export async function recordAppliedChanges(
  result: ApplyResult,
  storage: LedgerStoragePort,
  timestamp: number,
): Promise<void> {
  const outputs = result.notes.filter((note) => note.appliedProposals.length > 0);
  if (outputs.length === 0) return;
  const batch = nextBatchOrdinal(await storage.readLedgerText());
  await appendLedgerEntries(outputs.flatMap((note) => journalEntriesForNote(note, timestamp, batch)), storage);
}

// Restore what the selected entries introduced. Frontmatter channel first per
// note, oldest-first: the guards (remove only when still present, restore only
// when still absent) make reverts order-independent and partial reverts safe;
// phantom frontmatter actions act on nothing through the same guards. The
// inline channel runs SECOND, batch-by-batch newest-first by the PERSISTED
// BATCH ORDINAL — batch-ordinal DESC, the exact inverse of journal-append
// (commit) order — where a BATCH is one apply invocation's journal write for
// the note (its entries sharing the `batch` member). Timestamps never group:
// two same-millisecond apply calls are two batches (QA probe3). Every record
// of a batch sits in that batch's single final frame, so a batch reverts
// through ONE merged revertInlineRewrites call over all its entries' records
// (order-independent within the batch): per-entry calls would shift each
// other's anchors where a batch's journal positions oppose its document
// positions. Absent intervening edits a revert-all therefore restores the EXACT
// original body, across batches and inside one. A record restores only where
// the text still equals its `after`, so perturbed anchors and never-committed
// plans skip instead of clobbering, and which records landed is read back off
// the REVERTED text: an entry is CONSUMED only when its WHOLE undo completed —
// any inline restoration failure (or absent access / unreachable text) RETAINS
// it with skip receipts; the frontmatter guards make the retry idempotent, the
// inline records stay pending. Without inlineAccess the inline part cannot be
// touched and its records are reported skipped instead.
export async function revertAppliedChanges(
  storage: LedgerStoragePort,
  frontmatter: ApplyFrontmatterPort,
  inlineAccess?: InlineRevertAccess,
  revertFilter?: (entry: LedgerEntry) => boolean,
): Promise<ApplyResult> {
  const journal = await readJournal(storage);
  const byNote = new Map<string, LedgerEntry[]>(); // iteration order = journal order of each note's first selected entry
  for (const entry of journal) {
    if (revertFilter && !revertFilter(entry)) continue;
    const group = byNote.get(entry.notePath);
    if (group) group.push(entry);
    else byNote.set(entry.notePath, [entry]);
  }
  const consumed = new Set<LedgerEntry>(); // entries dropped from the journal; failed notes' entries stay
  const notes: ApplyNoteOutput[] = [];
  let appliedProposalCount = 0;
  let skippedProposalCount = 0;
  let mutatedNoteCount = 0;
  for (const [notePath, group] of byNote) {
    const ordered = [...group].sort((a, b) => a.timestamp - b.timestamp); // stable sort: ties keep journal order
    const skipAll = (tagsBefore: string[]): void => {
      notes.push({
        notePath,
        tagsBefore,
        tagsAfter: [...tagsBefore],
        appliedProposals: [],
        skippedProposals: ordered.map((entry) => ({ tagPath: entry.tagPath, reason: "note-unavailable" as const })),
      });
      skippedProposalCount += ordered.length;
    };
    let current: string[] | null;
    try {
      current = await frontmatter.readNoteTags(notePath);
    } catch {
      skipAll([]); // a failed read keeps the note's entries and rewrites nothing
      continue;
    }
    const before = current === null ? [] : [...current]; // null maps to [] in the receipt
    const tags = [...before];
    const applied: ApplyNoteOutput["appliedProposals"] = [];
    for (const entry of ordered) {
      const removedHere: string[] = [];
      for (const form of entry.addedTags) {
        if (!tags.includes(form)) continue; // guard: remove only what is still present
        for (let i = tags.length - 1; i >= 0; i--) if (tags[i] === form) tags.splice(i, 1); // exact forms, every occurrence
        removedHere.push(form);
      }
      const restoredHere: string[] = [];
      for (const form of entry.removedTags) {
        if (tags.includes(form)) continue; // guard: restore only what is still absent
        tags.push(form); // restored forms land after the surviving tags, in exact form
        restoredHere.push(form);
      }
      // An entry whose guards yield no action is still consumed, reported in neither count.
      if (removedHere.length > 0 || restoredHere.length > 0) {
        applied.push({
          kind: entry.kind,
          tagPath: entry.tagPath,
          replacesTag: null,
          addedTags: restoredHere,
          removedTags: removedHere,
        });
      }
    }
    let written = false;
    if (applied.length > 0) {
      try {
        await frontmatter.writeNoteTags(notePath, tags);
        written = true;
      } catch {
        skipAll(before); // a failed write keeps the note's entries in the journal
        continue;
      }
    }
    // Inline channel, second per note; one skip receipt per record that
    // cannot or must not be restored.
    const pending: PendingInline[] = ordered.flatMap((e) => (e.inlineEdits && e.inlineEdits.length > 0 ? [{ entry: e, edits: e.inlineEdits }] : []));
    const inlineSkips: { tagPath: string; reason: ApplySkipReason }[] = [];
    const pendingInline = new Set<LedgerEntry>(); // any inline record unrestored retains its entry: the undo is not whole
    const skipAllInline = (): void => {
      for (const { entry, edits } of pending) {
        pendingInline.add(entry);
        for (let i = 0; i < edits.length; i++) inlineSkips.push({ tagPath: entry.tagPath, reason: "inline-unavailable" });
      }
    };
    let inlineMutated = false;
    if (pending.length > 0 && inlineAccess !== undefined) {
      let content: string | null;
      try {
        content = await inlineAccess.readNoteContent(notePath);
      } catch {
        content = null; // a throwing read and a missing note are the same case here: the text is unreachable
      }
      if (content === null) {
        skipAllInline();
      } else {
        // Grouping identity is the persisted batch ordinal, NEVER the
        // timestamp (QA probe3: two same-millisecond apply calls share a
        // timestamp, and merging their records into one frame mis-anchors the
        // older batch). A numbered batch holds every record of every entry
        // sharing its ordinal — one apply invocation's write for this note,
        // one shared final frame — and numbered batches process in
        // batch-ordinal DESC, the exact inverse of journal-append (commit)
        // order. LEGACY records — journal entries written before the batch
        // identity existed, no `batch` member — are explicit: EACH entry is
        // its OWN single-entry batch (per-entry reverts cannot false-merge
        // frames), and legacy batches order among the note's batches by
        // timestamp DESC with REVERSE journal position as the tie-break.
        // `pending` follows the ascending `ordered` (timestamp ASC, ties in
        // journal order), so a pending index is the note-local commit
        // position the tie-break and the mixed numbered/legacy compare use.
        const batches = new Map<string, InlineBatch>();
        pending.forEach((item, i) => {
          const ordinal = typeof item.entry.batch === "number" ? item.entry.batch : undefined; // absent on LEGACY reads
          const key = ordinal === undefined ? `legacy:${i}` : `batch:${ordinal}`; // every LEGACY entry stands alone
          const held = batches.get(key);
          if (held) held.items.push(item);
          else batches.set(key, { batch: ordinal, timestamp: item.entry.timestamp, position: i, items: [item] });
        });
        const newestFirst = [...batches.values()].sort((a, b) =>
          a.batch !== undefined && b.batch !== undefined
            ? b.batch - a.batch // numbered pair: exact inverse of commit order
            : b.timestamp - a.timestamp || b.position - a.position); // LEGACY and mixed pairs
        let text = content;
        for (const group of newestFirst) {
          const from = text;
          const records = group.items.flatMap((p) => p.edits.map((record) => ({ entry: p.entry, record })));
          // ONE merged call over the whole batch frame: order-independent, and
          // exact where per-entry calls would shift each other's anchors.
          text = revertInlineRewrites(text, records.map((r) => r.record)).content;
          // Attribution reads POST-revert state, in the REVERTED frame: a record is
          // restored iff the call could act on it (its anchor still held `after`) and
          // the reverted text now carries `before` at its offset there — every earlier
          // restored record of the batch shifts it by its own length delta.
          const done = new Set<(typeof records)[number]>();
          let shift = 0; // the merged call's running length delta ahead of this record
          let pos = 0; // its cursor in the pre-revert frame: a twin anchor is the same cut
          for (const item of [...records].sort((a, b) => a.record.start - b.record.start)) {
            const { record } = item;
            if (record.start < pos || from.slice(record.start, record.end) !== record.after) continue;
            const at = record.start + shift;
            shift += record.before.length - record.after.length;
            pos = record.end;
            if (text.slice(at, at + record.before.length) !== record.before) continue;
            done.add(item);
          }
          for (const item of records) {
            if (done.has(item)) continue;
            pendingInline.add(item.entry); // unrestored: the undo of this record is not in the text
            inlineSkips.push({ tagPath: item.entry.tagPath, reason: "inline-unavailable" });
          }
        }
        if (text !== content) {
          try {
            await inlineAccess.writeNoteContent(notePath, text);
            inlineMutated = true;
          } catch {
            inlineSkips.length = 0;
            skipAllInline(); // nothing persisted: none of the records were restored
          }
        }
      }
    } else if (pending.length > 0) {
      skipAllInline(); // no inline access: the caller cannot safely touch text it has no access to
    }
    // Consume per entry (not per note): only entries whose WHOLE undo completed
    // leave the journal — no-action entries never enter pendingInline either.
    for (const entry of ordered) if (!pendingInline.has(entry)) consumed.add(entry);
    if (applied.length > 0 || inlineSkips.length > 0 || inlineMutated) {
      notes.push({ notePath, tagsBefore: before, tagsAfter: written ? tags : before, appliedProposals: applied, skippedProposals: inlineSkips });
      appliedProposalCount += applied.length;
      skippedProposalCount += inlineSkips.length;
    }
    if (written || inlineMutated) mutatedNoteCount += 1;
  }
  if (consumed.size > 0) {
    await storage.writeLedgerText(JSON.stringify(journal.filter((entry) => !consumed.has(entry))));
  }
  return { notes, appliedProposalCount, skippedProposalCount, mutatedNoteCount };
}

// Drop entries older than the retention window; zero retention keeps everything.
export async function pruneLedgerEntries(
  storage: LedgerStoragePort,
  retentionDays: number,
  timestamp: number,
): Promise<number> {
  if (retentionDays <= 0) return 0; // keep-all default: there is no git to fall back on, so nothing is dropped
  const journal = await readJournal(storage);
  const cutoff = timestamp - retentionDays * DAY_MS;
  const keep = journal.filter((entry) => entry.timestamp >= cutoff); // exactly-at-cutoff survives
  const removedCount = journal.length - keep.length;
  if (removedCount > 0) await storage.writeLedgerText(JSON.stringify(keep)); // only rewrite when the journal actually shrank
  return removedCount;
}
