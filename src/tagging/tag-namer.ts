// =============================================================================
// TAG NAMER — the optional external-model pass over a finished local taxonomy.
//
// nameTaxonomyWithModel asks one OpenAI-compatible chat/completions endpoint
// (hosted or local, no provider SDK) to rename each taxonomy node's own final
// segment, hard-validates the answer and returns the SAME hierarchy — same
// membership, order, levels and depth — under the renames. The model only ever
// answers "node id -> one segment"; full renamed paths are composed locally
// along the ORIGINAL parent chain, so an invented membership or a runaway path
// length is not representable. Any failure throws one descriptive Error and the
// caller keeps its taxonomy untouched: never a partial rename, never a mutated
// input. Local naming (order 0002's c-TF-IDF) stays the default — this is the opt-in.
//
// Pure apart from the one injected call: no fetch, no fs, no Obsidian, no clock,
// no randomness. The caller owns every byte on the wire — endpoint, model choice,
// key — and decides what note context (if any) is put into the prompt.
// =============================================================================

import type { TaxonomyNode, TaxonomyResult } from "./proposal";
// Value imports need the ".ts" specifier for Node's runtime (the test chain has
// no extension resolution); the expect-error pins the one tsc complaint.
// @ts-expect-error
import { joinSegments } from "./proposal.ts";

export interface TagNamingOptions {
  endpoint: string; // full chat/completions URL, e.g. https://api.openai.com/v1/chat/completions
  model: string;    // explicit model id, always caller-chosen
  apiKey?: string;  // optional bearer token; absent => no Authorization header
}

// The naming transport: the injected call that performs HTTP. The namer never
// touches network or fs, so the caller owns every byte on the wire end.
export type TagNamingRequest =
  (url: string, body: unknown, headers: Record<string, string>) => Promise<unknown>;

export const SAMPLES_PER_NODE = 3; // representative notes per node in the prompt
export const EXCERPT_CHARS = 400;  // each sample's body, truncated to this many characters
export const MAX_NODES = 60;       // nodes past this many are not sent; they keep their local segments

// The rules the model must answer inside: one JSON object, one segment per id.
const SYSTEM_PROMPT = [
  "You rename the final segment of concept-tag paths in a note vault's taxonomy.",
  "Answer with one JSON object and no prose: every node id you are given maps to that node's ONE new final tag segment.",
  'Example: {"n0":"NeuralNetworks","n1":"API"}. Each segment is a single PascalCase word of letters and digits, capital first letter, no slashes or spaces.',
  "Keep established acronyms all-caps (API, PDF). Never invent a node id and never rename a parent segment.",
].join(" ");

// An accepted final segment: PascalCase, all-caps acronyms included.
const SEGMENT = /^[A-Z][A-Za-z0-9]*$/;

// A bearer key shorter than this is not scrubbed out of a transport message: it is too
// short to be a real key and scrubbing a 1-char string would shred the diagnostic.
const KEY_SCRUB_MIN = 8;

type NoteContext = { title: string; text: string; path: string };
type Sample = { title: string; excerpt: string };

// The OpenAI-compatible response shape, read only as far as this module needs.
type ChatResponse = { choices?: { message?: { content?: unknown } }[] };

export async function nameTaxonomyWithModel(
  taxonomy: TaxonomyResult,
  context: { title: string; text: string; path: string }[],
  options: TagNamingOptions,
  request: TagNamingRequest,
): Promise<TaxonomyResult> {
  if (taxonomy.nodes.length === 0 || context.length === 0) return taxonomy; // nothing to name: no request, no change
  const byPath = new Map(context.map((c) => [c.path, c] as const)); // node membership is by path, so context is keyed by path
  const ids = taxonomy.nodes.slice(0, MAX_NODES).map((_, i) => `n${i}`); // the ids actually sent, over nodes order
  const payload = ids.map((id, i) => ({
    id,
    currentPath: joinSegments(taxonomy.nodes[i].segments),
    samples: samplesFor(taxonomy.nodes[i], byPath),
  }));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  try {
    const renames = asRenames(
      await request(options.endpoint, {
        model: options.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }, headers),
      ids,
    );
    return rename(taxonomy, ids, renames);
  } catch (err) {
    // One descriptive Error for every failure — transport, shape, parse or validation.
    // A transport message can echo the request, so every caller-supplied note string is
    // scrubbed at ANY length — a 5-char title is still note text. Only the key is
    // length-gated (a short key is worth no message noise) and empty strings are dropped
    // so split() cannot shred the message. Longest first: a short secret inside a longer
    // one must not leave a fragment behind. Validation messages quote no model value and
    // no note string, so they carry nothing of the vault anyway.
    const secrets = [
      options.apiKey !== undefined && options.apiKey.length >= KEY_SCRUB_MIN ? options.apiKey : "",
      ...context.flatMap((c) => [c.text, c.title, c.text.slice(0, EXCERPT_CHARS)]),
    ]
      .filter((secret) => secret !== "")
      .sort((a, b) => b.length - a.length);
    let message = err instanceof Error ? err.message : String(err);
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    throw new Error(`model naming failed: ${message}`);
  }
}

