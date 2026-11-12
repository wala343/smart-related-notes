// Dominant-word regression: does a corpus-dominant word leak into every taxonomy
// segment name? Corpus: 3 topical groups + the word "vector" sprinkled into
// every body (the lab-vault "Vektor" shape). Prints every node's full tag path.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { buildTaxonomy } from "../src/tagging/taxonomy.ts";

// Close any cooperative-yield ports so the Node test runner can exit.
const yieldChannels = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() {
    super();
    yieldChannels.push(this);
  }
};
after(() => {
  for (const channel of yieldChannels) {
    channel.port1.close();
    channel.port2.close();
  }
});

const DIMS = 32;
const rnd = (() => { let a = 7; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();

function unit(r) {
  const v = new Float32Array(DIMS);
  let s = 0;
  for (let i = 0; i < DIMS; i++) { v[i] = r() * 2 - 1; s += v[i] * v[i]; }
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < DIMS; i++) v[i] /= n;
  return v;
}

const GROUPS = [
  { topic: "bayes probability posterior prior likelihood evidence inference", axis: 0 },
  { topic: "database index btree query transaction btree concurrency", axis: 1 },
  { topic: "chapter narrative plot character scene dialogue manuscript", axis: 2 },
];

const notes = [];
// centre per group on its own basis axis pair so k-means finds three clusters
for (let g = 0; g < GROUPS.length; g++) {
  const centre = unit(rnd);
  centre[GROUPS[g].axis] += 3; // strong on its axis
  const n0 = Math.sqrt(centre.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < DIMS; i++) centre[i] /= n0;
  for (let i = 0; i < 8; i++) {
    const v = unit(rnd);
    // dominant cluster signal + noise + a touch of "vector" in EVERY body:
    for (let d = 0; d < DIMS; d++) v[d] = centre[d] * 0.95 + v[d] * 0.31;
    const words = GROUPS[g].topic.split(" ");
    const body = [];
    // real-prose shape: each topic word ONCE per note…
    for (const w of words) body.push(w);
    // …plus neutral filler (next group's words, so no other term dominates)…
    const filler = GROUPS[(g + 1) % 3].topic.split(" ");
    for (let w = 0; w < 60; w++) body.push(filler[w % filler.length]);
    // …and the vault-dominant word said 12 times in every single note:
    for (let v = 0; v < 12; v++) body.push("vector");
    notes.push({
      path: `vault/${g}${i}.md`,
      title: `note ${g}-${i}`,
      vec: v,
      text: `note ${g}-${i} ` + body.join(" "),
    });
  }
}

// buildTaxonomy signature: (input, textOf, options); TaxonomyInputNote has
// {path,title,vec} and text is fetched via the provider.
const texts = new Map(notes.map((n) => [n.path, n.text]));
const taxonomy = buildTaxonomy(
  notes.map(({ path, title, vec }) => ({ path, title, vec })),
  (p) => texts.get(p) ?? "",
  { minSubClusterSize: 5, minChildren: 2, cohesionGain: 0.05, termsPerSegment: 2 },
);

console.log(`nodes: ${taxonomy.nodes.length}`);
const uniq = new Map();
for (const [p, leaf] of taxonomy.leafAssignment) uniq.set(leaf, (uniq.get(leaf) ?? 0) + 1);
for (const [leaf, count] of [...uniq].sort()) console.log(`  ${count.toFixed().padStart(2)} notes -> #${leaf}`);

test("dominant vocabulary is absent from every segment, with three distinct topical names", () => {
  for (const node of taxonomy.nodes) {
    for (const segment of node.segments) {
      assert.ok(!segment.toLowerCase().includes("vector"), `dominant word leaked into ${segment}`);
    }
  }
  assert.deepEqual(taxonomy.nodes.map((node) => node.segments.join("/")), [
    "BayesProbability", "BtreeDatabase", "ChapterNarrative",
  ]);
  assert.ok(taxonomy.nodes.every((node) => node.notePaths.length === 8));
  assert.equal(taxonomy.leafAssignment.size, notes.length);
});

test("dominant-word corpus is byte-identical under input permutations", () => {
  const expected = JSON.stringify({ nodes: taxonomy.nodes, leaves: [...taxonomy.leafAssignment] });
  for (let offset = 0; offset < notes.length; offset++) {
    const permuted = [...notes.slice(offset), ...notes.slice(0, offset)].reverse();
    const result = buildTaxonomy(permuted, (p) => texts.get(p) ?? "", {
      minSubClusterSize: 5, minChildren: 2, cohesionGain: 0.05, termsPerSegment: 2,
    });
    assert.equal(JSON.stringify({ nodes: result.nodes, leaves: [...result.leafAssignment] }), expected);
  }
});
