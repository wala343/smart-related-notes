// =============================================================================
// TAXONOMY — the shared note pool as a hierarchy of named concept clusters.
//
// buildTaxonomy turns indexed note vectors plus an injected text provider into
// at most maxDepth (default 3) levels of concept nodes: spherical k-means over
// the centered whole pool first, then a node splits only where its children
// measure real — at least minSubClusterSize notes AND cohesionGain tighter
// than the parent. Each sibling set is named by c-TF-IDF over its members'
// titles and bodies. The module is pure: the caller builds the input and owns
// all text access; nothing here sees the store, the fs or Obsidian.
//
// Determinism is a hard invariant: the taxonomy is reused across reindexes, so
// any permutation of the caller's array must yield byte-identical output
// (IndexStore.vaultMapInput() iterates in insertion order, which is not
// stable). Hence the sort by path before anything else, and every random draw
// from a mulberry32 stream seeded off options.seed.
// =============================================================================

import type { TaxonomyNode, TaxonomyResult } from "./proposal";
// Value imports need the ".ts" specifier for Node's runtime (the test chain has
// no extension resolution); the expect-error pins the one tsc complaint.
// @ts-expect-error
import { joinSegments } from "./proposal.ts";

export interface TaxonomyInputNote {
  path: string;
  title: string;
  vec: Float32Array;
}

export type TextProvider = (path: string) => string;

export interface TaxonomyOptions {
  seed?: number;                // default 42
  maxDepth?: number;            // default 3; a tag path never exceeds this many segments
  minSubClusterSize?: number;   // default 5; a candidate child needs >= this many notes
  minChildren?: number;         // default 2; descend only when >= this many children are real
  cohesionGain?: number;        // default 0.05; child cohesion must beat parent cohesion by this
  termsPerSegment?: number;     // default 2; terms concatenated into one PascalCase segment
}

interface Ctx {
  maxDepth: number;
  minSubClusterSize: number;
  minChildren: number;
  cohesionGain: number;
  termsPerSegment: number;
  textOf: TextProvider;
  tokens: Map<string, string[]>; // corpus cache: note path -> its tokens
  nodes: TaxonomyNode[];
  leafAssignment: Map<string, string>;
}

interface Kid {
  seg: string;
  idxs: number[];
  seed: number;
}

// --- deterministic primitives: pattern copies of the published ones in
// --- src/vault-map.ts, kept local because vault-map privates must not be imported.

