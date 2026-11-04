// Unit tests for the panel's tag-mode data: offline, synthetic, pure — the carried tags come from a stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
// tsc (moduleResolution Bundler, no allowImportingTsExtensions) only charges ".ts" specifiers on value
// imports, so these type-only imports need no directive; both are erased before any resolution happens.
import type { PanelProposalGroup, TagPanelData } from "./panel-data.ts";
import type { ProposalKind, TagRewriteProposal } from "./proposal.ts";

// panel-data.ts imports "./detectors", which itself imports "./proposal"; node's ESM resolver never
// rewrites either extensionless specifier to ".ts" (proven: ERR_MODULE_NOT_FOUND), so the in-file
// resolve hook the house already pins in detectors.test.ts maps exactly those two specifiers here.
const dataUrl = (src: string): string => "data:text/javascript," + encodeURIComponent(src);
register(
  dataUrl(
    "export async function resolve(specifier, context, next) {\n" +
      "  if (specifier === \"./detectors\") return next(\"./detectors.ts\", context);\n" +
      "  if (specifier === \"./proposal\") return next(\"./proposal.ts\", context);\n" +
      "  return next(specifier, context);\n" +
      "}\n",
  ),
  import.meta.url,
);
// @ts-expect-error — a value import (dynamic), so tsc does charge the ".ts" specifier here.
const { tagPanelData } = await import("./panel-data.ts");

// Fixture proposal; replacesTag is set only where the kind's rule needs it.
function proposalOf(
  kind: ProposalKind,
  notePath: string,
  tagPath: string,
  replacesTag?: string,
): TagRewriteProposal {
  return { kind, notePath, tagPath, replacesTag, confidence: 0.9, evidence: "fixture" };
}

// A carried-tag lookup over a fixed note -> exact-strings table.
function carriedStub(table: Record<string, string[]>): (notePath: string) => string[] {
  // An unknown note yields [] per the declared contract.
  return (notePath: string) => table[notePath] ?? [];
}

const noCarriedTags = carriedStub({});

const pathsOf = (groups: PanelProposalGroup[]): string[] => groups.map((group) => group.notePath);

void test("empty proposals produce no group for the note and an empty vault", () => {
  for (const activeNotePath of [null, "notes/a.md"]) {
    const data: TagPanelData = tagPanelData(activeNotePath, [], noCarriedTags);
    assert.equal(data.forNote, null);
    assert.deepEqual(data.vault, []);
  }
});

void test("an additive taxonomy row is dropped when the note already carries the tag", () => {
  const carried = carriedStub({ "notes/a.md": ["MachineLearning/NeuralNetworks"] });
  const carriedRow = proposalOf("taxonomy", "notes/a.md", "MachineLearning/NeuralNetworks");
  const freshRow = proposalOf("taxonomy", "notes/a.md", "Physics/MRI");
  const data = tagPanelData(null, [carriedRow, freshRow], carried);
  assert.deepEqual(data.vault.map((group) => group.proposals), [[freshRow]]);
});

void test("the drop keys on replacesTag, not on kind", () => {
  const carried = carriedStub({ "notes/a.md": ["#physics/mri"] });
  // propagation is additive too, and a whitespace-only replacesTag is no replacement at all.
  const propagationRow = proposalOf("propagation", "notes/a.md", "Physics/MRI");
  const whitespaceRow = proposalOf("placement", "notes/a.md", "Physics/MRI", "   ");
  const data = tagPanelData("notes/a.md", [propagationRow, whitespaceRow], carried);
  assert.equal(data.forNote, null);
  assert.deepEqual(data.vault, []);
});

void test("the carried match ignores case and a leading '#' on either side", () => {
  const carried = carriedStub({
    "notes/a.md": ["#machinelearning/neuralnetworks"],
    "notes/b.md": ["Physics/MRI//"],
  });
  const data = tagPanelData(null, [
    proposalOf("taxonomy", "notes/a.md", "MachineLearning/NeuralNetworks"),
    proposalOf("taxonomy", "notes/b.md", "physics/mri/"),
  ], carried);
  assert.deepEqual(data.vault, []);
  // A carried tag that differs by more than casing is a different tag: it never drops.
  const other = tagPanelData(null, [proposalOf("taxonomy", "notes/a.md", "Physics/MRI")], carried);
  assert.deepEqual(other.vault.map((group) => group.proposals), [[proposalOf("taxonomy", "notes/a.md", "Physics/MRI")]]);
});

