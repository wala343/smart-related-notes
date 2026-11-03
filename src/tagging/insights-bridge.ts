// =============================================================================
// INSIGHTS BRIDGE — the concept-tag pipeline's two sections of the vault insights note.
//
// Two pure functions from data to callout lines: no Obsidian, no DOM, no fs, no
// clock. They mirror the section emitters in src/main.ts renderInsights by hand —
// that file is not importable from here — so the insights callout shape (
// "> [!kind]+/- Title" with a "> " prefix on every body line, blank ones included)
// is the only styling vocabulary this unit knows.
// =============================================================================

import type { TagRewriteProposal } from "./proposal";

// The insights note's wikilink form: path with the trailing .md stripped. Identical to
// renderInsights' own local helper, kept local there on purpose — not a shared term.
const wl = (p: string): string => `[[${p.replace(/\.md$/i, "")}]]`;

// The one markdown safety rule here: a "|" inside cell content is escaped so a
// proposal's evidence cannot break the table; nothing else is escaped.
const cell = (s: string): string => s.replace(/\|/g, "\\|");

// Plain-string order, not localeCompare: the sort must be deterministic per machine.
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The pending-proposals section as an open "tip" callout (actionable and short) whose
// title counts its rows. [] when there are none — the caller decides whether the
// section appears at all; this never renders a "(0)" heading.
export function renderProposalSection(proposals: TagRewriteProposal[]): string[] {
  if (proposals.length === 0) return [];
  const head = ["Note", "Tag", "Replaces", "Confidence", "Evidence"];
  // Copy before sorting: the caller's array keeps its order. Absent replacesTag sorts
  // as "", so replacements of the same tag path land in a fixed, readable order.
  const rows = [...proposals]
    .sort((a, b) =>
      cmp(a.notePath, b.notePath) ||
      cmp(a.tagPath, b.tagPath) ||
      cmp(a.replacesTag ?? "", b.replacesTag ?? ""),
    )
    .map((p) => [
      wl(cell(p.notePath)),
      `\`${cell(p.tagPath)}\``,
      p.replacesTag === undefined ? "-" : `\`${cell(p.replacesTag)}\``,
      `${Math.round(p.confidence * 100)}%`, // integer percent, rounded
      cell(p.evidence),
    ]);
  const body = [
    "Concept-tag additions apply through the tagging commands; replacements apply only after you select them in the review modal.",
    "",
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
  return [
    `> [!tip]+ Concept tag proposals (${proposals.length})`,
    ...body.map((line) => `> ${line}`),
    "",
  ];
}

// The taxonomy section: the taxonomy area's preview lines wrapped verbatim in a closed
// "info" callout — long-form reference material, so it starts folded like every
// non-actionable section of the insights note. [] when there is nothing to show.
export function renderTaxonomySection(taxonomyPreviewLines: string[]): string[] {
  if (taxonomyPreviewLines.length === 0) return [];
  return [
    "> [!info]- Concept taxonomy",
    ...taxonomyPreviewLines.map((line) => `> ${line}`),
    "",
  ];
}
