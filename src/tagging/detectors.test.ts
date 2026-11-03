// =============================================================================
// DETECTORS TESTS — the twelve pinned fixture scenes for the concept-tag
// pipeline's proposal generators. Offline, synthetic, pure: every fixture is a
// hand-built TaxonomyResult + TagInventory pair — no vault, no Obsidian, no
// network, no fs.
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
// The ".ts" specifiers are for node's transform-types. tsc (moduleResolution Bundler,
// no allowImportingTsExtensions) only charges ".ts" specifiers on value imports, so the
// two type-only imports below need no directive and the dynamic import gets one.
// Both are erased at runtime before any resolution happens.
import type { TagRewriteProposal, TaxonomyNode, TaxonomyResult } from "./proposal.ts";
import type { TagInventory, TagInventoryTag } from "./detectors.ts";

// detectors.ts imports "./proposal" extensionless, which node's ESM resolver never
// rewrites to ".ts" (proven: ERR_MODULE_NOT_FOUND). The in-file resolve hook proven
// by reader-candidates.test.ts maps exactly that specifier, so the pinned test
// command runs byte-exact and every fixture stays in this file.
const dataUrl = (src: string): string => "data:text/javascript," + encodeURIComponent(src);
register(
  dataUrl(
    "export async function resolve(specifier, context, next) {\n" +
      "  if (specifier === \"./proposal\") return next(\"./proposal.ts\", context);\n" +
      "  return next(specifier, context);\n" +
      "}\n",
  ),
  import.meta.url,
);
// @ts-expect-error — a value import (dynamic), so tsc does charge the ".ts" specifier here.
const { PLACEMENT_MIN_SHARE, cleanTag, detectPlacement, detectNormalization } = await import("./detectors.ts");

// One inventory tag over its carrying notes: each carrier is [note path, exact strings],
// listed ascending so notePaths matches the builder contract, and the Map key matches
// the declared canonical form, cleanTag(exact).toLowerCase().
const carrying = (canonical: string, carriers: Array<[string, string[]]>): TagInventoryTag => ({
  canonical,
  notePaths: carriers.map(([notePath]) => notePath),
  exactByNote: new Map(carriers),
});
const inventory = (...tags: TagInventoryTag[]): TagInventory => new Map(tags.map((t) => [t.canonical, t]));

// Fixture nodes are the shared taxonomy's shape; detectors read only segments/level and
// leafAssignment, so node.notePaths stays empty — nothing on either declared path reads it.
const node = (segments: string[]): TaxonomyNode => ({ level: segments.length, segments, notePaths: [] });

// The shared synthetic taxonomy: City (L1), Physics/MRI (L2), Physics/Quantum (L2),
// AngliRuskin/Year3 (L2), with leafAssignment covering every fixture note below.
const BASE_TAXONOMY: TaxonomyResult = {
  nodes: [node(["City"]), node(["Physics", "MRI"]), node(["Physics", "Quantum"]), node(["AngliRuskin", "Year3"])],
  leafAssignment: new Map<string, string>([
    ["notes/mri-1.md", "Physics/MRI"],
    ["notes/mri-2.md", "Physics/MRI"],
    ["notes/mri-3.md", "Physics/MRI"],
    ["notes/mri-4.md", "Physics/MRI"],
    ["notes/mri-5.md", "Physics/Quantum"], // the 5th mri carrier sits outside the node → share exactly 0.8
    ["notes/city-1.md", "City"],
    ["notes/city-2.md", "City"],
    ["notes/city-3.md", "City"],
    ["notes/q-1.md", "Physics/Quantum"],
    ["notes/q-2.md", "Physics/Quantum"],
    ["notes/q-3.md", "Physics/MRI"],
    ["notes/q-4.md", "Physics/MRI"],
    ["notes/q-5.md", "Physics/MRI"],
    ["notes/qs-a.md", "Physics/Quantum"],
    ["notes/qs-b.md", "Physics/Quantum"],
    ["notes/qs-c.md", "Physics/Quantum"],
    ["notes/qs-d.md", "Physics/MRI"], // 3-of-4 quantum cluster → share exactly 0.75
    ["notes/year3-a.md", "AngliRuskin/Year3"],
    ["notes/year3-b.md", "AngliRuskin/Year3"],
    ["notes/year3-c.md", "AngliRuskin/Year3"],
    ["notes/year3-d.md", "AngliRuskin/Year3"],
    ["notes/mri-duo.md", "Physics/MRI"],
    ["notes/pm-1.md", "Physics/MRI"],
    ["notes/pq-1.md", "Physics/Quantum"],
  ]),
};