// Deterministic PRNG so the same pool grows the same taxonomy every time.
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

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function normalise(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(new ArrayBuffer(v.length * 4));
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

function allFinite(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

// Cluster count for n points: enough groups to be informative, few enough to
// be meaningful, clamped so every cluster can still hold minSubClusterSize notes.
function kRule(n: number, minSubClusterSize: number): number {
  return Math.max(1, Math.min(Math.max(3, Math.round(Math.sqrt(n / 2))), 16, Math.floor(n / minSubClusterSize), n));
}

// Spherical k-means with k-means++ seeding and a few restarts. Vectors are
// unit length, so cosine is a dot product and the centroid is the normalised sum.
function kmeans(vectors: Float32Array[], k: number, seed: number): number[] {
  const n = vectors.length;
  const dims = vectors[0].length;
  let best: { assign: number[]; inertia: number } | null = null;

  for (let restart = 0; restart < 3; restart++) {
    const rnd = mulberry32(seed + restart * 977);
    const centroids: Float32Array[] = [vectors[Math.floor(rnd() * n)]];
    while (centroids.length < k) {
      // k-means++: pick the next centre with probability proportional to its
      // distance from the nearest existing centre.
      const d2: number[] = [];
      let total = 0;
      for (const v of vectors) {
        let nearest = -1;
        for (const c of centroids) nearest = Math.max(nearest, dot(v, c));
        const d = Math.max(0, 1 - nearest);
        d2.push(d);
        total += d;
      }
      let pick = rnd() * total;
      let chosen = 0;
      for (; chosen < n - 1 && pick > d2[chosen]; chosen++) pick -= d2[chosen];
      centroids.push(vectors[chosen]);
    }

    const assign = new Array<number>(n).fill(0);
    for (let iter = 0; iter < 30; iter++) {
      let moved = 0;
      for (let i = 0; i < n; i++) {
        let bestC = 0;
        let bestS = -Infinity;
        for (let c = 0; c < k; c++) {
          const s = dot(vectors[i], centroids[c]);
          if (s > bestS) { bestS = s; bestC = c; }
        }
        if (assign[i] !== bestC) { assign[i] = bestC; moved++; }
      }
      for (let c = 0; c < k; c++) {
        const sum = new Float32Array(new ArrayBuffer(dims * 4));
        let count = 0;
        for (let i = 0; i < n; i++) {
          if (assign[i] !== c) continue;
          count++;
          for (let d = 0; d < dims; d++) sum[d] += vectors[i][d];
        }
        if (count > 0) centroids[c] = normalise(sum);
      }
      if (moved === 0) break;
    }
    let inertia = 0;
    for (let i = 0; i < n; i++) inertia += 1 - dot(vectors[i], centroids[assign[i]]);
    if (!best || inertia < best.inertia) best = { assign: assign.slice(), inertia };
  }
  return best ? best.assign : new Array<number>(n).fill(0);
}

// Mean cosine of the points to their own centroid (the normalised sum).
function meanCos(vs: Float32Array[]): number {
  const dims = vs[0].length;
  const sum = new Float32Array(new ArrayBuffer(dims * 4));
  for (const v of vs) for (let d = 0; d < dims; d++) sum[d] += v[d];
  const c = normalise(sum);
  let s = 0;
  for (const v of vs) s += dot(v, c);
  return s / vs.length;
}

// Points re-centered on their own mean and put back on the unit sphere.
function recenter(vs: Float32Array[]): Float32Array[] {
  const dims = vs[0].length;
  const mean = new Float32Array(new ArrayBuffer(dims * 4));
  for (const v of vs) for (let d = 0; d < dims; d++) mean[d] += v[d] / vs.length;
  return vs.map((v) => {
    const out = new Float32Array(new ArrayBuffer(dims * 4));
    for (let d = 0; d < dims; d++) out[d] = v[d] - mean[d];
    return normalise(out);
  });
}

// --- naming ---

// Words that carry no topic. The bilingual seed from vault-map, plus the
// fixture-proof generic words; the c-TF-IDF weighting suppresses the rest.
const LABEL_STOP = new Set(
  ("the a an of and or to in on for is are was with that this it as by from at note notes " +
    "der die das und oder ein eine in im auf mit von zu fuer ist sind war den dem "
    + "des als bei aus nach vor durch ueber um beim zur zum")
    .split(" "),
);

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || LABEL_STOP.has(raw)) continue;
    // Dated tokens (daily notes) would otherwise name a cluster "2026".
    if (!/\p{L}/u.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

function tokensOf(note: TaxonomyInputNote, ctx: Ctx): string[] {
  let toks = ctx.tokens.get(note.path);
  if (!toks) {
    toks = tokenize(`${note.title} ${ctx.textOf(note.path)}`); // corpus = title + " " + body
    ctx.tokens.set(note.path, toks);
  }
  return toks;
}

// c-TF-IDF: what makes each class distinct from its sibling classes (BERTopic's
// labelling trick, as vault-map uses it for cluster labels).
function labelClasses(classTokens: string[][]): string[][] {
  const classCount = classTokens.length;
  const docFreq = new Map<string, number>();
  for (const toks of classTokens) {
    for (const w of new Set(toks)) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  }
  return classTokens.map((toks) => {
    const counts = new Map<string, number>();
    for (const w of toks) counts.set(w, (counts.get(w) ?? 0) + 1);
    const total = Math.max(1, toks.length);
    const scored = [...counts.entries()].map(([w, n]) => ({
      w,
      score: (n / total) * Math.log(1 + classCount / (docFreq.get(w) ?? 1)),
    }));
    scored.sort((a, b) => b.score - a.score); // stable: ties keep first-seen order
    // MMR-lite: skip a term contained in one already picked, so a segment does
    // not read "regression regressions linear".
    const picked: string[] = [];
    for (const { w } of scored) {
      if (!picked.some((p) => p.startsWith(w) || w.startsWith(p))) picked.push(w);
    }
    return picked;
  });
}

// "neural networks" -> "NeuralNetworks". Segments are [A-Za-z0-9] only, so any
// other letter the tokenizer kept gets dropped; a word that loses everything is
// simply gone from the segment.
function pascal(word: string): string {
  return (word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).replace(/[^A-Za-z0-9]/g, "");
}

function segmentFor(
  picked: string[],
  candidateIndex: number, // 0-based; only its +1 appears, as the fallback and last-resort suffix
  termsPerSegment: number,
  used: Set<string>,
): string {
  let seg = picked.slice(0, termsPerSegment).map(pascal).join("");
  if (seg === "") seg = `Group${candidateIndex + 1}`; // no terms survived
  for (let i = termsPerSegment; used.has(seg.toLowerCase()) && i < picked.length; i++) {
    seg += pascal(picked[i]); // extend with the next unpicked term
  }
  if (used.has(seg.toLowerCase())) seg += String(candidateIndex + 1); // candidate indices are unique
  used.add(seg.toLowerCase());
  return seg;
}

// --- hierarchy building ---

// Cluster `notes` (whose unit vectors are `x`) into children. A candidate is
// real at minSubClusterSize notes AND cohesionGain over the parent's mean
// cosine to its centroid; descent happens only with minChildren real ones.
// Returns null when there is no descent. On the root the parent is virtual
// (a level-0 node cannot exist), so the retained notes become a sibling node
// there; elsewhere they stay with the real parent.
function descend(
  notes: TaxonomyInputNote[],
  x: Float32Array[],
  seedOff: number,
  root: boolean,
  ctx: Ctx,
): Kid[] | null {
  const k = kRule(notes.length, ctx.minSubClusterSize);
  if (k < 2) return null;
  const assign = kmeans(x, k, seedOff);
  const groups: number[][] = Array.from({ length: k }, () => [] as number[]);
  for (let i = 0; i < x.length; i++) groups[assign[i]].push(i);
  const parentCoh = meanCos(x);
  const real = groups.map(
    (ids) => ids.length >= ctx.minSubClusterSize && meanCos(ids.map((i) => x[i])) - parentCoh >= ctx.cohesionGain,
  );
  if (real.filter(Boolean).length < ctx.minChildren) return null;

  const retained: number[] = [];
  for (let i = 0; i < notes.length; i++) if (!real[assign[i]]) retained.push(i);

  // c-TF-IDF classes: the sibling candidate clusters (root: plus the retained
  // sibling, since it becomes a node there).
  const classes: { c: number; toks: string[] }[] = [];
  for (let c = 0; c < k; c++) {
    if (groups[c].length) classes.push({ c, toks: groups[c].flatMap((i) => tokensOf(notes[i], ctx)) });
  }
  if (root && retained.length) classes.push({ c: k, toks: retained.flatMap((i) => tokensOf(notes[i], ctx)) });
  const picks = labelClasses(classes.map((cl) => cl.toks));

  const used = new Set<string>();
  const kids: Kid[] = [];
  classes.forEach((cl, ci) => {
    if (cl.c < k && !real[cl.c]) return; // non-real candidates get no node; their notes stay with the parent
    kids.push({
      seg: segmentFor(picks[ci], cl.c, ctx.termsPerSegment, used),
      idxs: cl.c === k ? retained : groups[cl.c],
      seed: seedOff * 31 + cl.c + 1, // decorrelate per candidate; any deterministic offset works
    });
  });
  return kids;
}

// Emit `notes` as the node `segments` (retained notes hang on it), then its
// children, depth-first; siblings in segment order.
function emitNode(
  notes: TaxonomyInputNote[],
  base: Float32Array[],
  segments: string[],
  seedOff: number,
  ctx: Ctx,
): void {
  const x = recenter(base); // parent mean subtracted again before descent
  const kids = segments.length < ctx.maxDepth ? descend(notes, x, seedOff, false, ctx) : null;
  const held = new Set<number>();
  for (const kid of kids ?? []) for (const i of kid.idxs) held.add(i);

  const notePaths = notes.filter((_, i) => !held.has(i)).map((n) => n.path).sort();
  ctx.nodes.push({ level: segments.length, segments, notePaths });
  const path = joinSegments(segments); // every tag path string is made here (invariant 7)
  for (const p of notePaths) ctx.leafAssignment.set(p, path);

  kids?.sort((a, b) => (a.seg < b.seg ? -1 : 1));
  for (const kid of kids ?? []) {
    emitNode(kid.idxs.map((i) => notes[i]), kid.idxs.map((i) => x[i]), [...segments, kid.seg], kid.seed, ctx);
  }
}

/**
 * Build the taxonomy over the shared pool. Deterministic for any permutation
 * of `input`: the pool is sorted by path and all randomness flows from
 * options.seed. Notes whose vec has the wrong dimensionality or a non-finite
 * component are dropped; below 3 usable notes the result is empty.
 */
export function buildTaxonomy(
  input: TaxonomyInputNote[],
  textOf: TextProvider,
  options?: TaxonomyOptions,
): TaxonomyResult {
  const opts = options ?? {};
  const ctx: Ctx = {
    maxDepth: opts.maxDepth ?? 3,
    minSubClusterSize: opts.minSubClusterSize ?? 5,
    minChildren: opts.minChildren ?? 2,
    cohesionGain: opts.cohesionGain ?? 0.05,
    termsPerSegment: opts.termsPerSegment ?? 2,
    textOf,
    tokens: new Map(),
    nodes: [],
    leafAssignment: new Map(),
  };
  const seed = opts.seed ?? 42;

  // Determinism invariant: the caller's array order is NOT stable
  // (IndexStore.vaultMapInput() iterates in insertion order), so sort by path
  // before anything else — everything downstream is a pure function of this
  // order plus `seed`, so any input permutation yields byte-identical output.
  const notes = input.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const dims = notes.length ? notes[0].vec.length : 0; // pool dimensionality, deterministic post-sort
  const usable = notes.filter((n) => n.vec.length === dims && allFinite(n.vec));
  if (usable.length < 3) return { nodes: [], leafAssignment: new Map() };

  const unit = usable.map((n) => normalise(n.vec));
  const centered = recenter(unit); // pool centering, as vault-map does before its k-means
  const top = descend(usable, centered, seed, true, ctx);
  if (top === null) {
    // The whole pool is one concept: name it as a single class.
    const seg = segmentFor(labelClasses([usable.flatMap((n) => tokensOf(n, ctx))])[0], 0, ctx.termsPerSegment, new Set());
    emitNode(usable, unit, [seg], seed, ctx);
  } else {
    top.sort((a, b) => (a.seg < b.seg ? -1 : 1));
    for (const kid of top) {
      emitNode(kid.idxs.map((i) => usable[i]), kid.idxs.map((i) => centered[i]), [kid.seg], kid.seed, ctx);
    }
  }
  return { nodes: ctx.nodes, leafAssignment: ctx.leafAssignment };
}
