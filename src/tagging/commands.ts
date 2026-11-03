// =============================================================================
// TAGGING COMMANDS — the concept-tagging commands as pure functions.
//
// Apply, preview and revert are compositions of the apply core and the undo
// ledger, parameterized by one TaggingCommandPort carrying every effect:
// frontmatter access, ledger storage, the clock, the ledger retention and the
// taxonomy preview lines. Apply takes its proposals EXPLICITLY — the modal's
// selection or the additive-only idle list — and gathers nothing, so nothing
// can apply that was not passed in. Each function returns the user-facing
// notice text of its command, in the tone of the existing notices; the plugin
// entrypoint decides what a command does with the text. The module is pure:
// no Obsidian, DOM, fs, clock or store imports, and a port storage failure is
// never swallowed — it surfaces as the invariant notice text, never as a
// thrown failure.
// =============================================================================

import type { TagRewriteProposal } from "./proposal";
import type { ApplyFrontmatterPort, ApplyResult, ApplySideChannels } from "./apply";
import type { InlineRewriteAccess, InlineRewriteBatch } from "./inline-rewrite";
import type { LedgerStoragePort } from "./ledger";
// Value imports need the ".ts" specifier for Node's runtime (the test chain has
// no extension resolution); the expect-error pins the one tsc complaint.
// @ts-expect-error
import { applyTagProposals } from "./apply.ts";
// @ts-expect-error
import { appendLedgerEntries, journalEntriesForNote, nextBatchOrdinal, pruneLedgerEntries, revertAppliedChanges } from "./ledger.ts";
// @ts-expect-error
import { computeInlineRewriteBatch } from "./inline-rewrite.ts";

// THE SERIALIZED JOURNAL OPERATION QUEUE: one module-level promise chain
// through which the WHOLE mutating body of every applySelectedProposals
// invocation and every revertTagChanges run passes. A caller acquires at
// operation start — command time, when the approval modal has long closed:
// nothing is ever held across user interaction — and releases at completion
// or throw. Effects: journal appends and the batch-ordinal read-modify-write
// inside journalNoteWrite are fully serialized with each other and with
// reverts, and two concurrent invocations queue in start order, each seeing
// the other's persisted journal before allocating, so ordinals are dense and
// collision-free across invocations and after restart. Idle and manual
// invocations both take the same chain: no timeout, no reentrancy, no
// per-note locks beyond this single queue. Preview taxonomies are not
// mutations and never queue.
let journalOperations: Promise<void> = Promise.resolve();

function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
  const started = journalOperations.then(operation); // acquire: run only after the predecessor settled
  journalOperations = started.then(
    () => undefined,
    () => undefined,
  ); // release on completion OR throw: a settled chain never poisons the next caller's turn
  return started; // the caller still sees the operation's result or failure
}

/** The one object every command function takes: it supplies the frontmatter
 *  port, the ledger storage port, the clock, the ledger retention and the
 *  taxonomy preview lines. */
export interface TaggingCommandPort {
  frontmatter: ApplyFrontmatterPort;
  ledgerStorage: LedgerStoragePort;
  now(): number;                          // milliseconds; the caller injects Date.now()
  ledgerRetentionDays(): number;          // 0 keeps the whole journal (the default)
  taxonomyPreviewLines(): Promise<string[]>; // the taxonomy area's renderTaxonomyPreview output
  // Present = replacement proposals may also rewrite inline tags (approved path only).
  // Absent (the idle additive port) = no inline channel and no replacements by construction.
  inline?: InlineRewriteAccess;
}

function appliedNotice(result: ApplyResult): string {
  return `Concept tags: applied ${result.appliedProposalCount} proposals to ${result.mutatedNoteCount} notes, skipped ${result.skippedProposalCount}.`;
}

