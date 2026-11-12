// Unit tests for the taxonomy builder: offline, synthetic, pure. Vectors are
// generated here with a fixed PRNG — no network, no vault or lab data.
import { test } from "node:test";
import assert from "node:assert/strict";
// Node's type stripping needs the ".ts" specifier; tsc flags it only because tsconfig (not ours to edit)
// omits allowImportingTsExtensions. The expect-error pins the one tsc complaint, nothing else.
// @ts-expect-error
import { joinSegments } from "./proposal.ts";
// @ts-expect-error
import { buildConceptMembershipIndex, buildTaxonomy, type TaxonomyInputNote, type TextProvider } from "./taxonomy.ts";

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

void test("evidence membership gives a bridge two concepts, a clear note one, and an outlier none", () => {
  const unit = (x: number, y: number, z = 0): Float32Array => {
    const length = Math.hypot(x, y, z) || 1;
    return new Float32Array([x / length, y / length, z / length]);
  };
  const notes: TaxonomyInputNote[] = [
    ...[1, 2, 3].map((n) => ({ path: `alpha-${n}.md`, title: "Alpha", vec: unit(1, 0) })),
    ...[1, 2, 3].map((n) => ({ path: `beta-${n}.md`, title: "Beta", vec: unit(0, 1) })),
    { path: "bridge.md", title: "Bridge", vec: unit(1, 1) },
    { path: "outlier.md", title: "Outlier", vec: unit(0, 0, 1) },
  ];
  const taxonomy = {
    nodes: [
      { level: 1, segments: ["Alpha"], notePaths: [] },
      { level: 2, segments: ["Alpha", "Specific"], notePaths: ["alpha-1.md", "alpha-2.md", "alpha-3.md", "bridge.md", "outlier.md"] },
      { level: 1, segments: ["Beta"], notePaths: ["beta-1.md", "beta-2.md", "beta-3.md"] },
    ],
    leafAssignment: new Map([
      ...[1, 2, 3].map((n) => [`alpha-${n}.md`, "Alpha/Specific"] as const),
      ["bridge.md", "Alpha/Specific"] as const,
      ["outlier.md", "Alpha/Specific"] as const,
      ...[1, 2, 3].map((n) => [`beta-${n}.md`, "Beta"] as const),
    ]),
  };
  const assignments = (input: TaxonomyInputNote[], path: string): string[] =>
    buildConceptMembershipIndex(taxonomy, input).membershipsFor(path).map((row) => row.tagPath);

  assert.deepEqual(assignments(notes, "bridge.md"), ["Alpha/Specific", "Beta"]);
  assert.deepEqual(assignments(notes, "alpha-1.md"), ["Alpha/Specific"]);
  assert.deepEqual(assignments(notes, "outlier.md"), []);
  assert.deepEqual(assignments(shuffle(notes, mulberry32(123)), "bridge.md"), ["Alpha/Specific", "Beta"]);
});

void test("concept names ignore inline and multiline display math while preserving prose", () => {
  const fx = hierarchicalFixture();
  // A single class makes this sensitive to math leakage despite the sibling vocabulary filter.
  const opts = { ...MAIN_OPTS, minSubClusterSize: 100 };
  const expected = buildTaxonomy(fx.notes, fx.textOf, opts);
  for (const math of [String.raw`$\vec{\gamma}$`, "$$\n" + String.raw`\vec{\gamma}` + "\n$$"]) {
    const noise = math.repeat(100);
    assert.deepEqual(buildTaxonomy(
      fx.notes.map((note) => ({ ...note, title: `${note.title}${noise}` })),
      (path) => `${noise}${fx.textOf(path)}${noise}`,
      opts,
    ), expected);
  }
  assert.deepEqual(buildTaxonomy(fx.notes, (path) => String.raw`\$` + fx.textOf(path) + String.raw`\$`, opts), expected);
});