// Scenes 1/9/11: "mri" carried on 5 notes, 4 assigned to Physics/MRI (share exactly 0.8).
const MRI_TAG = carrying("mri", [
  ["notes/mri-1.md", ["MRI"]],
  ["notes/mri-2.md", ["MRI"]],
  ["notes/mri-3.md", ["MRI"]],
  ["notes/mri-4.md", ["MRI"]],
  ["notes/mri-5.md", ["MRI"]],
]);
const MRI_INVENTORY = inventory(MRI_TAG);

// Scene 2: exact "city" collides case-insensitively with node City; city-2 repeats the
// exact string to prove proposals come once per (note, exact string), not per occurrence.
const CITY_INVENTORY = inventory(
  carrying("city", [
    ["notes/city-1.md", ["city"]],
    ["notes/city-2.md", ["city", "city"]],
    ["notes/city-3.md", ["City"]], // already exact-cased: gets nothing
  ]),
);

// Scene 5: one tag entry — the builder keys by canonical, and the exact nested string and
// its case-mangled twin share canonical "angliruskin/year3".
const YEAR3_INVENTORY = inventory(
  carrying("angliruskin/year3", [
    ["notes/year3-a.md", ["AngliRuskin/Year3"]],
    ["notes/year3-b.md", ["AngliRuskin/Year3"]],
    ["notes/year3-c.md", ["angliRuskin/year3"]], // the case-mangled twin
    ["notes/year3-d.md", ["angliRuskin/year3"]],
  ]),
);

// Scene 6, without the naming nodes: nothing for the cleaned strings to collide with.
const NO_NODE_TAXONOMY: TaxonomyResult = {
  nodes: [node(["City"])],
  leafAssignment: new Map([["notes/pharm-1.md", "City"], ["notes/phys-1.md", "City"]]),
};
// Scene 6, with the naming nodes present: the same mangles become collisions.
const NAMING_TAXONOMY: TaxonomyResult = {
  nodes: [node(["Pharmacology"]), node(["Physics", "MRI"])],
  leafAssignment: new Map<string, string>([
    ["notes/pharm-2.md", "Pharmacology"],
    ["notes/pharm-3.md", "Pharmacology"],
    ["notes/phys-2.md", "Physics/MRI"],
    ["notes/phys-3.md", "Physics/MRI"],
  ]),
};
const MANGLE_NO_NODE = inventory(
  carrying("pharmacology", [["notes/pharm-1.md", ["Pharmacology/"]]]),
  carrying("physics/mri", [["notes/phys-1.md", ["Physics//MRI"]]]),
);
// Each mangled spelling shares one tag entry with its already-exact twin (same canonical):
// the twins must stay untouched while the mangles collide-rename.
const MANGLE_WITH_NODE = inventory(
  carrying("pharmacology", [["notes/pharm-2.md", ["Pharmacology/"]], ["notes/pharm-3.md", ["Pharmacology"]]]),
  carrying("physics/mri", [["notes/phys-2.md", ["Physics//MRI"]], ["notes/phys-3.md", ["Physics/MRI"]]]),
);

// Scene 9's combined fixture: inventory insertion order (year3, mri, city) is deliberately
// NOT sorted by note path, so the pinned output order is a real assertion, not an accident.
const COMBINED_INVENTORY = inventory(
  carrying("angliruskin/year3", [
    ["notes/year3-c.md", ["angliRuskin/year3"]],
    ["notes/year3-d.md", ["angliRuskin/year3"]],
  ]),
  MRI_TAG,
  carrying("city", [
    ["notes/city-1.md", ["city"]],
    ["notes/city-2.md", ["city"]],
    ["notes/city-3.md", ["City"]],
  ]),
);

// The pinned order rendered as one "notePath replacesTag" line per proposal, so a
// misordering reads clearly when it fails.
const pinnedOrder = (proposals: TagRewriteProposal[]): string =>
  proposals.map((p) => `${p.notePath} ${p.replacesTag}`).join("\n");

