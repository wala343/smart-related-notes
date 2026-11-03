// Unit tests for the taxonomy builder: offline, synthetic, pure. Vectors are
// generated here with a fixed PRNG — no network, no vault or lab data.
import { test } from "node:test";
import assert from "node:assert/strict";
// Node's transform-types needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else.
// @ts-expect-error
import { joinSegments } from "./proposal.ts";
// @ts-expect-error
import { buildTaxonomy, type TaxonomyInputNote, type TextProvider } from "./taxonomy.ts";

// Same deterministic PRNG as the module (kept under the same name run-wide).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  return rng() + rng() + rng() - 1.5; // Gaussian-ish, no library
}

interface Fixture {
  notes: TaxonomyInputNote[];
  textOf: TextProvider;
  bodies: Map<string, string>;
}

// Three well-separated topic groups in 12 dims; each group = two tight
// sub-blobs, each sub-blob four notes. Every group has its own vocabulary,
// served by the textOf stub; titles carry the group word only.
const DIMS = 12;

function blobNote(rng: () => number, path: string, title: string, axis: number, perp: number): TaxonomyInputNote {
  const vec = new Float32Array(DIMS);
  for (let d = 0; d < DIMS; d++) vec[d] = gauss(rng) * 0.15;
  vec[axis] += 1;
  vec[perp] += 0.7; // sub-blob sits ~35deg off the group axis, jitter ~8deg -> very tight
  let s = 0;
  for (const x of vec) s += x * x;
  s = Math.sqrt(s) || 1;
  for (let d = 0; d < DIMS; d++) vec[d] /= s;
  return { path, title, vec };
}

function hierarchicalFixture(): Fixture {
  const rng = mulberry32(7);
  const groups = [
    { prefix: "q", key: "Quantum", axis: 0, subs: [
      { perp: 1, body: "tunneling tunneling tunneling barrier quantum" },
      { perp: 2, body: "entangle entangle entangle qubit quantum" },
    ] },
    { prefix: "n", key: "Neural", axis: 3, subs: [
      { perp: 4, body: "gradient gradient gradient weight neural" },
      { perp: 5, body: "backprop backprop backprop loss neural" },
    ] },
    { prefix: "p", key: "Pasta", axis: 6, subs: [
      { perp: 7, body: "basil basil basil garlic pasta" },
      { perp: 8, body: "parmesan parmesan parmesan fennel pasta" },
    ] },
  ];
  const notes: TaxonomyInputNote[] = [];
  const bodies = new Map<string, string>();
  for (const g of groups) {
    g.subs.forEach((sub, si) => {
      for (let j = 1; j <= 4; j++) {
        const path = `notes/${g.prefix}${si + 1}-${j}.md`; // q1-* = sub-blob 1, q2-* = sub-blob 2
        const title = `${g.key} 2026 Note ${j}`; // "2026" must never name a cluster; "Note" is stopped
        notes.push(blobNote(rng, path, title, g.axis, sub.perp));
        bodies.set(path, sub.body);
      }
    });
  }
  return { notes, textOf: (path) => bodies.get(path) ?? "", bodies };
}

