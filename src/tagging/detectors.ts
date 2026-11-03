// =============================================================================
// DETECTORS — the concept-tag pipeline's proposal generators over existing tags.
//
// Placement moves an existing tag whose carrying notes cluster inside one
// taxonomy node it is named after under that node (#mri → Physics/MRI);
// normalization renames a tag mangled in casing or separators to its
// segment-correct form (#city → City, #Pharmacology/ → Pharmacology). Both
// are pure functions over injected data — no Obsidian, no store, no clock,
// no fs — so every producer of proposals is testable offline with synthetic
// fixtures. The tag inventory is built by the wiring area, never here.
// =============================================================================

import type { TagRewriteProposal, TaxonomyNode, TaxonomyResult } from "./proposal";
import { joinSegments } from "./proposal";

// Manifest-pinned cluster-share threshold; placement fires only at share ≥ it.
export const PLACEMENT_MIN_SHARE = 0.8;

export interface TagInventoryTag {
  canonical: string;                  // cleanTag(exact).toLowerCase()
  notePaths: string[];                // every note carrying the tag, sorted by note path
  exactByNote: Map<string, string[]>; // note path -> the tag's exact strings on that note
}

// A snapshot of the vault's existing tags, keyed by each tag's canonical string.
export type TagInventory = Map<string, TagInventoryTag>;

// The only separator cleanup in the pipeline: strip one leading '#', collapse
// runs of '/' to a single '/', trim a trailing '/'. Case is untouched.
export function cleanTag(s: string): string {
  const noHash = s.startsWith("#") ? s.slice(1) : s;
  const collapsed = noHash.replace(/\/+/g, "/"); // one pass collapses every run
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

// A taxonomy node with its joined path and lower-case twin, computed once per call.
interface NodePath {
  node: TaxonomyNode;
  path: string;  // the node's joined path, PascalCase as declared
  lower: string; // path.toLowerCase() — the case-insensitive comparison key
}

function nodePathsOf(taxonomy: TaxonomyResult): NodePath[] {
  return taxonomy.nodes.map((node) => {
    const path = joinSegments(node.segments);
    return { node, path, lower: path.toLowerCase() };
  });
}

function leafSegment(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// Ascending by notePath, then replacesTag — pinned so output is caller-independent.
function sortProposals(proposals: TagRewriteProposal[]): TagRewriteProposal[] {
  const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return proposals.sort((a, b) =>
    byString(a.notePath, b.notePath) || byString(a.replacesTag ?? "", b.replacesTag ?? ""));
}

// The distinct exact strings one note carries for this tag, in builder order —
// so proposals come once per (note path, exact string) even if the builder repeated one.
function distinctExacts(tag: TagInventoryTag, notePath: string): string[] {
  return [...new Set(tag.exactByNote.get(notePath) ?? [])];
}

// An existing tag kin by name to a taxonomy node, whose carrying notes mostly sit
// inside that node, moves under it: "#mri" → Physics/MRI. Every carrying note gets
// the proposal — the consolidation applies to every carrier, not only the majority.
export function detectPlacement(
  taxonomy: TaxonomyResult,
  tagInventory: TagInventory,
): TagRewriteProposal[] {
  const paths = nodePathsOf(taxonomy);
  const proposals: TagRewriteProposal[] = [];
  for (const tag of tagInventory.values()) {
    if (tag.notePaths.length === 0) continue;
    // A tag naming a whole node path is a casing question — normalization's
    // territory, never placement's — so it is skipped entirely here.
    if (paths.some((np) => np.lower === tag.canonical)) continue;
    const leaf = leafSegment(tag.canonical); // canonical is already lower-case
    let best: NodePath | undefined;
    let bestMatched = 0;
    let bestShare = 0;
    for (const np of paths) {
      const finalSegment = np.node.segments[np.node.segments.length - 1];
      if (finalSegment.toLowerCase() !== leaf) continue; // name kinship on the leaf segment
      let matched = 0;
      for (const notePath of tag.notePaths) {
        const assigned = taxonomy.leafAssignment.get(notePath);
        if (assigned !== undefined && assigned.toLowerCase() === np.lower) matched += 1;
      }
      const share = matched / tag.notePaths.length;
      if (share < PLACEMENT_MIN_SHARE) continue;
      // Highest share wins; ties go to the deeper node; further ties keep the
      // first candidate found, which is nodes order — the earliest node.
      const better =
        !best || share > bestShare || (share === bestShare && np.node.level > best.node.level);
      if (better) {
        best = np;
        bestMatched = matched;
        bestShare = share;
      }
    }
    if (!best) continue;
    const confidence = Math.round(bestShare * 100) / 100; // share rounded to 2 decimals
    const evidence = `carried on ${bestMatched} of ${tag.notePaths.length} notes assigned to ${best.path}`;
    for (const notePath of tag.notePaths) {
      for (const exact of distinctExacts(tag, notePath)) {
        proposals.push({
          kind: "placement",
          notePath,
          tagPath: best.path,
          replacesTag: exact,
          confidence,
          evidence,
        });
      }
    }
  }
  return sortProposals(proposals);
}

// Names the separator rule that changed the exact string (case was left alone).
function separatorEvidence(exact: string, cleaned: string): string {
  const parts: string[] = [];
  if (exact.startsWith("#")) parts.push("leading # removed");
  if (/\/\//.test(exact)) parts.push("separator runs collapsed");
  if (exact.endsWith("/")) parts.push("trailing separator removed");
  return parts.join(", "); // non-empty whenever cleaned differs from exact
}

// A tag mangled in casing or separators is renamed to its segment-correct form:
// a case-insensitive collision with a taxonomy node adopts that node's exact
// joined path; otherwise the cleaned string keeps the original segment casing.
export function detectNormalization(
  taxonomy: TaxonomyResult,
  tagInventory: TagInventory,
): TagRewriteProposal[] {
  const paths = nodePathsOf(taxonomy);
  const proposals: TagRewriteProposal[] = [];
  for (const tag of tagInventory.values()) { // the inventory's insertion order is deterministic
    for (const notePath of tag.notePaths) {
      for (const exact of distinctExacts(tag, notePath)) {
        const cleaned = cleanTag(exact);
        const collision = paths.find((np) => np.lower === cleaned.toLowerCase()); // first in nodes order
        if (collision) {
          if (exact === collision.path) continue; // already nested: the exact string, not its cleaned form, is the node path
          proposals.push({
            kind: "normalization",
            notePath,
            tagPath: collision.path, // the taxonomy's PascalCase is preserved
            replacesTag: exact,
            confidence: 1, // a pure rename is certain
            evidence: `case-insensitive collision with taxonomy node ${collision.path}`,
          });
          continue;
        }
        if (cleaned === exact) continue; // no collision and no separator change — a no-op proposal
        proposals.push({
          kind: "normalization",
          notePath,
          tagPath: cleaned, // no taxonomy collision: original segment casing is preserved
          replacesTag: exact,
          confidence: 1,
          evidence: separatorEvidence(exact, cleaned),
        });
      }
    }
  }
  return sortProposals(proposals);
}
