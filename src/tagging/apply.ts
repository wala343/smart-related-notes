// =============================================================================
// TAGGING APPLY — the concept-tag pipeline's mutation core.
//
// One pure function turns the pipeline's shared currency (TagRewriteProposal
// from proposal.ts) into frontmatter writes: proposed tag paths merge into the
// note's existing `tags:` block list, and the call returns a per-note receipt
// of what landed and what skipped, with reasons. The module performs no I/O of
// its own — every read and write of note storage goes through the injected
// ApplyFrontmatterPort, so tests run on synthetic in-memory ports and the
// Obsidian adapter stays a trivial shell. Vault reality governs the channel:
// tags are a YAML block list under `tags:`, inline `#tags` are never written
// by us, and every other frontmatter key belongs to the port, not to us.
//
// With the optional ApplySideChannels, replacements target BOTH channels and
// writes are journalled ahead: per note every deferred replacement is planned
// as ONE whole-content batch, journalNoteWrite persists durably before the
// note's first mutation, and the batch commits to the body BEFORE the tags
// write — the flip is structural: a whole-content batch embeds the pre-apply
// frontmatter, so an after-tags body commit would erase the tags edit, while
// processFrontMatter re-reads the file and preserves the just-written body.
// The core still emits no inline text itself — the injected inline channel
// performs the surgery. Without side channels the behavior is the accepted
// frontmatter-only core, byte for byte.
// =============================================================================

import type { InlineEditRecord, InlineRewriteBatch } from "./inline-rewrite";
import type { ProposalKind, TagRewriteProposal } from "./proposal";
// Value imports need the ".ts" specifier for Node's runtime (the test chain has
// no extension resolution); the expect-error pins the one tsc complaint.
// @ts-expect-error
import { cleanTag } from "./detectors.ts";

// The only storage seam. readNoteTags returns null when the note has no `tags:`
// frontmatter key ([] means the key exists and is empty). writeNoteTags replaces
// the `tags:` block-list value with the given array, creates the key only when
// absent, and leaves every other frontmatter key untouched (port invariant).
export interface ApplyFrontmatterPort {
  readNoteTags(notePath: string): Promise<string[] | null>;
  writeNoteTags(notePath: string, tags: string[]): Promise<void>;
}

// The machine word for why a proposal did not land.
export type ApplySkipReason =
  | "already-present"        // dedupe in the pinned comparison form matched an existing tag
  | "duplicate-proposal"     // same note + tag path proposed again in this call
  | "replacement-not-found"  // replacesTag matched no exact frontmatter tag and no batch group
  | "malformed-proposal"     // tag path empty after trimming
  | "note-unavailable"       // the port threw or could not resolve the note
  | "journal-unavailable"    // the write-ahead journal call threw; zero mutation for the note
  | "content-drift"          // the note-level plan vetoed, or the body commit revalidated as drifted; the batched replacements are vetoed
  | "inline-unavailable";    // the body-commit call threw; the applied entries stand, revert recovers

export interface AppliedProposal {
  kind: ProposalKind;
  tagPath: string;             // trimmed proposed tag path
  replacesTag: string | null;  // trimmed replacesTag, null when absent
  addedTags: string[];         // exact existing-tag forms appended (replace: the new form)
  removedTags: string[];       // exact existing-tag forms displaced (replace only)
  inlineEdits?: InlineEditRecord[]; // the replacement's final-frame group from the note's batch (only with side channels); [] = none found
}

export interface ApplyNoteOutput {
  notePath: string;
  tagsBefore: string[];    // [] when the note had no tags key
  tagsAfter: string[];     // [] when nothing was written
  appliedProposals: AppliedProposal[];
  skippedProposals: { tagPath: string; reason: ApplySkipReason }[];
}

export interface ApplyResult {
  notes: ApplyNoteOutput[];  // one per note facing at least one proposal, in first-proposal order
  appliedProposalCount: number;
  skippedProposalCount: number;
  mutatedNoteCount: number;  // notes whose writeNoteTags was actually invoked
}