void test("placement and normalization survive even when their tag path is carried", () => {
  const carried = carriedStub({ "notes/a.md": ["#MachineLearning/NeuralNetworks", "City"] });
  const placement = proposalOf("placement", "notes/a.md", "MachineLearning/NeuralNetworks", "#mri");
  const normalization = proposalOf("normalization", "notes/a.md", "City", "#city");
  const data = tagPanelData("notes/a.md", [placement, normalization], carried);
  assert.deepEqual(data.forNote?.proposals, [placement, normalization]);
});

void test("the active note's group surfaces in forNote and in vault", () => {
  const activeRow = proposalOf("taxonomy", "notes/b.md", "Physics/MRI");
  const otherRow = proposalOf("taxonomy", "notes/a.md", "City");
  const data = tagPanelData("notes/b.md", [activeRow, otherRow], noCarriedTags);
  assert.deepEqual(pathsOf(data.vault), ["notes/a.md", "notes/b.md"]);
  // The panel renders forNote then the rest without special-casing duplicates, so it is one object.
  assert.equal(data.forNote, data.vault[1]);
  assert.equal(data.forNote?.notePath, "notes/b.md");
  assert.equal(data.forNote?.proposals[0], activeRow);
});

void test("forNote is null when there is no active note or the active note survives nothing", () => {
  const dropped = proposalOf("taxonomy", "notes/a.md", "City");
  const carried = carriedStub({ "notes/a.md": ["City"] });
  const withRows = tagPanelData(null, [proposalOf("taxonomy", "notes/b.md", "Physics/MRI")], carried);
  assert.equal(withRows.forNote, null);
  assert.deepEqual(pathsOf(withRows.vault), ["notes/b.md"]);
  const survivingNothing = tagPanelData("notes/a.md", [dropped], carried);
  assert.equal(survivingNothing.forNote, null);
  assert.deepEqual(survivingNothing.vault, []);
});

void test("vault groups sort by note path ascending without disturbing the caller's array", () => {
  const input = [
    proposalOf("taxonomy", "notes/c.md", "City"),
    proposalOf("taxonomy", "notes/a.md", "City"),
    proposalOf("taxonomy", "notes/b.md", "City"),
  ];
  const data = tagPanelData(null, input, noCarriedTags);
  assert.deepEqual(pathsOf(data.vault), ["notes/a.md", "notes/b.md", "notes/c.md"]);
  // Deterministic per machine: plain-string order, and the caller's input keeps its order.
  assert.deepEqual(pathsOf(tagPanelData(null, input, noCarriedTags).vault), pathsOf(data.vault));
  assert.deepEqual(input.map((proposal) => proposal.notePath), ["notes/c.md", "notes/a.md", "notes/b.md"]);
});

void test("a group keeps the input's emission order across interleaved notes", () => {
  const taxonomy = proposalOf("taxonomy", "notes/a.md", "Physics");
  const placement = proposalOf("placement", "notes/a.md", "Physics/MRI", "#mri");
  const normalization = proposalOf("normalization", "notes/a.md", "Physics/MRI/Mri", "Physics/MRI/mri");
  const propagation = proposalOf("propagation", "notes/a.md", "Physics/MRI/Mri");
  const interleaved = proposalOf("taxonomy", "notes/b.md", "City");
  const data = tagPanelData(null, [taxonomy, interleaved, placement, normalization, propagation], noCarriedTags);
  const groupForA = data.vault.find((group) => group.notePath === "notes/a.md");
  assert.deepEqual(groupForA?.proposals, [taxonomy, placement, normalization, propagation]);
});

void test("carriedTagsFor is consulted once per distinct note path", () => {
  const lookups: string[] = [];
  const carried = (notePath: string): string[] => {
    lookups.push(notePath);
    return ["City"];
  };
  const proposals = [
    proposalOf("taxonomy", "notes/a.md", "City"),
    proposalOf("placement", "notes/b.md", "Physics/MRI", "#mri"),
    proposalOf("taxonomy", "notes/a.md", "Physics/MRI"),
    proposalOf("propagation", "notes/a.md", "Physics"),
  ];
  const data = tagPanelData("notes/a.md", proposals, carried);
  assert.deepEqual(lookups.sort(), ["notes/a.md", "notes/b.md"]);
  assert.deepEqual(data.forNote?.proposals, [proposals[2], proposals[3]]);
});
