// =============================================================================
// TAGGING PROPOSAL — the concept-tag pipeline's shared vocabulary.
//
// Every area of the pipeline — detectors, taxonomy, apply-wiring, insights —
// imports its types and tag-path helpers from this file and nowhere else, so a
// proposal written by one stage is readable by every later one. The module is
// pure: it imports nothing, so anything can depend on it without pulling in
// Obsidian, the store or the fs.
// =============================================================================

export type ProposalKind = "taxonomy" | "placement" | "normalization" | "propagation";

export interface TagRewriteProposal {
  kind: ProposalKind;
  notePath: string;      // one proposal per note
  tagPath: string;       // PascalCase segments joined by "/", e.g. "MachineLearning/NeuralNetworks"
  replacesTag?: string;  // set for placement/normalization: the exact existing tag string being replaced
  confidence: number;    // 0..1
  evidence: string;      // one-line receipt, e.g. "17 of 20 nearest neighbours carry this concept"
}

export interface TaxonomyNode {
  level: number;      // number of segments: 1..3 in this release
  segments: string[]; // PascalCase, root-to-node; segments.length === level
  notePaths: string[];// notes assigned to this node, sorted by note path
}

export interface TaxonomyResult {
  nodes: TaxonomyNode[];              // every created node, depth-first, siblings in name order
  leafAssignment: Map<string, string>;// every input note path -> deepest node's tag path
}

// The only way a tag path string is formed from segments — the single normalization point.
export function joinSegments(segments: string[]): string {
  if (segments.length === 0) throw new TypeError("tag path needs at least one segment");
  for (const s of segments) {
    if (s === "") throw new TypeError("tag path segments must be non-empty");
  }
  return segments.join("/");
}

// Strict descendant over tag path strings: the trailing "/" is what makes "AB" not a
// descendant of "A", and a path can never start with itself plus "/", so it is strict.
export function isDescendantOf(child: string, ancestor: string): boolean {
  return child.startsWith(`${ancestor}/`);
}