// Write-ahead and inline surgery for approved rewrites. EVERY member is optional
// and guarded individually: a member absent ⇒ its behavior equals the accepted
// no-side-channel behavior for that concern. A present journalNoteWrite carries
// the write-ahead invariant with no inline member anywhere — the shape the idle
// additive port supplies (journal, no inline channel, no replacements).
export interface ApplySideChannels {
  // Plan, do NOT mutate: ONE revalidated document batch for ALL of the note's
  // approved replacements, in approval order (editGroups[i] belongs to
  // requests[i]). null = revalidation failed, the whole batch is vetoed.
  planNoteRewrites?(notePath: string, requests: { replacesTag: string; tagPath: string }[]): Promise<InlineRewriteBatch | null>;
  // Durable write-ahead: persist the note's journal entries BEFORE any mutation
  // of the note. A throw vetoes the note entirely (journal-unavailable applies;
  // zero writes either channel).
  journalNoteWrite?(note: ApplyNoteOutput): Promise<void>;
  // Commit the note's planned batch: revalidate `source` against a fresh read
  // BEFORE writing ("drifted" — nothing written), else write atomically
  // ("committed"). Keyed retrieval per notePath is the implementation's concern.
  commitNoteRewrite?(notePath: string): Promise<"committed" | "drifted">;
}

// The bare case fold behind the duplicate-proposal claim and the replacement
// suppression checks (pinned 0009/0019): those stay exactly as they are. The
// already-present skip compares in the tag domain's pinned form below instead.
const fold = (s: string): string => s.toLowerCase();

// The tag domain's pinned comparison form (order 0005) — the identical rule the
// panel-data dedupe compares by: cleanTag precedes the case fold, so a carried
// City//, #City, or City/ is the same tag as City in the already-present skip.
const canonicalTag = (s: string): string => cleanTag(s).toLowerCase();

// The only entry point: group proposals per note (notes come out in the order
// each first faces a proposal), process them in call order against a per-note
// working list so later proposals see earlier ones' effect, then write each
// note at most once, only when something applied.
export async function applyTagProposals(
  proposals: TagRewriteProposal[],
  frontmatter: ApplyFrontmatterPort,
  sideChannels?: ApplySideChannels,
): Promise<ApplyResult> {
  const grouped = new Map<string, TagRewriteProposal[]>();
  for (const p of proposals) {
    const group = grouped.get(p.notePath);
    if (group === undefined) grouped.set(p.notePath, [p]);
    else group.push(p);
  }

  const notes: ApplyNoteOutput[] = [];
  let appliedProposalCount = 0;
  let skippedProposalCount = 0;
  let mutatedNoteCount = 0;
  for (const [notePath, group] of grouped) {
    const { output, mutated } = await applyToNote(notePath, group, frontmatter, sideChannels);
    notes.push(output);
    appliedProposalCount += output.appliedProposals.length;
    skippedProposalCount += output.skippedProposals.length;
    if (mutated) mutatedNoteCount += 1;
  }
  return { notes, appliedProposalCount, skippedProposalCount, mutatedNoteCount };
}

// A failed planNoteRewrites call cannot revalidate the spans: the same veto as a
// null plan. Contained here so the caller narrows null without a try of its own.
async function planNoteBatch(
  sideChannels: ApplySideChannels | undefined,
  notePath: string,
  requests: { replacesTag: string; tagPath: string }[],
): Promise<InlineRewriteBatch | null> {
  try {
    return (await sideChannels?.planNoteRewrites?.(notePath, requests)) ?? null;
  } catch {
    return null;
  }
}

