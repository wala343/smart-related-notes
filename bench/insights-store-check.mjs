// INSIGHTS HARNESS — regression suite for the insights store math (work order 0017).
//
// Drives the REAL IndexStore through the same fake-vault seam as
// bench/v3-integration.mjs and bench/embedding-recovery-check.mjs: a synthetic vault,
// a deterministic inline engine returning minuscule unit vectors, and metadataCache
// fixtures ({tags, headings, frontmatter}, resolvedLinks). Fully offline; no model,
// no network, no lab data.
//
//   npm run test:tagging
//
// Fixture geometry rules (read before touching any vector — checkCentroid enforces them):
// - Options pin structureInfluence/graphInfluence/ideaInfluence to 0 so a rank score
//   is exactly biMax x contentConfidence — semantic-only, no channel cross-talk.
// - ISOTROPY MUST BE EXACT, NOT SMALL. src/vector-math.ts computeCentroid has no
//   epsilon guard: it L2-normalizes the mean of the note means, so a corpus whose means
//   sum to float32 noise (~1e-8) still gets a FULL-STRENGTH unit centroid subtracted from
//   every vector — which inverts the designed geometry and makes unrelated notes score
//   ~1.0. The only safe isotropy is an EXACTLY zero float32 sum, and that holds iff every
//   note is listed IMMEDIATELY BEFORE its exact antipodal twin (0 + v = v, then v + -v =
//   0, exactly, for any v). Interleave nothing between a pair, and give every note a twin.
// - A vault that NEEDS centering (the template suite, whose detection only runs on
//   centered means) keeps its imbalance on ONE basis axis: the centroid then lands on
//   that axis alone and every design vector, which uses the other axes, is untouched.
// - Content confidence is steered by BODY LENGTH (CONFIDENT_BODY_CHARS=220): a long
//   body scores conf 1.0, a short body < 1.0, which is what makes a pair straddle
//   DUP_SIM directionally (order 0015's pair-collapse fixture).
// - Assertions target semantic outcomes (membership, ordering, receipts), never fragile
//   absolute scores; the few numeric tolerances below are ~5x the int8 quantization noise.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { IndexStore } from "../src/index-store.ts";
import { TFile } from "./obsidian-stub.mjs";

const DIMS = 6;

// build() yields through async-yield's shared MessageChannel; node keeps the loop
// alive while a port is open, so track ports and close them at the end — the same
// fix bench/embedding-recovery-check.mjs applies. Without it `node --test` hangs.
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

// --- vector helpers -----------------------------------------------------------

// Unit vector (Float32Array) from components; input need not be normalized.
function unit(...comps) {
  const v = new Float32Array(DIMS);
  comps.forEach((c, i) => (v[i] = c));
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < DIMS; i++) v[i] /= n;
  return v;
}

// Unit vector at `deg` from basis axis `axis`, rotated into (axis, axis+1).
function dir(axis, deg) {
  const r = (deg * Math.PI) / 180;
  const v = new Float32Array(DIMS);
  v[axis] = Math.cos(r);
  v[axis + 1] = Math.sin(r);
  return v;
}

// A symmetric vector pair whose dot product is exactly cos(angle between them).
function pairOnAxis(axis, deg) {
  return [dir(axis, deg), dir(axis, -deg)];
}

function neg(v) {
  const n = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) n[i] = -v[i];
  return n;
}

// --- fake vault + deterministic engine ----------------------------------------

// Long body: > CONFIDENT_BODY_CHARS (220) body chars -> contentConfidence 1.0.
// Short body: ~90 chars -> confidence ~0.58, which steers one DIRECTION of a pair
// below DUP_SIM while the other direction stays above it.
// One sentence, no periods: it stays a single chunk whose stored text length the
// confidence math reads.
function longBody(word) {
  return (
    word +
    " lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".repeat(
      3
    )
  );
}
function shortBody(word) {
  return word + " lorem ipsum dolor sit amet consectetur adipiscing elit sed do";
}

const ADAPTER = {
  exists: async () => true,
  write: async () => {},
  writeBinary: async () => {},
  rename: async () => {},
  remove: async () => {},
  mkdir: async () => {},
};

const OPTIONS = {
  excludeFolders: [], topK: 50, minSimilarity: 0.2, chunking: true,
  structureInfluence: 0, maxChunks: 48, shortlistSize: 60, showSummary: true,
  headingContext: false, ideaInfluence: 0, isolatedAreas: [], graphInfluence: 0,
};