await test("placement fires at exactly 0.8 cluster share, one proposal per carrying note", () => {
  const proposals = detectPlacement(BASE_TAXONOMY, MRI_INVENTORY);
  assert.equal(proposals.length, 5); // every carrier gets the proposal, not only the clustered 4
  proposals.forEach((p, i) => {
    assert.equal(p.kind, "placement");
    assert.equal(p.notePath, `notes/mri-${i + 1}.md`); // ascending by notePath
    assert.equal(p.tagPath, "Physics/MRI");
    assert.equal(p.replacesTag, "MRI"); // the exact string, casing as carried
    assert.equal(p.confidence, 0.8); // share exactly 0.8, ≥ threshold fires
    assert.equal(p.evidence, "carried on 4 of 5 notes assigned to Physics/MRI"); // full pinned receipt
  });
  assert.deepEqual(detectNormalization(BASE_TAXONOMY, MRI_INVENTORY), []); // "MRI" is well-formed: normalization silent
});

await test("normalization renames case-colliding tags to the node's exact casing, once per note and exact string", () => {
  const proposals = detectNormalization(BASE_TAXONOMY, CITY_INVENTORY);
  assert.equal(proposals.length, 2); // city-1 and city-2; the repeated "city" and the exact "City" add none
  proposals.forEach((p, i) => {
    assert.equal(p.kind, "normalization");
    assert.equal(p.notePath, `notes/city-${i + 1}.md`);
    assert.equal(p.tagPath, "City"); // the taxonomy's PascalCase, not the carried casing
    assert.equal(p.replacesTag, "city");
    assert.equal(p.confidence, 1); // a pure rename is certain
    assert.equal(p.evidence, "case-insensitive collision with taxonomy node City");
  });
  assert.ok(!proposals.some((p) => p.notePath === "notes/city-3.md")); // the note already carrying exact "City" gets nothing
  assert.deepEqual(detectPlacement(BASE_TAXONOMY, CITY_INVENTORY), []); // a whole-node-path name is normalization's territory, never placement's
});

await test("a scattered tag at 0.4 share fires neither detector", () => {
  const scattered = inventory(
    carrying("quantum", [
      ["notes/q-1.md", ["quantum"]],
      ["notes/q-2.md", ["quantum"]],
      ["notes/q-3.md", ["quantum"]],
      ["notes/q-4.md", ["quantum"]],
      ["notes/q-5.md", ["quantum"]],
    ]),
  ); // 2 of 5 assigned to Physics/Quantum → share 0.4; "quantum" ≠ any whole node path; cleaned === exact
  assert.deepEqual(detectPlacement(BASE_TAXONOMY, scattered), []); // kinship yes, share no
  assert.deepEqual(detectNormalization(BASE_TAXONOMY, scattered), []); // no collision, no malformation
});

await test("placement stays silent at 0.75 share, below PLACEMENT_MIN_SHARE", () => {
  assert.equal(PLACEMENT_MIN_SHARE, 0.8); // the threshold fixture 1 meets exactly and this one misses
  const below = inventory(
    carrying("quantum", [
      ["notes/qs-a.md", ["quantum"]],
      ["notes/qs-b.md", ["quantum"]],
      ["notes/qs-c.md", ["quantum"]],
      ["notes/qs-d.md", ["quantum"]],
    ]),
  ); // 3 of 4 assigned to Physics/Quantum → share 0.75 < 0.8 → no fire
  assert.deepEqual(detectPlacement(BASE_TAXONOMY, below), []);
});

await test("already-nested AngliRuskin/Year3 is left alone; its case-mangled twin is renamed by normalization only", () => {
  assert.deepEqual(detectPlacement(BASE_TAXONOMY, YEAR3_INVENTORY), []); // canonical equals a node path: placement skips the tag entirely
  const proposals = detectNormalization(BASE_TAXONOMY, YEAR3_INVENTORY);
  assert.equal(proposals.length, 2); // only the twins; the exact node-path strings are skipped
  proposals.forEach((p, i) => {
    assert.equal(p.kind, "normalization");
    assert.equal(p.notePath, `notes/year3-${i === 0 ? "c" : "d"}.md`);
    assert.equal(p.tagPath, "AngliRuskin/Year3"); // the node's exact path, casing from the taxonomy
    assert.equal(p.replacesTag, "angliRuskin/year3");
    assert.equal(p.confidence, 1);
    assert.equal(p.evidence, "case-insensitive collision with taxonomy node AngliRuskin/Year3"); // collision wording, not separator wording
  });
});

