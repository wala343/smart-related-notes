// Offline tests for the reader's un-gated candidate path: the REAL composer,
// validator and ReaderService driven by a fake reader host and a fake engine.
// Nothing here loads llama.cpp, opens a vault or reaches the network — a tag path
// that exists nowhere in the vault must still be offered and picked, and nothing
// unoffered may ever survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { TFile } from "obsidian";
import type { ReaderHost, TagNeighbour } from "./reader-service";
import type { NoteContextInput } from "./reader-tasks";

// Node keeps type-named imports as live bindings, and the engine/asset modules
// pull the weights machinery, so the link graph is patched before the reader
// loads: ./reader-tasks re-exports the REAL module plus its two phantom type
// bindings, ./reader-assets and ./reader-engine become inert stubs whose
// constructor and asset staging throw loudly. The code under test stays real.
const dataUrl = (src: string): string => "data:text/javascript," + encodeURIComponent(src);
const LINK_STUBS = dataUrl(
  "export const RungSpec = undefined; export const RUNGS = []; export const assetsReady = () => false;\n" +
    "export const autoRung = () => ({ id: 'offline' });\n" +
    "export const ensureAssets = async () => { throw new Error('offline test: asset staging must not run'); };\n" +
    "export class ReaderEngine { constructor() { throw new Error('offline test: ReaderEngine must not be constructed'); } }\n",
);
const TASKS_SHIM = dataUrl(
  `export * from ${JSON.stringify(new URL("./reader-tasks.ts", import.meta.url).href)};\n` +
    "export const NoteContextInput = undefined; export const TaskResult = undefined;\n",
);
register(
  dataUrl(
    "export async function resolve(specifier, context, next) {\n" +
      `  if (specifier === "./reader-assets" || specifier === "./reader-engine") return { url: ${JSON.stringify(LINK_STUBS)}, shortCircuit: true };\n` +
      `  if (specifier === "./reader-tasks") return { url: ${JSON.stringify(TASKS_SHIM)}, shortCircuit: true };\n` +
      "  return next(specifier, context);\n" +
      "}\n",
  ),
  import.meta.url,
);
const { ReaderService, composeTagCandidates, MAX_TAG_CANDIDATES } = await import("./reader-service");
const { pickTagsTask } = await import("./reader-tasks");
type ReaderSvc = InstanceType<typeof ReaderService>; // the class arrives as a value, so its instance type is derived

// The fake reader host (order 0008's manifest): a test double implementing
// ReaderHost with fixed synthetic returns. own/votes/taxonomy are the knobs a
// scene turns; `saved` is the saveArtifacts spy.
interface FakeHost extends ReaderHost {
  own: string[];
  votes: TagNeighbour[];
  taxonomy: string[];
  saved: string[];
  renders: number;
}

// Test double standing in for ReaderEngine (order 0008's "fake engine"): the real
// class is never constructed, `reply` is what every task gets back.
interface FakeEngine {
  loaded: boolean;
  lastError: string | null;
  calls: number; // how many tasks the service actually ran
  reply: string;
  generate(prompt: string, maxTokens: number): Promise<string>;
  setRung(): void;
  unload(): Promise<void>;
}

// Fixed TFile-shaped double: its stat never changes, so any staleness the service
// can see must come from the candidate set — that is the rule under test.
const file = {
  path: "notes/mri.md",
  basename: "mri",
  stat: { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000, size: 512 },
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- offline double: a real TFile cannot exist in a node:test process
} as unknown as TFile;

const NOTE =
  "# MRI\nDiffusion tensor imaging of the brain: gradient-echo sequences, B0 field maps and tractography of the arcuate fasciculus.\n";
const NOTE_INPUT: NoteContextInput = { title: "mri", body: NOTE, language: "en" };

let ticking = 0; // window.setInterval calls: the reader tick must never be armed here
let fetchCalls = 0;

function makeService(): { host: FakeHost; svc: ReaderSvc; engine: FakeEngine } {
  const host: FakeHost = {
    own: [],
    votes: [],
    taxonomy: [],
    saved: [],
    renders: 0,
    vaultRead: async () => NOTE,
    markdownFiles: () => [file],
    fileByPath: (p) => (p === file.path ? file : null),
    fileTags: () => host.own,
    neighborPaths: async () => [],
    taxonomyCandidates: () => host.taxonomy,
    tagNeighbours: () => host.votes,
    recentPaths: () => [file.path],
    indexBusy: () => false,
    lastUserActivity: () => 0,
    requestRender: () => {
      host.renders += 1;
    },
    loadArtifacts: async () => null,
    saveArtifacts: async (json) => {
      host.saved.push(json); // the only write channel; the fs is never opened
    },
    readEngineBundle: async () => {
      throw new Error("offline test: no engine bundle is read");
    },
  };
  const svc = new ReaderService(host, { rung: "auto", pace: "balanced", idleUnloadMinutes: 5 });
  const engine: FakeEngine = {
    loaded: true,
    lastError: null,
    calls: 0,
    reply: "NONE",
    async generate(_prompt: string, _maxTokens: number) {
      engine.calls += 1;
      return engine.reply;
    },
    setRung() {},
    async unload() {},
  };
  (svc as unknown as { engine: unknown }).engine = engine; // declared seam: engine injection
  svc.status.state = "ready"; // the panel only asks for chips on a warm engine
  return { host, svc, engine };
}