// notes: [{ word, path, vec, body?, tags?, headings?, mtime?, links? }]
// The engine maps every embed text back to its note by the note's word, so EVERY note's
// word must equal its path BASENAME: the chunker's title chunk is the basename (no
// reimplementation of the chunker needed, and no path knowledge in the engine).
async function makeStore(notes, resolvedLinks = {}, expect = { centroid: null }) {
  const files = notes.map((n, i) => new TFile(n.path, n.mtime ?? (i + 1) * 1000));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const bodies = new Map(notes.map((n) => [n.path, n.body ?? longBody(n.word)]));
  const caches = new Map(
    notes.map((n) => [
      n.path,
      {
        tags: (n.tags ?? []).map((tag) => ({ tag })),
        headings: (n.headings ?? []).map((heading) => ({ heading })),
        frontmatter: n.frontmatter ?? {},
        links: [],
        embeds: [],
      },
    ])
  );
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path) => byPath.get(path) ?? null,
      cachedRead: async (file) => bodies.get(file.path),
      adapter: ADAPTER,
    },
    metadataCache: {
      getCache: (path) => caches.get(path) ?? null,
      getFileCache: (file) => caches.get(file.path) ?? null,
      resolvedLinks,
    },
    workspace: { on: () => ({}), getActiveFile: () => null },
  };
  // v3-integration.mjs's deterministic plain-object engine seam.
  const engine = {
    loaded: true,
    async embedBatch(texts) {
      return texts.map((t) => {
        let hit = null;
        for (const n of notes) {
          const w = n.word;
          if (t === w || t.startsWith(w + " ") || t.startsWith(w + ".")) {
            if (hit) throw new Error(`fixture: chunk text matches two notes: ${t.slice(0, 60)}`);
            hit = n;
          }
        }
        if (!hit) throw new Error(`fixture: no note owns chunk text: ${t.slice(0, 60)}`);
        return hit.vec;
      });
    },
    async embed(text) {
      return (await this.embedBatch([text]))[0];
    },
    dispose() {},
    unload() {},
  };
  const store = new IndexStore(app, engine, "insights-check", OPTIONS);
  await store.build();
  checkFixture(store, notes, expect);
  return store;
}

// Fixture self-checks, so a broken fixture fails LOUDLY at build time instead of
// showing up as a wrong number three suites later. (These are harness-validity checks,
// not store assertions: the suites below stay exactly as work order 0017 enumerates.)
function checkFixture(store, notes, expect) {
  const label = `vault ${notes[0].path.split("/")[0]}`;
  const missing = notes.map((n) => n.path).filter((p) => !store.entries.has(p));
  if (missing.length > 0) {
    throw new Error(
      `${label}: ${missing.length} note(s) never indexed (${missing.join(", ")}) — the ` +
        `engine keys every chunk on the file BASENAME, so a note's word must equal its basename`,
    );
  }
  const c = store.centroid;
  const shown = c === null ? "null" : Array.from(c).map((x) => x.toExponential(2)).join(", ");
  if (expect.centroid === null) {
    if (c !== null) {
      throw new Error(
        `${label}: designed-isotropic corpus got centroid ${shown} — a note must sit ` +
          `IMMEDIATELY BEFORE its antipodal twin, and every note needs one (see the header note)`,
      );
    }
  } else {
    const axis = expect.centroid;
    const off = c === null ? [] : Array.from(c).map((x, i) => (i === axis ? Math.abs(x - 1) : Math.abs(x)));
    if (c === null || off.some((d) => d > 1e-6)) {
      throw new Error(`${label}: expected the centroid on axis ${axis} exactly, got ${shown}`);
    }
  }
}

function note(n) {
  return n;
}

// --- vault fixtures -----------------------------------------------------------