// void: node:test registration promises are deliberately un-awaited — the runner schedules them, nothing to handle here.
void test("three topic groups become three PascalCase top-level nodes with real children", () => {
  const fx = hierarchicalFixture();
  const res = buildTaxonomy(fx.notes, fx.textOf, MAIN_OPTS);

  const paths = res.nodes.map((n) => joinSegments(n.segments));
  assert.deepEqual(paths, [
    "NeuralGradient", "NeuralGradient/BackpropLoss", "NeuralGradient/GradientWeight",
    "PastaBasil", "PastaBasil/BasilGarlic", "PastaBasil/ParmesanFennel",
    "QuantumTunneling", "QuantumTunneling/EntangleQubit", "QuantumTunneling/TunnelingBarrier",
  ]); // depth-first, siblings in segment order, children exclude vocabulary shared by all siblings

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

void test("a tokenless corpus abstains instead of inventing a Group concept", () => {
  const notes = [0, 1, 2].map((index) => ({
    path: `${index}.md`,
    title: "note",
    vec: new Float32Array([index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0]),
  }));
  assert.deepEqual(buildTaxonomy(notes, () => ""), { nodes: [], leafAssignment: new Map() });
});

void test("title-only leaves stay at named parents instead of Group fallback children", () => {
  const fx = hierarchicalFixture();
  const noBodies: TextProvider = () => "";
  const a = buildTaxonomy(fx.notes, noBodies, MAIN_OPTS);
  const b = buildTaxonomy(shuffle(fx.notes, mulberry32(5)), noBodies, MAIN_OPTS);
  assert.deepEqual(a.nodes.map((n) => joinSegments(n.segments)), ["Neural", "Pasta", "Quantum"]);
  assert.ok(a.nodes.every((n) => n.segments.every((s) => !/^Group\d+$/.test(s))));
  for (const note of fx.notes) {
    assert.equal(a.leafAssignment.get(note.path), note.title.split(" ")[0]);
  }
  assert.equal(a.leafAssignment.size, fx.notes.length);
  assert.deepEqual(b, a);
});

void test("a whole-vault node still names from term frequency when there are no siblings", () => {
  const fx = hierarchicalFixture();
  const res = buildTaxonomy(fx.notes, () => "vector vector vector calculus", { minSubClusterSize: 25 });
  assert.deepEqual(res.nodes.map((n) => n.segments), [["VectorCalculus"]]);
  assert.equal(res.leafAssignment.size, fx.notes.length);
});

void test("one nameable child cannot satisfy the two-child descent gate", () => {
  const fx = hierarchicalFixture();
  const textOf: TextProvider = (path) => path.includes("1-") ? "distinctive" : "";
  const res = buildTaxonomy(fx.notes, textOf, MAIN_OPTS);
  assert.deepEqual(res.nodes.map((n) => joinSegments(n.segments)), ["Neural", "Pasta", "Quantum"]);
  for (const note of fx.notes) {
    assert.equal(res.leafAssignment.get(note.path), note.title.split(" ")[0]);
  }
});

void test("unnameable root candidates retain their notes at a named whole-vault parent", () => {
  const fx = hierarchicalFixture();
  const notes = fx.notes.map((note) => ({ ...note, title: "note" }));
  const textOf: TextProvider = (path) => path.includes("/q") ? "shared" :
    path.includes("/n") ? "shared neural" : "shared pasta";
  const res = buildTaxonomy(notes, textOf, MAIN_OPTS);
  assert.equal(res.leafAssignment.size, notes.length);
  assert.ok(res.nodes.every((n) => n.segments.every((s) => !/^Group\d+$/.test(s))));
  const parent = res.nodes.find((n) => n.level === 1);
  assert.ok(parent);
  for (const note of notes.filter((n) => n.path.includes("/q"))) {
    assert.equal(res.leafAssignment.get(note.path), joinSegments(parent.segments));
  }
  assert.deepEqual(buildTaxonomy(shuffle(notes, mulberry32(5)), textOf, MAIN_OPTS), res);
});