await test("separator mangles normalize with and without the naming node", () => {
  const without = detectNormalization(NO_NODE_TAXONOMY, MANGLE_NO_NODE);
  assert.equal(without.length, 2);
  assert.equal(without[0].kind, "normalization");
  assert.equal(without[0].notePath, "notes/pharm-1.md");
  assert.equal(without[0].tagPath, "Pharmacology"); // cleaned form keeps the original segment casing
  assert.equal(without[0].replacesTag, "Pharmacology/");
  assert.equal(without[0].confidence, 1);
  assert.equal(without[0].evidence, "trailing separator removed"); // separator wording: no node to collide with
  assert.equal(without[1].notePath, "notes/phys-1.md");
  assert.equal(without[1].tagPath, "Physics/MRI"); // cleaned form, slash run collapsed
  assert.equal(without[1].replacesTag, "Physics//MRI");
  assert.equal(without[1].confidence, 1);
  assert.equal(without[1].evidence, "separator runs collapsed");
  assert.deepEqual(detectPlacement(NO_NODE_TAXONOMY, MANGLE_NO_NODE), []); // no name kinship to any node there

  const withNode = detectNormalization(NAMING_TAXONOMY, MANGLE_WITH_NODE);
  assert.equal(withNode.length, 2); // the exact twins "Pharmacology" and "Physics/MRI" are left completely alone
  assert.equal(withNode[0].kind, "normalization");
  assert.equal(withNode[0].notePath, "notes/pharm-2.md");
  assert.equal(withNode[0].tagPath, "Pharmacology"); // the node's exact path
  assert.equal(withNode[0].replacesTag, "Pharmacology/");
  assert.equal(withNode[0].confidence, 1);
  assert.equal(withNode[0].evidence, "case-insensitive collision with taxonomy node Pharmacology"); // collision wording once the node exists
  assert.equal(withNode[1].notePath, "notes/phys-2.md");
  assert.equal(withNode[1].tagPath, "Physics/MRI");
  assert.equal(withNode[1].replacesTag, "Physics//MRI"); // the mangled string, not the cleaned one, is replaced
  assert.equal(withNode[1].confidence, 1);
  assert.equal(withNode[1].evidence, "case-insensitive collision with taxonomy node Physics/MRI");
  assert.ok(!withNode.some((p) => p.notePath === "notes/pharm-3.md" || p.notePath === "notes/phys-3.md")); // exact node-path strings: zero proposals
  assert.deepEqual(detectPlacement(NAMING_TAXONOMY, MANGLE_WITH_NODE), []); // canonical collides with node paths: placement skips both tags
});

await test("tagPath always carries the taxonomy's PascalCase while comparison stays case-insensitive", () => {
  // Re-runs of the collision fixtures: the carried strings are lower-cased input, so any
  // output that leaked the comparison key's casing would show up right here.
  const scenes: Array<[string, TagRewriteProposal[]]> = [
    ["city collision", detectNormalization(BASE_TAXONOMY, CITY_INVENTORY)],
    ["year3 twin", detectNormalization(BASE_TAXONOMY, YEAR3_INVENTORY)],
    ["mangle collision", detectNormalization(NAMING_TAXONOMY, MANGLE_WITH_NODE)],
    ["mri placement", detectPlacement(BASE_TAXONOMY, MRI_INVENTORY)],
  ];
  for (const [scene, proposals] of scenes) {
    assert.ok(proposals.length > 0, scene); // each scene fires, so the casing claim rides on real proposals
    for (const p of proposals) {
      assert.notEqual(p.tagPath, p.tagPath.toLowerCase(), scene); // never the lower-cased comparison key
      assert.ok(
        p.tagPath === "City" || p.tagPath === "AngliRuskin/Year3" || p.tagPath === "Pharmacology" || p.tagPath === "Physics/MRI",
        `${scene}: ${p.tagPath}`,
      ); // exact-case PascalCase node path, byte for byte
    }
  }
});