// VAULT T — tag-vote vault, 20 notes: the cluster (focus + nbr1..7 at ±2..16 deg), each
// note IMMEDIATELY followed by its untagged antipodal twin (exact isotropy), then four
// orthogonal pads carrying #Every/One. df(goa/character)=8 (focus carries it -> never
// suggested back), df(goa/location)=6 (support 6 of focus's 7 voters), df(goa/ship)=5
// (support 5), df(every/one)=11 > 50% of 20 (majority-voted but not discriminative),
// df(low/df)=2 < MIN_TAG_DF.
function vaultT() {
  const out = [];
  const pair = (n, twin) => out.push(note(n), note(twin));
  pair(
    { word: "focus", path: "t/focus.md", vec: dir(0, 2), tags: ["#Goa/Character"] },
    { word: "tmir0", path: "t/tmir0.md", vec: neg(dir(0, 2)) },
  );
  [4, -4, 8, -8, 12, -12, 16].forEach((deg, i) =>
    pair(
      {
        word: `nbr${i + 1}`,
        path: `t/nbr${i + 1}.md`,
        vec: dir(0, deg),
        tags: [
          "#Goa/Character",
          "#Every/One",
          ...(i < 6 ? ["#Goa/Location"] : []), // nbr1..6
          ...(i < 5 ? ["#Goa/Ship"] : []), // nbr1..5
          ...(i === 0 ? ["#Low/Df"] : []), // df(low/df) lands on exactly 2 notes…
        ],
      },
      { word: `tmir${i + 1}`, path: `t/tmir${i + 1}.md`, vec: neg(dir(0, deg)) },
    ),
  );
  // …the other one here. The pads are orthogonal to the cluster (df census only), so
  // they are never anybody's ranked neighbour; each pad is its neighbour's twin.
  const pads = [
    { word: "tpad1", vec: unit(0, 0, 1, 0, 0, 0), tags: ["#Every/One", "#Low/Df"] },
    { word: "tpad2", vec: unit(0, 0, -1, 0, 0, 0), tags: ["#Every/One"] },
    { word: "tpad3", vec: unit(0, 0, 0, 1, 0, 0), tags: ["#Every/One"] },
    { word: "tpad4", vec: unit(0, 0, 0, -1, 0, 0), tags: ["#Every/One"] },
  ];
  pads.forEach((p) => out.push(note({ ...p, path: `t/${p.word}.md` })));
  return out;
}

// MINI vaults — the MIN_TAG_NEIGHBORS boundary. m5: focus + 5 tagged neighbours ->
// voters=5 suggests; m4: focus + 4 tagged neighbours -> below the floor, nothing.
function miniVault(prefix, count) {
  const f = dir(0, 2);
  const out = [
    note({ word: `${prefix}f`, path: `${prefix}/${prefix}f.md`, vec: f }),
    note({ word: `${prefix}mf`, path: `${prefix}/${prefix}mf.md`, vec: neg(f) }),
  ];
  [4, -4, 8, -8, 12].slice(0, count).forEach((deg, i) => {
    const v = dir(0, deg);
    out.push(
      note({ word: `${prefix}n${i}`, path: `${prefix}/${prefix}n${i}.md`, vec: v, tags: ["#Mini/Vote"] }),
      note({ word: `${prefix}m${i}`, path: `${prefix}/${prefix}m${i}.md`, vec: neg(v) }),
    );
  });
  return out;
}

// VAULT P — pair collapse (0015). heavy (long body, conf 1.0) and light (short body,
// conf < 1) share cos 0.9: the heavy->light direction scores 0.9*conf(light), which
// lands in [SUGGEST_SIM, DUP_SIM), while light->heavy scores 0.9 >= DUP_SIM. Exactly one
// row across BOTH tables, living in nearDuplicates. mheavy/mlight are the antipodal
// twins that keep the corpus exactly isotropic (they straddle the same way, and the
// assertions only look at the heavy/light pair).
function vaultP() {
  const heavy = dir(0, 12.9); // cos(2 x 12.9deg) = 0.9003
  const light = dir(0, -12.9);
  return [
    note({ word: "heavy", path: "p/heavy.md", vec: heavy }),
    note({ word: "mheavy", path: "pm/mheavy.md", vec: neg(heavy) }),
    note({ word: "light", path: "p/light.md", vec: light, body: shortBody("light") }),
    note({ word: "mlight", path: "pm/mlight.md", vec: neg(light), body: shortBody("mlight") }),
  ];
}

