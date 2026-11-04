// =============================================================================
// PANEL DATA — the pure core of the sidebar panel's concept-tag mode.
//
// The apply path dedupes a proposal against the note's already-carried tags only
// at apply time, so a panel that re-assembles proposals on every render would
// re-list rows for tags the note already carries. This module performs that drop
// up front and groups the survivors per note for display: no Obsidian, no store,
// no clock, no fs — the carried tags come in through the caller's lookup.
// =============================================================================

import type { TagRewriteProposal } from "./proposal";
import { cleanTag } from "./detectors";

export interface PanelProposalGroup { notePath: string; proposals: TagRewriteProposal[] }

export interface TagPanelData {
  forNote: PanelProposalGroup | null;  // the active note's group; null when activeNotePath is null
  vault: PanelProposalGroup[];         // one group per note with at least one surviving row, notePath ascending
}

// Plain-string order, not localeCompare: the order must not depend on the machine's locale.
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The tag domain's comparison form — the canonical form the detectors key their inventory by.
const canonicalTag = (tag: string): string => cleanTag(tag).toLowerCase();

// A proposal adds a tag rather than renaming one: no effective replacesTag (absent, or
// whitespace only) means nothing is being replaced, so the carried-tag drop applies to it.
const isAdditive = (proposal: TagRewriteProposal): boolean =>
  proposal.replacesTag === undefined || proposal.replacesTag.trim() === "";

// carriedTagsFor returns the note's exact carried tags (leading '#' allowed) and must answer
// every distinct notePath appearing in proposals; an unknown note may yield [].
export function tagPanelData(
  activeNotePath: string | null,
  proposals: TagRewriteProposal[],
  carriedTagsFor: (notePath: string) => string[],
): TagPanelData {
  const canonicalCarriedByNote = new Map<string, Set<string>>();
  const rowsByNote = new Map<string, TagRewriteProposal[]>(); // each group keeps its proposals' input order
  for (const proposal of proposals) {
    let carried = canonicalCarriedByNote.get(proposal.notePath);
    if (carried === undefined) {
      carried = new Set(carriedTagsFor(proposal.notePath).map(canonicalTag));
      canonicalCarriedByNote.set(proposal.notePath, carried);
    }
    if (isAdditive(proposal) && carried.has(canonicalTag(proposal.tagPath))) continue;
    const rows = rowsByNote.get(proposal.notePath);
    if (rows === undefined) rowsByNote.set(proposal.notePath, [proposal]);
    else rows.push(proposal);
  }
  const vault = [...rowsByNote]
    .map(([notePath, proposalsForNote]) => ({ notePath, proposals: proposalsForNote }))
    .sort((a, b) => byString(a.notePath, b.notePath));
  // The active note is a vault row like any other: forNote is the same group object, not a copy.
  const forNote = activeNotePath === null ? null
    : vault.find((group) => group.notePath === activeNotePath) ?? null;
  return { forNote, vault };
}