await test("one proposal per exact string a note carries for the same canonical tag", () => {
  const duo = inventory(carrying("mri", [["notes/mri-duo.md", ["MRI", "mri"]]]));
  const proposals = detectPlacement(BASE_TAXONOMY, duo);
  assert.equal(proposals.length, 2); // two spellings, two proposals, one note
  assert.equal(proposals[0].notePath, "notes/mri-duo.md");
  assert.equal(proposals[0].kind, "placement");
  assert.equal(proposals[0].tagPath, "Physics/MRI");
  assert.equal(proposals[0].replacesTag, "MRI"); // sorted by replacesTag: uppercase "MRI" before "mri"
  assert.equal(proposals[0].confidence, 1); // share 1/1
  assert.equal(proposals[0].evidence, "carried on 1 of 1 notes assigned to Physics/MRI");
  assert.equal(proposals[1].notePath, "notes/mri-duo.md");
  assert.equal(proposals[1].replacesTag, "mri");
  assert.equal(proposals[1].tagPath, "Physics/MRI");
  assert.deepEqual(detectNormalization(BASE_TAXONOMY, duo), []); // both spellings are well-formed: normalization silent
});

await test("each detector run twice on the same inputs returns deeply equal arrays in the pinned order", () => {
  const placement1 = detectPlacement(BASE_TAXONOMY, COMBINED_INVENTORY);
  const placement2 = detectPlacement(BASE_TAXONOMY, COMBINED_INVENTORY);
  assert.deepEqual(placement2, placement1); // second run identical: the pure function consumed nothing
  assert.equal(
    pinnedOrder(placement1),
    [
      "notes/mri-1.md MRI",
      "notes/mri-2.md MRI",
      "notes/mri-3.md MRI",
      "notes/mri-4.md MRI",
      "notes/mri-5.md MRI",
    ].join("\n"),
  ); // notePath ascending despite the inventory's unsorted insertion order

  const normalization1 = detectNormalization(BASE_TAXONOMY, COMBINED_INVENTORY);
  const normalization2 = detectNormalization(BASE_TAXONOMY, COMBINED_INVENTORY);
  assert.deepEqual(normalization2, normalization1);
  assert.equal(
    pinnedOrder(normalization1),
    [
      "notes/city-1.md city",
      "notes/city-2.md city",
      "notes/year3-c.md angliRuskin/year3",
      "notes/year3-d.md angliRuskin/year3",
    ].join("\n"),
  ); // city before year3 proves the sort, not Map insertion order, fixes the sequence
});

await test("cleanTag strips one leading '#', collapses slash runs, trims a trailing slash, and never touches case", () => {
  assert.equal(cleanTag("#A//B/"), "A/B"); // all three rules at once
  assert.equal(cleanTag("A/B/"), "A/B"); // trailing slash trimmed
  assert.equal(cleanTag("A//B"), "A/B"); // double slash collapsed
  assert.equal(cleanTag("a/B"), "a/B"); // case passes through untouched
  assert.equal(cleanTag("#A"), "A"); // one leading # stripped
  assert.equal(cleanTag("A/B"), "A/B"); // a clean string is untouched
});

await test("a carrier absent from leafAssignment counts in the denominator only: 4/6 does not fire", () => {
  const six = inventory(
    carrying("mri", [
      ["notes/mri-1.md", ["MRI"]],
      ["notes/mri-2.md", ["MRI"]],
      ["notes/mri-3.md", ["MRI"]],
      ["notes/mri-4.md", ["MRI"]],
      ["notes/mri-5.md", ["MRI"]],
      ["notes/mri-6.md", ["MRI"]], // absent from leafAssignment: counted in 6, can never join the 4
    ]),
  );
  assert.ok(!BASE_TAXONOMY.leafAssignment.has("notes/mri-6.md")); // the fixture really is uncovered
  assert.deepEqual(detectPlacement(BASE_TAXONOMY, six), []); // 4/6 = 0.667 < 0.8: the scene-1 cluster no longer clears the bar
});

await test("no-op guard: an inventory already aligned with the taxonomy yields empty arrays from both detectors", () => {
  const aligned = inventory(
    carrying("city", [["notes/city-3.md", ["City"]]]),
    carrying("physics/mri", [["notes/pm-1.md", ["Physics/MRI"]]]),
    carrying("physics/quantum", [["notes/pq-1.md", ["Physics/Quantum"]]]),
    carrying("angliruskin/year3", [["notes/year3-a.md", ["AngliRuskin/Year3"]]]),
  ); // every exact string already equals its node path
  assert.deepEqual(detectPlacement(BASE_TAXONOMY, aligned), []);
  assert.deepEqual(detectNormalization(BASE_TAXONOMY, aligned), []);
});