// VAULT D — same-folder demotion (0015). s-pair (same folder "d") scores 0.62, c-pair
// (folder "dx" + vault root) 0.58, r-pair (both vault root) 0.60; all in
// [SUGGEST_SIM, DUP_SIM) so all are suggestedLinks rows. Raw ordering puts s first; the
// 0.75 demotion key must push s BELOW c while its stored score stays 0.62, and the root
// pair must never be demoted. The three planes (0,1), (2,3), (4,5) are mutually
// orthogonal, so ONLY the designed pairs score anything; each note's dmz/ twin is listed
// right after it (their own mutual cosines mirror the designed pairs, and the assertions
// filter on specific pairs).
function vaultD() {
  const [s1, s2] = pairOnAxis(0, 25.84); // cos = 0.6205
  const [c1, c2] = pairOnAxis(2, 27.29); // cos = 0.5810
  const [r1, r2] = pairOnAxis(4, 26.38); // cos = 0.6002
  const out = [];
  [
    ["ds1", "d/ds1.md", s1],
    ["ds2", "d/ds2.md", s2],
    ["dc1", "dx/dc1.md", c1],
    ["dc2", "dc2.md", c2], // vault root
    ["dr1", "dr1.md", r1], // vault root
    ["dr2", "dr2.md", r2], // vault root
  ].forEach(([word, path, vec]) =>
    out.push(
      note({ word, path, vec }),
      note({ word: `dm${word}`, path: `dmz/dm${word}.md`, vec: neg(vec) }),
    ),
  );
  return out;
}

// VAULT TP — template exclusion (0015). tp1/tp2/tp3 share two headings, so
// templateGroups() finds a real MIN_TEMPLATE_GROUP=3 group. THAT detection only runs over
// centered means, so this vault is the ONE fixture that deliberately has a centroid — and
// it puts the imbalance entirely on axis 0 (the two identical tpo offsets), so the
// centroid is exactly +axis0 and the design plane (axes 1..5) is never touched.
// tp1 and tp2 carry IDENTICAL vectors, so their pair scores 1.0 even after the template
// direction is subtracted: it is exactly the noise the order's exclusion must remove.
// tc1/tc2 are an ordinary non-template pair (cos 0.766) that must keep showing up; every
// other note here is a twin of the note before it.
function vaultTP() {
  const a = unit(0, 1, 0, 0, 0, 0);
  const b = unit(0, 0, 0, 0, 1, 0);
  const [c1, c2] = pairOnAxis(2, 20); // cos = 0.766
  const headings = ["Alpha", "Beta"];
  const out = [
    note({ word: "tpo1", path: "tp/tpo1.md", vec: unit(1, 0, 0, 0, 0, 0) }),
    note({ word: "tpo2", path: "tp/tpo2.md", vec: unit(1, 0, 0, 0, 0, 0) }),
    note({ word: "tp1", path: "tp/tp1.md", vec: a, headings }),
    note({ word: "tpm1", path: "tp/tpm1.md", vec: neg(a) }),
    note({ word: "tp2", path: "tp/tp2.md", vec: a, headings }),
    note({ word: "tpm2", path: "tp/tpm2.md", vec: neg(a) }),
    note({ word: "tp3", path: "tp/tp3.md", vec: b, headings }),
    note({ word: "tpm3", path: "tp/tpm3.md", vec: neg(b) }),
    note({ word: "tc1", path: "tc/tc1.md", vec: c1 }),
    note({ word: "tcm1", path: "tcm/tcm1.md", vec: neg(c1) }),
    note({ word: "tc2", path: "tc/tc2.md", vec: c2 }),
    note({ word: "tcm2", path: "tcm/tcm2.md", vec: neg(c2) }),
  ];
  return out;
}

// VAULT X — taxonomy fixture home (suite 5); the taxonomy itself is a literal. The two
// leaf notes ARE indexed notes: order 0015's taxonomy proposals cover a leafAssignment
// entry only when its path is in the eligible universe (an indexed, unignored, shared-pool
// note), and they carry NO tags, so the inventory is empty and both real 0005 detectors
// stay silent. They are antipodal twins, so the corpus is exactly isotropic.
function vaultX() {
  const u = dir(0, 5);
  return [
    note({ word: "n1", path: "x/n1.md", vec: u }),
    note({ word: "n2", path: "x/n2.md", vec: neg(u) }),
  ];
}
// Synthetic TaxonomyResult literal (consumed 0001 shape, plain objects).
function taxonomyX() {
  return {
    nodes: [
      { level: 1, segments: ["Goa"], notePaths: ["x/n1.md", "x/n2.md"] },
      { level: 2, segments: ["Goa", "Character"], notePaths: ["x/n1.md", "x/n2.md"] },
    ],
    leafAssignment: new Map([
      ["x/n1.md", "Goa/Character"],
      ["x/n2.md", "Goa/Character"],
    ]),
  };
}
// Pinned order-0003 line format, written as LITERAL expected lines (indent = two
// spaces per level above 1; "- **<path>** — <n> notes"; up to 3 title representatives).
const PREVIEW_X = [
  "## Concept taxonomy preview",
  "- **Goa** — 2 notes",
  "  - n1",
  "  - n2",
  "  - **Goa/Character** — 2 notes",
  "    - n1",
  "    - n2",
];