// computeTags is private; reaching it through this cast is the declared seam, and
// awaiting its promise is the deterministic flush of the artifact write.
const computeTags = (svc: ReaderSvc, f: TFile): Promise<void> =>
  (svc as unknown as { computeTags(f: TFile): Promise<void> }).computeTags(f);

// The artifact as the service last wrote it, read off the save spy — the service's
// own write channel, never its private cache.
type SavedArtifact = { h: string; tags?: string[]; tagsH?: string; cand?: string[]; dismissed?: string[] };
const lastSaved = (host: FakeHost): Record<string, SavedArtifact> =>
  JSON.parse(host.saved.at(-1) ?? "{}") as Record<string, SavedArtifact>;

// suggestedTags fires its recompute unawaited (by design). That chain only ever
// awaits already-resolved promises, so one macrotask tick drains it fully.
// eslint-disable-next-line obsidianmd/prefer-window-timers -- needs the real macrotask tick: the window shim's setTimeout fires synchronously, so it cannot drain the recompute chain
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

// eslint-disable-next-line obsidianmd/no-global-this -- node:test shims the browser globals here; production never runs in this process
const g = globalThis as unknown as { window: unknown; fetch: unknown }; // the single handle every shim swap goes through
// Swapped inline, not in before/after: node:test fires an after hook while earlier-registered
// awaited top-level tests are still pending (verified on Node 22.23.4), restoring mid-run.
const originalWindow = g.window;
const originalFetch = g.fetch;
// window shims: production's queueSave debounce and its tick both go through
// window, so nothing here can arm a real timer or write to disk.
g.window = {
  setInterval: () => (ticking += 1, -1),
  clearInterval: () => {},
  setTimeout: (fn: () => void) => {
    fn(); // the 4 s debounce runs at once, so its write lands on the spy
    return 1;
  },
  clearTimeout: () => {},
};
// tripwire: any network attempt in these tests is counted and fails loudly
g.fetch = () => {
  fetchCalls += 1;
  throw new Error("offline test: these tests never touch the network");
};

await test("composeTagCandidates: taxonomy first, votes by support desc then tag asc, ci dedup, own and weak dropped, capped", () => {
  assert.deepEqual(
    composeTagCandidates(
      ["Existing"],
      [
        { tag: "beta", support: 3, voters: 5 },
        { tag: "alpha", support: 3, voters: 4 },
        { tag: "solo", support: 1, voters: 9 }, // support < 2: below the pick-quality floor
        { tag: "EXISTING", support: 5, voters: 8 }, // case-insensitively an own tag: never offered
      ],
      ["Physics/MRI", "Math/Topology"],
    ),
    ["Physics/MRI", "Math/Topology", "alpha", "beta"], // taxonomy in given order, then support desc, tag asc
  );
  // ci dedup keeps the FIRST occurrence verbatim: the PascalCase path wins its slot
  // against the store's lowercased vote for the same string
  assert.deepEqual(composeTagCandidates([], [{ tag: "physics/mri", support: 4, voters: 4 }], ["Physics/MRI"]), ["Physics/MRI"]);
  assert.deepEqual(composeTagCandidates(["existing"], [], ["Existing", "Math/Topology"]), ["Math/Topology"]);
  assert.deepEqual(composeTagCandidates([], [{ tag: "z", support: 2, voters: 2 }, { tag: "b", support: 2, voters: 2 }], []), ["b", "z"]);
  const paths = Array.from({ length: 20 }, (_, i) => `Zone${i}/Path`);
  assert.equal(MAX_TAG_CANDIDATES, 12);
  assert.deepEqual(composeTagCandidates([], [{ tag: "vote", support: 9, voters: 9 }], paths), paths.slice(0, MAX_TAG_CANDIDATES));
  // deterministic and pure: same inputs → deeply equal output, caller's array intact
  const votes = [{ tag: "z", support: 2, voters: 2 }, { tag: "b", support: 2, voters: 2 }];
  const copy = structuredClone(votes);
  assert.deepEqual(composeTagCandidates([], votes, ["Tax/One"]), composeTagCandidates([], votes, ["Tax/One"]));
  assert.deepEqual(votes, copy);
});

await test("path-shaped offering reaches the pick verbatim, matched case-insensitively", () => {
  const task = pickTagsTask(NOTE_INPUT, ["Physics/MRI", "City"]); // Physics/MRI exists nowhere in the vault: df 0, still offered
  assert.equal(task.prompt.includes("#Physics/MRI"), true); // the path reaches the model as offered
  assert.deepEqual(task.validate("#physics/mri #City please"), ["Physics/MRI", "City"]); // ci match, offered strings verbatim, prose dropped
});