// A node's samples: its own notes the caller supplied context for, in note-path
// order, at most SAMPLES_PER_NODE of them; an untitled note falls back to its path basename.
function samplesFor(node: TaxonomyNode, byPath: Map<string, NoteContext>): Sample[] {
  const out: Sample[] = [];
  for (const path of node.notePaths) {
    const note = byPath.get(path);
    if (note === undefined) continue; // this module adds no vault content of its own
    out.push({ title: note.title || path.split("/").pop() || path, excerpt: note.text.slice(0, EXCERPT_CHARS) });
    if (out.length === SAMPLES_PER_NODE) break;
  }
  return out;
}

// The answer must be the JSON object of exactly the sent node ids. Messages name
// the rule and our own ids only — never a key or a value the model sent back.
function asRenames(response: unknown, ids: string[]): Record<string, unknown> {
  const content = (response as ChatResponse | null | undefined)?.choices?.[0]?.message?.content;
  if (content === undefined) throw new Error("the response has no choices[0].message.content");
  if (typeof content !== "string") throw new Error("the response content is not a string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("the response content is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the response is not a JSON object");
  const renames = parsed as Record<string, unknown>;
  const sent = new Set(ids);
  const extra = Object.keys(renames).filter((key) => !sent.has(key)); // an id that was never sent
  if (extra.length > 0) throw new Error(`the response names ${extra.length} node id(s) that were not sent`);
  for (const id of ids) {
    if (!(id in renames)) throw new Error(`the response is missing node id ${id}`);
  }
  return renames;
}

// The rename itself: every node in the same order with the same notePaths, its own
// segment swapped for the model's, the parent prefix composed from the ORIGINAL
// chain. Nodes are depth-first, so a parent is always in `own` before its children;
// a node that was never sent (past MAX_NODES) keeps its local segments.
function rename(taxonomy: TaxonomyResult, ids: string[], renames: Record<string, unknown>): TaxonomyResult {
  const own = new Map<string, string[]>();    // original joined path -> that node's new segments
  const ofNote = new Map<string, string[]>(); // note path -> its node's new segments
  const siblings = new Map<string, Set<string>>(); // parent path -> the new sibling segments, case-folded
  const nodes = taxonomy.nodes.map((node, i) => {
    const parent = node.segments.length > 1 ? joinSegments(node.segments.slice(0, -1)) : ""; // "" = the root
    let last = node.segments[node.segments.length - 1];
    if (i < ids.length) {
      const named = renames[ids[i]];
      if (typeof named !== "string" || !SEGMENT.test(named)) {
        throw new Error(`node ${ids[i]} came back with something other than one PascalCase segment`);
      }
      last = named;
    }
    const under = siblings.get(parent) ?? new Set<string>();
    if (under.has(last.toLowerCase())) throw new Error(`two siblings under "${parent || "the root"}" would share a name`); // the parent path is ours; the shared name is not quoted
    under.add(last.toLowerCase());
    siblings.set(parent, under);
    const segments = [...(own.get(parent) ?? []), last];
    own.set(joinSegments(node.segments), segments);
    for (const path of node.notePaths) ofNote.set(path, segments);
    return { level: node.level, segments, notePaths: [...node.notePaths] }; // copied: the caller's fallback must not alias
  });
  // Assignments are the model's nothing: recomputed from the UNCHANGED notePaths.
  const leafAssignment = new Map<string, string>();
  for (const [path, old] of taxonomy.leafAssignment) {
    const segments = ofNote.get(path);
    leafAssignment.set(path, segments === undefined ? old : joinSegments(segments)); // a path outside every node keeps its old tag path; the tree partition means there is none
  }
  return { nodes, leafAssignment };
}