// VAULT V — propagation fixture (suite 6). focus vpf + nbrs vpn0..4 (all
// "#Goa/Character", canonical case) + vpo ("#Other/Only") cluster around each other; each
// note is followed by its untagged antipodal twin vpm*, and vpleaf/vppad are orthogonal
// filler (twins of each other). So vpf and vpo each get ONE suggestedTags row (support 5
// of voters 6 — the cluster's other six members), the nbrs already carry the tag, and a
// mirror's six ranked neighbours are all untagged, so a mirror never votes.
// conceptProposals must then be EXACTLY three: one taxonomy proposal on vpleaf + the two
// propagation rows. Inventory tags are own/flag, goa/character and other/only; the
// taxonomy's node finals are "Goa" and "Location", so detectPlacement (leaf-segment
// kinship) and detectNormalization (case/separator malformation — the store strips the
// leading "#" before the exact strings reach cleanTag) both stay silent.
function vaultV() {
  const out = [];
  [
    ["vpf", dir(0, 2), ["#Own/Flag"]],
    ["vpn0", dir(0, 4), ["#Goa/Character"]],
    ["vpn1", dir(0, -4), ["#Goa/Character"]],
    ["vpn2", dir(0, 8), ["#Goa/Character"]],
    ["vpn3", dir(0, -8), ["#Goa/Character"]],
    ["vpn4", dir(0, 12), ["#Goa/Character"]],
    ["vpo", dir(0, 16), ["#Other/Only"]],
  ].forEach(([word, vec, tags], i) =>
    out.push(
      note({ word, path: `v/${word}.md`, vec, tags }),
      note({ word: `vpm${i}`, path: `v/vpm${i}.md`, vec: neg(vec) }),
    ),
  );
  out.push(
    note({ word: "vpleaf", path: "v/vpleaf.md", vec: unit(0, 0, 0, 0, 1, 0) }),
    note({ word: "vppad", path: "v/vppad.md", vec: unit(0, 0, 0, 0, -1, 0) }),
  );
  return out;
}
function taxonomyV() {
  return {
    nodes: [
      { level: 1, segments: ["Goa"], notePaths: ["v/vpleaf.md"] },
      { level: 2, segments: ["Goa", "Location"], notePaths: ["v/vpleaf.md"] },
    ],
    leafAssignment: new Map([["v/vpleaf.md", "Goa/Location"]]),
  };
}

// VAULT Y — parity smoke. yaa links ybb, so every other note is an orphan; ycc's top rank
// must surface as `closest` (yaa, 8 deg apart) and ypz's as ybb. Scrambled mtimes pin the
// stale ordering. The ym* twins keep the corpus exactly isotropic and cluster at ~180 deg,
// well away from the design cluster, so no orphan ever pairs with its own twin.
function vaultY() {
  const out = [];
  [
    ["yaa", 4, 3000],
    ["ybb", 10, 4000],
    ["ycc", -4, 2000],
    ["ypz", 16, 5000],
  ].forEach(([word, deg, mtime], i) => {
    out.push(
      note({ word, path: `y/${word}.md`, vec: dir(0, deg), mtime }),
      note({ word: `ym${i + 1}`, path: `y/ym${i + 1}.md`, vec: neg(dir(0, deg)), mtime: mtime + 4000 }),
    );
  });
  return out;
}
// stale ordering = mtime ascending, deliberately NOT the insertion order.
const Y_STALE = [
  ["y/ycc.md", 2000],
  ["y/yaa.md", 3000],
  ["y/ybb.md", 4000],
  ["y/ypz.md", 5000],
  ["y/ym3.md", 6000],
  ["y/ym1.md", 7000],
  ["y/ym2.md", 8000],
  ["y/ym4.md", 9000],
];