// Side channels built per invocation for EVERY port: the journal write-ahead
// persists each note's entries through the ledger's one durable append primitive
// (0010) and its throw must propagate — the core leaves that note untouched. The
// two inline members are added only when the port carries the inline channel;
// each note gets ONE session — a whole-document batch planned from a fresh read
// of ALL its requests at once, held keyed by notePath until the core commits it.
// (Round-1 per-replacement plans erased each other on whole-body commit; one
// batch per note makes every rewrite simultaneous and the journal truthful.)
function buildSideChannels(port: TaggingCommandPort): ApplySideChannels {
  const channels: ApplySideChannels = {
    journalNoteWrite: async (note) => {
      // Allocate this apply invocation's batch ordinal from the persisted
      // journal's current maximum (nextBatchOrdinal assigns max + 1 — never
      // from time) and append; the whole read-modify-write runs inside the
      // serialized operation queue, so it is race-free and restart-durable.
      const batch = nextBatchOrdinal(await port.ledgerStorage.readLedgerText());
      await appendLedgerEntries(journalEntriesForNote(note, port.now(), batch), port.ledgerStorage);
    },
  };
  const inline = port.inline;
  if (inline === undefined) return channels; // the idle additive port: write-ahead, no inline channel
  const sessions = new Map<string, InlineRewriteBatch>();
  return {
    ...channels,
    // Plan, do NOT mutate: the FIRST call for a note reads content + spans fresh
    // and folds every request it receives into one batch; any read failure or
    // stale span answers null and vetoes the note's replacements (content-drift).
    planNoteRewrites: async (notePath, requests) => {
      const held = sessions.get(notePath);
      if (held !== undefined) return held; // the core plans each note once per call; a repeat hits its session
      try {
        const content = await inline.readNoteContent(notePath);
        if (content === null) return null; // a missing note cannot be revalidated: veto
        const batch = computeInlineRewriteBatch(content, await inline.inlineTagSpans(notePath), requests);
        if (batch !== null) sessions.set(notePath, batch);
        return batch;
      } catch {
        return null;
      }
    },
    // Commit the note's session: the FRESH read must still equal batch.source —
    // otherwise nothing is written ("drifted"). A match writes the whole document
    // exactly once and ends the session; an unreachable note or failed write is
    // "drifted" too: with no written body, the core's drifted path is the truth.
    commitNoteRewrite: async (notePath) => {
      const batch = sessions.get(notePath);
      if (batch === undefined) return "drifted"; // no session: nothing was planned for this note
      try {
        const fresh = await inline.readNoteContent(notePath);
        if (fresh !== batch.source) return "drifted"; // the body moved since the plan: never mis-cut
        await inline.writeNoteContent(notePath, batch.content);
        sessions.delete(notePath); // a committed session is never committed twice
        return "committed";
      } catch {
        return "drifted";
      }
    },
  };
}

/** The ONLY apply entry point: applies EXACTLY the given proposals (the modal's
 *  selection, or the additive-only idle list) and journals them. Gathers
 *  nothing; nothing applies that is not passed in. A duplicate in the list is
 *  safe — the core's dedupe skips it. The per-note write-ahead journal stands on
 *  EVERY port (F3): a note whose journal write fails applies NOTHING and comes
 *  back as journal-unavailable skips inside the count notice. The whole
 *  mutating body acquires the serialized journal operation queue. */
export async function applySelectedProposals(port: TaggingCommandPort, proposals: TagRewriteProposal[]): Promise<string> {
  // An empty selection mutates nothing: no queue acquisition, no port touched.
  if (proposals.length === 0) return "Concept tags: no proposals selected.";
  return runSerialized(async () => {
    // Nothing to record after the apply: the per-note write-ahead already
    // journaled everything it let through — a post-apply pass would double-journal.
    const result = await applyTagProposals(proposals, port.frontmatter, buildSideChannels(port));
    return appliedNotice(result);
  });
}

/** Return the concept taxonomy preview as notice text. */
export async function previewTaxonomy(port: TaggingCommandPort): Promise<string> {
  const lines = await port.taxonomyPreviewLines();
  if (lines.length === 0) return "Concept taxonomy: nothing to preview.";
  return ["Preview the concept taxonomy", "", ...lines].join("\n");
}

/** Revert every journaled tag change (inline rewrites included when the port
 *  carries the inline channel), then prune per the retention window. The whole
 *  run acquires the serialized journal operation queue: it can never interleave
 *  with an apply or another revert. */
export function revertTagChanges(port: TaggingCommandPort): Promise<string> {
  return runSerialized(async () => {
    let reverted: ApplyResult;
    let pruned: number;
    try {
      reverted = await revertAppliedChanges(port.ledgerStorage, port.frontmatter, port.inline); // filter omitted = the whole journal
      pruned = await pruneLedgerEntries(port.ledgerStorage, port.ledgerRetentionDays(), port.now());
    } catch {
      return "Concept tags: the undo ledger could not be read.";
    }
    const notice =
      reverted.appliedProposalCount === 0
        ? "Concept tags: nothing to revert."
        : `Concept tags: reverted ${reverted.appliedProposalCount} changes across ${reverted.mutatedNoteCount} notes.`;
    return pruned > 0 ? `${notice} Pruned ${pruned} old ledger entries.` : notice;
  });
}

/** Keep only proposals that append — no effective replacesTag (order 0009's
 *  absent-form: undefined, or empty after trimming). The idle auto-apply's one
 *  narrowing rule: the wiring passes its output straight to
 *  applySelectedProposals, so additive-only is the list, not a flag. Pure:
 *  given order kept, no cloning beyond the filter. */
export function filterAdditiveProposals(proposals: TagRewriteProposal[]): TagRewriteProposal[] {
  return proposals.filter((p) => p.replacesTag === undefined || p.replacesTag.trim() === "");
}
