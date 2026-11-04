// Unit tests for the taxonomy preview lines: offline, synthetic, pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaxonomyResult } from "./proposal";
// Node's type stripping needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else;
// a type-only import is erased, so it needs no ".ts" pin of its own.
// @ts-expect-error
import { PREVIEW_REPRESENTATIVES, renderTaxonomyPreview } from "./taxonomy-report.ts";

// Three levels: indent steps, counts and derived representative titles, all in the pinned format.
const threeLevel: TaxonomyResult = {
  nodes: [
    { level: 1, segments: ["MachineLearning"], notePaths: ["ML/Backprop.md", "ML/Overview.md", "ML/Transformers.md"] },
    { level: 2, segments: ["MachineLearning", "NeuralNetworks"], notePaths: ["ML/Neural/Backprop.md"] },
    { level: 3, segments: ["MachineLearning", "NeuralNetworks", "Backprop"], notePaths: [] }, // zero notes: no representative lines
  ],
  leafAssignment: new Map(),
};

// void: node:test registration promises are deliberately un-awaited — the runner schedules them, nothing to handle here.
void test("a three-level taxonomy renders heading, indents, counts and representatives", () => {
  assert.deepEqual(renderTaxonomyPreview(threeLevel), [
    "## Concept taxonomy preview",
    "- **MachineLearning** — 3 notes",
    "  - Backprop",
    "  - Overview",
    "  - Transformers",
    "  - **MachineLearning/NeuralNetworks** — 1 notes",
    "    - Backprop",
    "    - **MachineLearning/NeuralNetworks/Backprop** — 0 notes",
  ]);
});

// More notes than the cap: every note is counted, only the first PREVIEW_REPRESENTATIVES are shown.
const manyNotes: TaxonomyResult = {
  nodes: [
    {
      level: 1,
      segments: ["Reading"],
      notePaths: ["Read/Alpha.md", "Read/Beta", "Read/Gamma Notes.v2.md", "Read/Delta.md", "Read/Epsilon.md"],
    },
  ],
  leafAssignment: new Map(),
};

void test("a node over the cap shows exactly PREVIEW_REPRESENTATIVES notes", () => {
  assert.equal(PREVIEW_REPRESENTATIVES, 3);
  const lines = renderTaxonomyPreview(manyNotes);
  assert.deepEqual(lines.slice(2), ["  - Alpha", "  - Beta", "  - Gamma Notes.v2"]); // no extension stays as-is; only the last one is stripped
  assert.equal(lines.filter((line) => line.startsWith("  - ")).length, PREVIEW_REPRESENTATIVES);
  assert.equal(lines[1], "- **Reading** — 5 notes");
});

void test("an empty taxonomy renders exactly the two pinned lines", () => {
  assert.deepEqual(renderTaxonomyPreview({ nodes: [], leafAssignment: new Map() }), [
    "## Concept taxonomy preview",
    "- (no clusters found)",
  ]);
});

// Level jumps in the array: indent comes from node.level, never from the neighbouring node.
const levelJumps: TaxonomyResult = {
  nodes: [
    { level: 1, segments: ["Biology"], notePaths: [] },
    { level: 3, segments: ["Biology", "Genetics", "CRISPR"], notePaths: ["Bio/Genetics/Crispr.md"] },
    { level: 2, segments: ["Chess", "Openings"], notePaths: ["Chess/Openings/Sicilian.md"] },
    { level: 1, segments: ["Chess"], notePaths: [] },
  ],
  leafAssignment: new Map(),
};

void test("indent derives from level even when the nodes array jumps levels", () => {
  assert.deepEqual(renderTaxonomyPreview(levelJumps), [
    "## Concept taxonomy preview",
    "- **Biology** — 0 notes",
    "    - **Biology/Genetics/CRISPR** — 1 notes",
    "      - Crispr",
    "  - **Chess/Openings** — 1 notes",
    "    - Sicilian",
    "- **Chess** — 0 notes",
  ]);
});