// --- pre-built stores (build once per vault) ----------------------------------

const tStore = await makeStore(vaultT());
const m5Store = await makeStore(miniVault("m5", 5));
const m4Store = await makeStore(miniVault("m4", 4));
const pStore = await makeStore(vaultP());
const dStore = await makeStore(vaultD());
// The one fixture that needs centering: template detection runs on centered means only.
const tpStore = await makeStore(vaultTP(), {}, { centroid: 0 });
const xStore = await makeStore(vaultX());
const vStore = await makeStore(vaultV());
const yStore = await makeStore(vaultY(), { "y/yaa.md": { "y/ybb.md": 1 } });

// --- helpers ------------------------------------------------------------------

const fileAt = (store, path) => store.app.vault.getAbstractFileByPath(path);
const hasPair = (row, a, b) =>
  (row.from === a && row.to === b) || (row.from === b && row.to === a) ||
  (row.a === a && row.b === b) || (row.a === b && row.b === a);
const rowHas = (row, path) => row.from === path || row.to === path || row.a === path || row.b === path;

// =============================================================================
// SUITE: suggestedTagNeighbours (order 0014)
// =============================================================================

test("suggestedTagNeighbours: majority tag suggested with support/voters receipt", async (t) => {
  await t.test("at MIN_TAG_NEIGHBORS (5 voters) the majority tag is suggested", () => {
    const rows = m5Store.suggestedTagNeighbours(fileAt(m5Store, "m5/m5f.md"));
    assert.deepEqual(rows, [{ tag: "mini/vote", support: 5, voters: 5 }]);
  });
  await t.test("4 voters (below MIN_TAG_NEIGHBORS) suggests nothing", () => {
    const rows = m4Store.suggestedTagNeighbours(fileAt(m4Store, "m4/m4f.md"));
    assert.deepEqual(rows, []);
  });
  await t.test("a >50% df tag (not discriminative) is suppressed despite the vote", () => {
    const rows = tStore.suggestedTagNeighbours(fileAt(tStore, "t/focus.md"));
    assert.equal(rows.some((r) => r.tag === "every/one"), false,
      `every/one carries df 11 > 50% of 20 notes and must never surface: ${JSON.stringify(rows)}`);
  });
  await t.test("a df < MIN_TAG_DF tag is suppressed", () => {
    // df(low/df)=2 everywhere; a df<3 tag must never appear in ANY note's vote rows.
    for (const path of ["t/focus.md", ...[1, 2, 3, 4, 5, 6, 7].map((i) => `t/nbr${i}.md`)]) {
      const rows = tStore.suggestedTagNeighbours(fileAt(tStore, path));
      assert.equal(rows.some((r) => r.tag === "low/df"), false, `low/df suggested for ${path}`);
    }
    const all = tStore.computeInsights().suggestedTags;
    assert.equal(all.some((r) => r.tag === "low/df"), false, "low/df appears in suggestedTags");
  });
  await t.test("a tag the note already carries is not suggested", () => {
    const rows = tStore.suggestedTagNeighbours(fileAt(tStore, "t/focus.md"));
    assert.equal(rows.some((r) => r.tag === "goa/character"), false,
      "focus carries #Goa/Character itself; it must not be suggested back");
  });
  await t.test("vote ordering: support/voters desc, then support desc", () => {
    const rows = tStore.suggestedTagNeighbours(fileAt(tStore, "t/focus.md"));
    // 7 voters (nbr1..7, all tagged): goa/location support 6, goa/ship support 5.
    assert.deepEqual(rows, [
      { tag: "goa/location", support: 6, voters: 7 },
      { tag: "goa/ship", support: 5, voters: 7 },
    ]);
  });
});

// =============================================================================
// SUITE: pair collapse (order 0015)
// =============================================================================

test("pair collapse: a DUP-straddling pair appears exactly once, in nearDuplicates", () => {
  const ins = pStore.computeInsights();
  const dups = ins.nearDuplicates.filter((r) => hasPair(r, "p/heavy.md", "p/light.md"));
  const sugs = ins.suggestedLinks.filter((r) => hasPair(r, "p/heavy.md", "p/light.md"));
  // The straddle is real: one direction >= DUP_SIM, the other below it.
  assert.equal(dups.length + sugs.length, 1,
    `pair must appear exactly once across both tables, got ${dups.length} dup + ${sugs.length} suggested: ` +
      JSON.stringify({ dups, sugs }));
  assert.equal(dups.length, 1, "the near-duplicate claim (>= DUP_SIM) is the stronger one and must win");
});