// No structure at all: six directions, two notes each, heavy jitter.
function uniformFixture(): Fixture {
  const rng = mulberry32(11);
  const notes: TaxonomyInputNote[] = [];
  for (let a = 0; a < 6; a++) {
    for (let k = 0; k < 2; k++) {
      const vec = new Float32Array(DIMS);
      for (let d = 0; d < DIMS; d++) vec[d] = gauss(rng) * 0.5;
      vec[a] += 1;
      let s = 0;
      for (const x of vec) s += x * x;
      s = Math.sqrt(s) || 1;
      for (let d = 0; d < DIMS; d++) vec[d] /= s;
      notes.push({ path: `notes/s${a}${k}.md`, title: `Scatter 2026 Note ${a}${k}`, vec });
    }
  }
  return { notes, textOf: () => "", bodies: new Map() };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const MAIN_OPTS = { minSubClusterSize: 4 }; // 8-note groups: k=3 tops and 2 children per group only fit minSubClusterSize <= 4

// void: node:test registration promises are deliberately un-awaited — the runner schedules them, nothing to handle here.
void test("three topic groups become three PascalCase top-level nodes with real children", () => {
  const fx = hierarchicalFixture();
  const res = buildTaxonomy(fx.notes, fx.textOf, MAIN_OPTS);

  const paths = res.nodes.map((n) => joinSegments(n.segments));
  assert.deepEqual(paths, [
    "NeuralGradient", "NeuralGradient/BackpropNeural", "NeuralGradient/GradientNeural",
    "PastaBasil", "PastaBasil/BasilPasta", "PastaBasil/ParmesanPasta",
    "QuantumTunneling", "QuantumTunneling/EntangleQuantum", "QuantumTunneling/TunnelingQuantum",
  ]); // depth-first, siblings in segment order, group words + dominant sub-terms

  for (const n of res.nodes) {
    assert.equal(n.level, n.segments.length);
    assert.ok(n.segments.every((s) => /^[A-Za-z0-9]+$/.test(s)));
    assert.deepEqual(n.notePaths, [...n.notePaths].sort());
  }

  // Every input note lands in leafAssignment exactly once, under its deepest node.
  assert.equal(res.leafAssignment.size, fx.notes.length);
  const nodePaths = new Set(paths);
  for (const n of fx.notes) {
    const leaf = res.leafAssignment.get(n.path);
    assert.ok(leaf && nodePaths.has(leaf), `${n.path} unassigned`);
  }
  const q1 = res.leafAssignment.get("notes/q1-1.md");
  assert.ok(q1 && q1 !== "QuantumTunneling"); // the sub-blob note sits below its group
  assert.equal(res.leafAssignment.get("notes/q1-1.md"), res.leafAssignment.get("notes/q1-4.md"));
});

void test("a shuffled input permutation yields an identical taxonomy", () => {
  const fx = hierarchicalFixture();
  const a = buildTaxonomy(fx.notes, fx.textOf, MAIN_OPTS);
  const b = buildTaxonomy(shuffle(fx.notes, mulberry32(99)), fx.textOf, MAIN_OPTS);
  assert.deepEqual(b, a);
});

void test("a uniform scatter never grows level-2 nodes", () => {
  const fx = uniformFixture();
  const res = buildTaxonomy(fx.notes, fx.textOf); // default options
  assert.ok(res.nodes.length >= 1);
  assert.ok(res.nodes.every((n) => n.level === 1)); // child k is clamped under 2, so descent stops
  assert.equal(res.leafAssignment.size, fx.notes.length);
});

void test("minSubClusterSize above the group size stops descent", () => {
  const fx = hierarchicalFixture();
  const res = buildTaxonomy(fx.notes, fx.textOf, { minSubClusterSize: 13 }); // > 8-note groups
  assert.ok(res.nodes.length >= 1);
  assert.ok(res.nodes.every((n) => n.level === 1));
  assert.equal(res.leafAssignment.size, fx.notes.length);
});

void test("the cohesion gate alone rejects a split the size gate admits", () => {
  const fx = hierarchicalFixture();
  // minSubClusterSize 4 admits the 4-note sub-blobs (the run that grows level-2
  // below); cohesionGain 2 is unreachable — mean cosines lie in [-1, 1], so the
  // meanCos(child) - meanCos(parent) >= cohesionGain criterion alone blocks descent.
  const res = buildTaxonomy(fx.notes, fx.textOf, { minSubClusterSize: 4, cohesionGain: 2 });
  assert.ok(res.nodes.length >= 1);
  assert.ok(res.nodes.every((n) => n.level === 1));
  assert.equal(res.leafAssignment.size, fx.notes.length);
});

void test("short and empty inputs return the empty result", () => {
  const empty = { nodes: [], leafAssignment: new Map<string, string>() };
  const fx = hierarchicalFixture();
  assert.deepEqual(buildTaxonomy([], () => ""), empty);
  assert.deepEqual(buildTaxonomy(fx.notes.slice(0, 2), fx.textOf, MAIN_OPTS), empty);
});

void test("an empty-string text provider still names nodes from titles", () => {
  const fx = hierarchicalFixture();
  const noBodies: TextProvider = () => "";
  const a = buildTaxonomy(fx.notes, noBodies, MAIN_OPTS);
  const b = buildTaxonomy(shuffle(fx.notes, mulberry32(5)), noBodies, MAIN_OPTS);
  assert.equal(a.nodes.filter((n) => n.level === 1).length, 3);
  assert.equal(a.leafAssignment.size, fx.notes.length);
  assert.deepEqual(b, a);
});
