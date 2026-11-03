// =============================================================================
// TAXONOMY REPORT — the concept hierarchy as markdown lines for the insights report.
//
// One pure function over a TaxonomyResult: no vectors, no store, no Obsidian, no
// randomness. The insights area embeds the lines it gets back verbatim, so the
// format is a public contract — indent comes from node.level (never from implied
// nesting in the array), and the node/note ordering is order 0002's, consumed as
// given rather than recomputed here.
// =============================================================================

import type { TaxonomyResult } from "./proposal";

export const PREVIEW_REPRESENTATIVES = 3; // max representative notes shown per node

const HEADING = "## Concept taxonomy preview";

// note title (derived): basename with its extension stripped, "ML/Backprop.md" -> "Backprop".
function noteTitle(notePath: string): string {
  const base = notePath.slice(notePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base; // dot <= 0 means no extension, or a dotfile name
}

export function renderTaxonomyPreview(taxonomy: TaxonomyResult): string[] {
  if (taxonomy.nodes.length === 0) return [HEADING, "- (no clusters found)"];
  const lines: string[] = [HEADING];
  for (const node of taxonomy.nodes) {
    const indent = " ".repeat(2 * (node.level - 1)); // two spaces per level above 1
    lines.push(`${indent}- **${node.segments.join("/")}** — ${node.notePaths.length} notes`);
    for (const notePath of node.notePaths.slice(0, PREVIEW_REPRESENTATIVES)) {
      lines.push(`${indent}  - ${noteTitle(notePath)}`); // representatives: the first of the sorted paths
    }
  }
  return lines;
}