// =============================================================================
// SUITE: same-folder demotion (order 0015)
// =============================================================================

test("same-folder demotion: demoted pair ranks below the cross pair with caveats", () => {
  const ins = dStore.computeInsights();
  const s = ins.suggestedLinks.find((r) => hasPair(r, "d/ds1.md", "d/ds2.md"));
  const c = ins.suggestedLinks.find((r) => hasPair(r, "dx/dc1.md", "dc2.md"));
  const r = ins.suggestedLinks.find((r) => hasPair(r, "dr1.md", "dr2.md"));
  assert.ok(s && c && r, `all three pairs must be suggested rows: ${JSON.stringify(ins.suggestedLinks)}`);
  // Ranking key (not stored score): same-folder s (raw 0.62 * 0.75 = 0.465) must
  // rank BELOW the cross-folder c (raw 0.58), despite the higher raw similarity.
  const iS = ins.suggestedLinks.indexOf(s);
  const iC = ins.suggestedLinks.indexOf(c);
  assert.ok(iC < iS, `cross-folder row (idx ${iC}) must rank before demoted same-folder row (idx ${iS})`);
  assert.ok(ins.suggestedLinks.indexOf(r) < iS,
    "vault-root pairs are never demoted: the root pair (0.60) must also rank above the demoted pair");
  // Receipt and raw score preservation.
  assert.deepEqual(s.caveats, ["same-folder"]);
  assert.ok(Math.abs(s.score - 0.6205) < 0.02, `stored score must stay the RAW similarity, got ${s.score}`);
  assert.equal(c.caveats, undefined, "cross-folder rows carry no caveats");
  assert.equal(r.caveats, undefined, "vault-root rows carry no caveats");
  assert.ok(s.score > c.score && s.score > r.score,
    "raw score of the demoted pair must still be the highest of the three");
});

// =============================================================================
// SUITE: template exclusion (order 0015)
// =============================================================================

test("template exclusion: no template-shaped note is half of any pair row", () => {
  const ins = tpStore.computeInsights();
  const shaped = ["tp/tp1.md", "tp/tp2.md", "tp/tp3.md"];
  // Premise: tp1/tp2 carry identical vectors, so their pair scores ~1.0 and lands in
  // nearDuplicates unless the exclusion runs.
  const all = [...ins.nearDuplicates, ...ins.suggestedLinks];
  assert.ok(all.some((row) => hasPair(row, "tc/tc1.md", "tc/tc2.md")),
    "fixture premise: the ordinary non-template pair must show up in a pair list");
  for (const p of shaped) {
    assert.equal(all.some((row) => rowHas(row, p)), false,
      `template-shaped ${p} must not be either half of any nearDuplicates/suggestedLinks row: ${JSON.stringify(all)}`);
  }
});

// =============================================================================
// SUITE: conceptProposals / taxonomyPreview (order 0015)
// =============================================================================

test("conceptProposals + taxonomyPreview from a synthetic TaxonomyResult literal", () => {
  const ins = xStore.computeInsights(new Set(), taxonomyX());
  const proposals = (ins.conceptProposals ?? []).map(({ kind, notePath, tagPath, confidence, evidence }) => ({
    kind, notePath, tagPath, confidence, evidence,
  }));
  // One proposal per leafAssignment entry, sorted by note path, pinned evidence form.
  assert.deepEqual(proposals, [
    {
      kind: "taxonomy", notePath: "x/n1.md", tagPath: "Goa/Character", confidence: 1,
      evidence: "assigned to node Goa/Character (2 notes, level 2)",
    },
    {
      kind: "taxonomy", notePath: "x/n2.md", tagPath: "Goa/Character", confidence: 1,
      evidence: "assigned to node Goa/Character (2 notes, level 2)",
    },
  ]);
  // The preview is order-0003's lines carried VERBATIM.
  assert.deepEqual(ins.taxonomyPreview, PREVIEW_X);
  // No taxonomy passed -> empty preview (and no taxonomy-kind proposals).
  const plain = xStore.computeInsights();
  assert.deepEqual(plain.taxonomyPreview, []);
  assert.equal((plain.conceptProposals ?? []).some((p) => p.kind === "taxonomy"), false);
});

