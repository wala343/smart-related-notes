// Unit tests for the insights bridge: offline, synthetic, pure.
import { test } from "node:test";
import assert from "node:assert/strict";
// Node's transform-types needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else;
// a type-only import is erased, so it needs no ".ts" pin of its own.
import type { TagRewriteProposal } from "./proposal";
// @ts-expect-error
import { renderProposalSection, renderTaxonomySection } from "./insights-bridge.ts";

// Four proposals, deliberately unsorted across all three sort keys (note path, tag
// path, replacesTag), with a "|" in one evidence string and rounding on every percent.
const pB: TagRewriteProposal = {
  kind: "taxonomy", notePath: "notes/b.md", tagPath: "Zeta",
  confidence: 0.5, evidence: "half of the vault agrees",
};
const pABetaOld: TagRewriteProposal = {
  kind: "placement", notePath: "notes/a.md", tagPath: "Beta", replacesTag: "Old",
  confidence: 0.856, evidence: "kept",
};
const pAAlpha: TagRewriteProposal = {
  kind: "taxonomy", notePath: "notes/a.md", tagPath: "Alpha",
  confidence: 0.9, evidence: "no old tag, a fresh placement",
};
const pABetaNew: TagRewriteProposal = {
  kind: "normalization", notePath: "notes/a.md", tagPath: "Beta", replacesTag: "New",
  confidence: 0.125, evidence: "1 of 2 | tied",
};

void test("proposal section: exact callout header with count, sorted rows, table, trailing blank", () => {
  const proposals = [pB, pABetaOld, pAAlpha, pABetaNew];
  assert.deepEqual(renderProposalSection(proposals), [
    "> [!tip]+ Concept tag proposals (4)",
    "> Concept-tag additions apply through the tagging commands; replacements apply only after you select them in the review modal.",
    "> ",
    "> | Note | Tag | Replaces | Confidence | Evidence |",
    "> |---|---|---|---|---|",
    "> | [[notes/a]] | `Alpha` | - | 90% | no old tag, a fresh placement |",
    "> | [[notes/a]] | `Beta` | `New` | 13% | 1 of 2 \\| tied |", // "|" escaped; 0.125 -> 13
    "> | [[notes/a]] | `Beta` | `Old` | 86% | kept |", // 0.856 -> 86
    "> | [[notes/b]] | `Zeta` | - | 50% | half of the vault agrees |",
    "",
  ]);
  // The caller's array is not reordered by the sort.
  assert.deepEqual(proposals, [pB, pABetaOld, pAAlpha, pABetaNew]);
});

void test("proposal section: no proposals yields no lines, never a (0) heading", () => {
  assert.deepEqual(renderProposalSection([]), []);
});

void test("taxonomy section: closed info callout, every given line prefixed verbatim", () => {
  assert.deepEqual(renderTaxonomySection([
    "## Concept taxonomy preview",
    "", // a blank given line becomes "> ", still prefixed
    "- **MachineLearning** — 3 notes",
  ]), [
    "> [!info]- Concept taxonomy",
    "> ## Concept taxonomy preview",
    "> ",
    "> - **MachineLearning** — 3 notes",
    "",
  ]);
});

void test("taxonomy section: no preview lines yields no lines", () => {
  assert.deepEqual(renderTaxonomySection([]), []);
});