// Everything applyTagProposals does for one note. `mutated` stays out of the
// public output because a throw's note must count as unmutated — the flag says
// the write went through, not merely that it was attempted.
async function applyToNote(
  notePath: string,
  group: TagRewriteProposal[],
  frontmatter: ApplyFrontmatterPort,
  sideChannels?: ApplySideChannels,
): Promise<{ output: ApplyNoteOutput; mutated: boolean }> {
  const skipped: { tagPath: string; reason: ApplySkipReason }[] = [];
  const applied: AppliedProposal[] = [];

  // A read failure is caught per note: every proposal skips note-unavailable,
  // nothing rethrows. Receipts carry the trimmed tag path ("" when malformed).
  let before: string[];
  try {
    before = (await frontmatter.readNoteTags(notePath)) ?? [];
  } catch {
    for (const p of group) skipped.push({ tagPath: p.tagPath.trim(), reason: "note-unavailable" });
    return { output: { notePath, tagsBefore: [], tagsAfter: [], appliedProposals: [], skippedProposals: skipped }, mutated: false };
  }

  // The working list is a copy — tagsBefore hands back the port's own array
  // untouched, so the merge must never mutate the value the read returned.
  let tags = [...before];
  const claimed = new Set<string>(); // tag paths (folded) this note has faced in this call
  // With an inline channel, replacement proposals wait here instead of
  // displacing at once: the note's WHOLE batch is planned once after the loop,
  // so per-replacement plans built from one pre-apply body cannot erase each
  // other on a whole-body commit.
  const bucket: { kind: ProposalKind; tagPath: string; replacesTag: string; key: string }[] = [];
  const hasInlineChannel = sideChannels?.planNoteRewrites !== undefined;

  for (const p of group) {
    const tagPath = p.tagPath.trim();
    if (tagPath === "") {
      skipped.push({ tagPath, reason: "malformed-proposal" });
      continue;
    }
    const key = fold(tagPath);
    // Same note, same path, whatever the kinds or replacesTag values: the
    // later proposal skips. (A malformed path claims nothing, so it can never
    // cast a later empty path as its duplicate.)
    if (claimed.has(key)) {
      skipped.push({ tagPath, reason: "duplicate-proposal" });
      continue;
    }
    claimed.add(key);
    // The same trim (and empty-check) applies to replacesTag; empty is absent.
    const replacesTag = p.replacesTag === undefined ? null : p.replacesTag.trim();

    if (replacesTag === null || replacesTag === "") {
      // Append-only merge: existing tags keep their order and exact forms, and
      // the EXISTING form wins a match in the pinned comparison form — never
      // rewritten. Additives are never deferred: they apply at once.
      const canonicalKey = canonicalTag(tagPath);
      if (tags.some((t) => canonicalTag(t) === canonicalKey)) {
        skipped.push({ tagPath, reason: "already-present" });
        continue;
      }
      tags.push(tagPath);
      applied.push({ kind: p.kind, tagPath, replacesTag: null, addedTags: [tagPath], removedTags: [] });
      continue;
    }

    if (!hasInlineChannel) {
      // No inline channel to consult: the accepted frontmatter-only
      // replacement, byte for byte.
      const removedTags = tags.filter((t) => t === replacesTag);
      if (removedTags.length === 0) {
        // Nothing matched the exact replacesTag: no partial write.
        skipped.push({ tagPath, reason: "replacement-not-found" });
        continue;
      }
      // Displace every exact occurrence, then append — unless the path now
      // matches a REMAINING tag case-insensitively, where the removals still
      // land and only the append is suppressed (the remaining form wins).
      tags = tags.filter((t) => t !== replacesTag);
      const suppressed = tags.some((t) => fold(t) === key);
      if (!suppressed) tags.push(tagPath);
      applied.push({ kind: p.kind, tagPath, replacesTag, addedTags: suppressed ? [] : [tagPath], removedTags });
      continue;
    }

    bucket.push({ kind: p.kind, tagPath, replacesTag, key });
  }

  // One note-level batch merges the whole bucket into the working list. A null
  // batch vetoes EVERY bucketed replacement as content-drift — nothing is
  // displaced, nothing is written for them, the additives stand.
  let batch: InlineRewriteBatch | undefined; // set only when a non-null batch exists
  const fromBatch: AppliedProposal[] = []; // applied receipts whose inline part rides the batch
  if (bucket.length > 0) {
    const planned = await planNoteBatch(sideChannels, notePath, bucket.map((b) => ({ replacesTag: b.replacesTag, tagPath: b.tagPath })));
    if (planned === null) {
      for (const b of bucket) skipped.push({ tagPath: b.tagPath, reason: "content-drift" });
    } else {
      batch = planned;
      for (let i = 0; i < bucket.length; i++) {
        const b = bucket[i];
        const editGroup = planned.editGroups[i] ?? []; // groups are positional: editGroups[i] answers requests[i]
        const removedTags = tags.filter((t) => t === b.replacesTag);
        if (removedTags.length === 0) {
          if (editGroup.length === 0) {
            // Neither the frontmatter list nor the batch matched the exact
            // replacesTag: no partial write.
            skipped.push({ tagPath: b.tagPath, reason: "replacement-not-found" });
            continue;
          }
          // Replacement found only inline: the frontmatter list keeps
          // everything (nothing displaced, nothing appended) and the receipt
          // records the replacement through inlineEdits alone.
          const receipt: AppliedProposal = { kind: b.kind, tagPath: b.tagPath, replacesTag: b.replacesTag, addedTags: [], removedTags: [], inlineEdits: editGroup };
          applied.push(receipt);
          fromBatch.push(receipt);
          continue;
        }
        // The accepted displacement rules, at merge time: displace every exact
        // occurrence, append unless a REMAINING tag case-insensitively matches
        // the path (removals land, the remaining form wins). A frontmatter
        // match with an empty group proceeds frontmatter-only; a non-empty
        // group attaches its final-frame records.
        tags = tags.filter((t) => t !== b.replacesTag);
        const suppressed = tags.some((t) => fold(t) === b.key);
        if (!suppressed) tags.push(b.tagPath);
        const receipt: AppliedProposal = { kind: b.kind, tagPath: b.tagPath, replacesTag: b.replacesTag, addedTags: suppressed ? [] : [b.tagPath], removedTags, inlineEdits: editGroup };
        applied.push(receipt);
        fromBatch.push(receipt);
      }
    }
  }

  // A note whose proposals all skipped is never written, and nothing else
  // writes per note either — one writeNoteTags call, complete array, or none.
  if (applied.length === 0) {
    return { output: { notePath, tagsBefore: before, tagsAfter: [], appliedProposals: [], skippedProposals: skipped }, mutated: false };
  }
  // Total order per note: journalNoteWrite (durable, one write-ahead) →
  // commitNoteRewrite (atomic body write) → writeNoteTags (frontmatter).
  // Nothing mutates before the journal call returns. The commit/tags flip is
  // structural: the batch embeds the pre-apply frontmatter, so committing the
  // body after the tags write would erase the tags edit.
  if (sideChannels?.journalNoteWrite !== undefined) {
    try {
      // The journal sees the note's planned output; the skipped snapshot keeps
      // post-journal skip records out of the entry the caller builds from it.
      await sideChannels.journalNoteWrite({ notePath, tagsBefore: before, tagsAfter: tags, appliedProposals: applied, skippedProposals: [...skipped] });
    } catch {
      // A journal throw vetoes the note entirely: zero writes either channel.
      for (const a of applied) skipped.push({ tagPath: a.tagPath, reason: "journal-unavailable" });
      return { output: { notePath, tagsBefore: before, tagsAfter: [], appliedProposals: [], skippedProposals: skipped }, mutated: false };
    }
  }
  if (batch !== undefined && sideChannels?.commitNoteRewrite !== undefined) {
    try {
      if ((await sideChannels.commitNoteRewrite(notePath)) === "drifted") {
        // The fresh read no longer matches the planned source: nothing was
        // written. The bucketed replacements skip content-drift while the
        // journal keeps their planned records as pending truth; the tags
        // write still proceeds below.
        for (const a of fromBatch) skipped.push({ tagPath: a.tagPath, reason: "content-drift" });
      }
    } catch {
      // A throwing commit keeps the round-1 invariant-D shape: the applied
      // entries stand and the journaled inline records remain — the revert's
      // slice guards skip the never-committed inline parts.
      for (const a of fromBatch) skipped.push({ tagPath: a.tagPath, reason: "inline-unavailable" });
    }
  }
  try {
    await frontmatter.writeNoteTags(notePath, tags);
  } catch {
    // A write throw after a good read (or after a committed batch — the journal
    // already written truthfully describes the durable inline edits, and
    // revert restores them) re-records every applied-and-pending proposal of
    // this note as note-unavailable; the note stays unmutated. The journaled
    // entries stand as recoverable phantoms — the ledger's guards (0010)
    // neutralize them at revert.
    for (const a of applied) skipped.push({ tagPath: a.tagPath, reason: "note-unavailable" });
    return { output: { notePath, tagsBefore: before, tagsAfter: [], appliedProposals: [], skippedProposals: skipped }, mutated: false };
  }
  return { output: { notePath, tagsBefore: before, tagsAfter: tags, appliedProposals: applied, skippedProposals: skipped }, mutated: true };
}