// =============================================================================
// SUITE: propagation proposals (order 0016)
// =============================================================================

test("propagation: exact receipts across taxonomy and propagation kinds (3 proposals)", () => {
  const ins = vStore.computeInsights(new Set(), taxonomyV());
  const rows = ins.suggestedTags;
  assert.equal(rows.length, 2, `fixture premise: vpf and vpo carry exactly two rows: ${JSON.stringify(rows)}`);
  assert.deepEqual(
    rows.map((r) => [r.path, r.tag, r.support, r.neighbors]),
    // Deterministic tie (both 5/6): emission follows entries insertion order.
    [
      ["v/vpf.md", "goa/character", 5, 6],
      ["v/vpo.md", "goa/character", 5, 6],
    ]
  );
  const props = ins.conceptProposals ?? [];
  // Ordering contract: taxonomy proposals first, then (fixture-silent) placement/
  // normalization, then propagation mirroring the returned suggestedTags order.
  assert.equal(props.length, 3, `exactly three proposals expected: ${JSON.stringify(props)}`);
  const [tax, ...prop] = props;
  assert.deepEqual(
    { kind: tax.kind, notePath: tax.notePath, tagPath: tax.tagPath, confidence: tax.confidence, evidence: tax.evidence },
    {
      kind: "taxonomy", notePath: "v/vpleaf.md", tagPath: "Goa/Location", confidence: 1,
      evidence: "assigned to node Goa/Location (1 notes, level 2)",
    }
  );
  assert.deepEqual(
    prop.map((p) => ({
      kind: p.kind, notePath: p.notePath, tagPath: p.tagPath, confidence: p.confidence,
      evidence: p.evidence, replacesTag: "replacesTag" in p ? p.replacesTag : undefined,
    })),
    rows.map((r) => ({
      kind: "propagation", notePath: r.path,
      tagPath: "Goa/Character", // canonical case as the vault writes it, NOT PascalCased
      confidence: r.support / r.neighbors,
      evidence: `${r.support} of ${r.neighbors} nearest neighbours carry this tag`,
      replacesTag: undefined,
    }))
  );
  assert.equal(props.every((p) => !("replacesTag" in p)), true, "replacesTag is NEVER set");
});

// =============================================================================
// SUITE: parity smoke (orphans / stale / suggestedTags shapes)
// =============================================================================

test("parity smoke: orphans, stale and suggestedTags keep their pre-area shapes", () => {
  const ins = yStore.computeInsights();
  assert.equal(ins.total, 8);
  // orphans: everything outside the resolved-link set (yaa -> ybb is the only link).
  const orphanPaths = ins.orphans.map((o) => o.path).sort();
  assert.deepEqual(orphanPaths, [
    "y/ycc.md", "y/ym1.md", "y/ym2.md", "y/ym3.md", "y/ym4.md", "y/ypz.md",
  ]);
  const cc = ins.orphans.find((o) => o.path === "y/ycc.md");
  assert.equal(cc.closest, "y/yaa.md", `cc's closest must be its top rank: ${JSON.stringify(cc)}`);
  assert.ok(cc.closestScore > 0.5, `cc's top rank score must be its designed cosine: ${cc.closestScore}`);
  for (const o of ins.orphans) assert.deepEqual(Object.keys(o).sort(), ["closest", "closestScore", "path"]);
  // stale: every indexed note, oldest first.
  assert.deepEqual(ins.stale.map((s) => s.path), Y_STALE.map(([path]) => path));
  assert.deepEqual(ins.stale.map((s) => s.mtime), Y_STALE.map(([, mtime]) => mtime));
  // suggestedTags rows keep their four declared keys (vStore has real rows).
  const vIns = vStore.computeInsights();
  for (const r of vIns.suggestedTags) {
    assert.deepEqual(Object.keys(r).sort(), ["neighbors", "path", "support", "tag"]);
    assert.equal(r.tag, r.tag.toLowerCase());
  }
  // Pair-row bases keep their keys (caveats is additive and optional per 0015).
  for (const row of [...pStore.computeInsights().suggestedLinks]) {
    for (const k of ["from", "to", "score"]) assert.ok(k in row);
  }
});