await test("unoffered never survives, and the pick caps at three offered", () => {
  // the same validator serves every rung, so the closed set is the pick-only guarantee everywhere
  assert.deepEqual(pickTagsTask(NOTE_INPUT, ["Physics/MRI", "ml"]).validate("#physics/mri #hallucinated"), ["Physics/MRI"]);
  const offered = ["Physics/MRI", "City", "ml", "extra"];
  assert.deepEqual(pickTagsTask(NOTE_INPUT, offered).validate("#Physics/MRI #CITY #ML #GhostTag"), ["Physics/MRI", "City", "ml"]); // 3 offered + 1 unoffered → exactly the three offered
  assert.deepEqual(pickTagsTask(NOTE_INPUT, offered).validate("NONE"), []); // a note that fits nothing gets nothing
});

await test("coverage cache rule: a covered set serves without recomputing, a new taxonomy path forces a recompute", async () => {
  const { host, svc, engine } = makeService();
  host.votes = [{ tag: "mri", support: 4, voters: 6 }];
  host.taxonomy = ["Physics/MRI"];
  engine.reply = "#Physics/MRI #mri please";
  await computeTags(svc, file);
  const seeded = lastSaved(host)[file.path];
  assert.deepEqual(seeded.cand, ["Physics/MRI", "mri"]); // the offered list is recorded with the pick
  assert.deepEqual(seeded.tags, ["Physics/MRI", "mri"]);
  assert.equal(typeof seeded.tagsH, "string"); // tagsH = hash of (h + candidate set)

  // (a) still covered: the cached pick is served straight from the artifact
  engine.reply = "#Biology/CRISPR"; // a reply the covered cache must not consult
  assert.deepEqual(svc.suggestedTags(file.path), ["Physics/MRI", "mri"]);
  assert.equal(engine.calls, 1); // ... and no recompute ran to produce it

  // (b) the old staleness trap: the file's stat is UNCHANGED, only the taxonomy
  // grew — coverage sees the new path, so the stale pick is dropped, not served
  engine.reply = "#Physics/MRI #Biology/CRISPR";
  host.taxonomy = ["Physics/MRI", "Biology/CRISPR"];
  assert.deepEqual(svc.suggestedTags(file.path), []); // a stale cache never suppresses the new path
  await settle(); // production fires the recompute unawaited
  assert.equal(engine.calls, 2);
  assert.equal(host.renders, 2); // one re-render for the seed, one when the fresh pick lands
  assert.deepEqual(lastSaved(host)[file.path].cand, ["Physics/MRI", "Biology/CRISPR", "mri"]); // the new candidate landed in the artifact
  assert.deepEqual(svc.suggestedTags(file.path), ["Physics/MRI", "Biology/CRISPR"]); // now covered: served
});

await test("dismissed stays down: the covered cache never re-serves it", async () => {
  const { host, svc, engine } = makeService();
  host.votes = [{ tag: "mri", support: 4, voters: 6 }];
  host.taxonomy = ["Physics/MRI"];
  engine.reply = "#Physics/MRI #mri";
  await computeTags(svc, file);
  svc.dismissTag(file.path, "mri");
  assert.deepEqual(svc.suggestedTags(file.path), ["Physics/MRI"]);
  assert.equal(engine.calls, 1); // dismissal is not recomputed back into existence
});

await test("no df logic in the reader: the composer drops the support-1 vote, the support-5 vote is offered", async () => {
  const { host, svc, engine } = makeService();
  host.votes = [
    { tag: "weak", support: 1, voters: 9 }, // dropped by the composer, not by a reader-side df filter
    { tag: "strong", support: 5, voters: 7 },
  ];
  engine.reply = "#strong #weak"; // the model may name anything; the closed set decides
  await computeTags(svc, file);
  assert.deepEqual(lastSaved(host)[file.path].cand, ["strong"]);
  assert.deepEqual(svc.suggestedTags(file.path), ["strong"]); // one filter, no double-filtering, no re-ordering
});

await test("offline guarantees: no engine, no ticking, no asset check, no network; writes land on the spy", async () => {
  const { host, svc, engine } = makeService();
  host.taxonomy = ["Physics/MRI"];
  engine.reply = "#Physics/MRI";
  await computeTags(svc, file);
  assert.equal(host.saved.length, 1); // queueSave's debounced write landed on the spy, never the fs
  assert.equal(host.saved[0].includes("Physics/MRI"), true);
  assert.equal(ticking, 0); // nothing armed the reader's tick
  assert.equal(fetchCalls, 0); // nothing touched the network
  assert.equal(svc.status.state, "ready"); // enable() never ran: no asset staging, no CDN check
  assert.equal(svc.status.detail, "");
  assert.strictEqual((svc as unknown as { engine: unknown }).engine, engine); // still the double: ReaderEngine was never constructed
});

g.window = originalWindow; // restore both globals: the shims exist only for the awaited tests above
g.fetch = originalFetch;
