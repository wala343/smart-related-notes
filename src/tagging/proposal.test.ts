// Unit tests for the concept-tag pipeline's shared vocabulary: offline, synthetic, pure.
import { test } from "node:test";
import assert from "node:assert/strict";
// Node's type stripping needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else.
// @ts-expect-error
import { type ProposalKind, type TagRewriteProposal, type TaxonomyNode, type TaxonomyResult, joinSegments, isDescendantOf } from "./proposal.ts";

// Type-level import test: every declared type compiles with a well-formed value.
const kind: ProposalKind = "taxonomy";
const proposal: TagRewriteProposal = {
  kind,
  notePath: "notes/ml.md",
  tagPath: "MachineLearning/NeuralNetworks",
  confidence: 0.85,
  evidence: "17 of 20 nearest neighbours carry this concept",
};
const proposalWithReplacement: TagRewriteProposal = {
  ...proposal,
  kind: "placement",
  replacesTag: "OldTag", // optional field, set for placement/normalization
};
const node: TaxonomyNode = {
  level: 2, // two segments -> level 2
  segments: ["MachineLearning", "NeuralNetworks"],
  notePaths: ["notes/ml.md"],
};
const result: TaxonomyResult = {
  nodes: [node],
  leafAssignment: new Map([["notes/ml.md", "MachineLearning/NeuralNetworks"]]),
};

// void: node:test registration promises are deliberately un-awaited — the runner schedules them, nothing to handle here.
void test("declared types compile and compose", () => {
  assert.equal(proposal.kind, "taxonomy");
  assert.equal(proposalWithReplacement.replacesTag, "OldTag");
  assert.equal(node.segments.length, node.level);
  assert.equal(result.leafAssignment.get("notes/ml.md"), joinSegments(node.segments));
});

void test("joinSegments joins with '/'", () => {
  assert.equal(joinSegments(["MachineLearning"]), "MachineLearning");
  assert.equal(joinSegments(["MachineLearning", "NeuralNetworks"]), "MachineLearning/NeuralNetworks");
  assert.equal(joinSegments(["A", "B", "C"]), "A/B/C");
});

void test("joinSegments throws TypeError on an empty array", () => {
  assert.throws(() => joinSegments([]), TypeError);
});

void test("joinSegments throws TypeError on an empty segment", () => {
  assert.throws(() => joinSegments([""]), TypeError);
  assert.throws(() => joinSegments(["A", ""]), TypeError);
  assert.throws(() => joinSegments(["", "B"]), TypeError);
});

void test("isDescendantOf is true across a segment boundary", () => {
  assert.equal(isDescendantOf("A/B", "A"), true);
  assert.equal(isDescendantOf("A/B/C", "A/B"), true);
  assert.equal(isDescendantOf("A/B/C", "A"), true);
});

void test("isDescendantOf is false for the path itself (strict)", () => {
  assert.equal(isDescendantOf("A", "A"), false);
  assert.equal(isDescendantOf("A/B", "A/B"), false);
});

void test("isDescendantOf respects segment boundaries", () => {
  assert.equal(isDescendantOf("AB", "A"), false);
  assert.equal(isDescendantOf("ABC/D", "A"), false);
});

void test("isDescendantOf is false for unrelated paths", () => {
  assert.equal(isDescendantOf("B/C", "A/B"), false);
  assert.equal(isDescendantOf("MachineLearning", "Biology"), false);
});
